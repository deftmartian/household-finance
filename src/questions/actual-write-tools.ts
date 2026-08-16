import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  createConversationalMerchantRuleMutation,
  ConversationalTransactionEditError,
  type ConversationalTransactionEditAdapter,
  type ConversationalCategoryKindEvidence,
  type ConversationalTransactionEditSource,
} from '../actual-update/conversational-edit-adapter.js';
import type { ConversationalTransactionEditAction } from '../actual-update/conversational-edit-action.js';
import type { HouseholdContextMutation } from '../context/mutation.js';
import {
  categoryTaxonomySchema,
  type CategoryTaxonomy,
} from '../categorization/taxonomy.js';
import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from '../context/profile.js';
import {
  ActualUpdateStoreConflictError,
  type ActualUpdatePublicIntent,
} from '../storage/actual-update-store.js';
import type {
  FinanceQuestionActionContext,
  FinanceQuestionAdditionalTool,
} from './xai-finance-agent.js';

const normalizedName = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value === value.normalize('NFC').trim());
const normalizedNotes = z
  .string()
  .max(500)
  .refine((value) => value === value.normalize('NFC') && !value.includes('\0'));
const nonzeroMoney = z
  .number()
  .int()
  .safe()
  .refine((value) => value !== 0);

const visibleCategorization = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('single'),
    categoryName: normalizedName,
  }),
  z.strictObject({
    kind: z.literal('split'),
    splits: z
      .array(
        z.strictObject({
          categoryName: normalizedName,
          amountMinorUnits: nonzeroMoney,
          notes: normalizedNotes.nullable(),
        }),
      )
      .min(2)
      .max(20),
  }),
]);

const visibleTransactionEditSchema = z
  .strictObject({
    selector: z.strictObject({
      date: z.iso.date(),
      amountMinorUnits: nonzeroMoney,
      payeeName: normalizedName.nullable(),
    }),
    categorization: visibleCategorization,
    rememberForMerchant: z
      .boolean()
      .optional()
      .describe(
        'Set true only when the authenticated current message explicitly asks to remember this exact payee and category for future transactions.',
      ),
  })
  .superRefine((action, context) => {
    if (action.categorization.kind === 'single') {
      return;
    }
    if (action.rememberForMerchant === true) {
      context.addIssue({
        code: 'custom',
        path: ['rememberForMerchant'],
        message: 'Split categorizations cannot become merchant rules',
      });
    }
    const names = action.categorization.splits.map((split) =>
      split.categoryName.toLocaleLowerCase('en-CA'),
    );
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: 'custom',
        path: ['categorization', 'splits'],
        message: 'Split categories must be unique',
      });
    }
    const sign = Math.sign(action.selector.amountMinorUnits);
    let total = 0n;
    for (const [index, split] of action.categorization.splits.entries()) {
      if (Math.sign(split.amountMinorUnits) !== sign) {
        context.addIssue({
          code: 'custom',
          path: ['categorization', 'splits', index, 'amountMinorUnits'],
          message: 'Split amounts must have the transaction sign',
        });
      }
      total += BigInt(split.amountMinorUnits);
    }
    if (total !== BigInt(action.selector.amountMinorUnits)) {
      context.addIssue({
        code: 'custom',
        path: ['categorization', 'splits'],
        message: 'Split amounts must equal the transaction amount',
      });
    }
  });

const visibleTransactionEditJsonSchema = z.toJSONSchema(
  visibleTransactionEditSchema,
  {
    target: 'draft-2020-12',
    reused: 'inline',
  },
) as Readonly<Record<string, unknown>>;

const visibleMerchantRuleSchema = z.strictObject({
  payeeName: normalizedName,
  categoryName: normalizedName,
});

const visibleMerchantRuleJsonSchema = z.toJSONSchema(
  visibleMerchantRuleSchema,
  {
    target: 'draft-2020-12',
    reused: 'inline',
  },
) as Readonly<Record<string, unknown>>;

export interface ConversationalWriteTaxonomySource {
  read(signal?: AbortSignal): Promise<CategoryTaxonomy>;
}

export interface ConversationalWriteProfileSource {
  read(
    signal?: AbortSignal,
  ): Promise<{ readonly profile: HouseholdProfile } | undefined>;
}

export interface ConversationalActualWriteToolsOptions {
  readonly adapter: Pick<ConversationalTransactionEditAdapter, 'apply'>;
  readonly taxonomySource: ConversationalWriteTaxonomySource;
  readonly profileSource: ConversationalWriteProfileSource;
  readonly actionContext: FinanceQuestionActionContext;
  readonly timeZone?: string;
  readonly onIntentQueued?: (
    intent: ActualUpdatePublicIntent,
  ) => Promise<ActualUpdatePublicIntent | undefined>;
  readonly onRecurringRuleMutation?: (
    mutation: HouseholdContextMutation,
    options: { readonly enqueueResultReply: boolean },
  ) => Promise<void>;
}

function exactCategory(
  taxonomy: CategoryTaxonomy,
  categoryName: string,
): CategoryTaxonomy['categories'][number] | undefined {
  const key = categoryName.normalize('NFC').toLocaleLowerCase('en-CA');
  const matches = taxonomy.categories.filter(
    (category) =>
      category.modelSelectable &&
      category.name.toLocaleLowerCase('en-CA') === key,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function internalAction(
  value: z.infer<typeof visibleTransactionEditSchema>,
  taxonomy: CategoryTaxonomy,
):
  | {
      readonly action: ConversationalTransactionEditAction;
      readonly categoryKinds: ConversationalCategoryKindEvidence;
    }
  | undefined {
  if (value.categorization.kind === 'single') {
    const category = exactCategory(taxonomy, value.categorization.categoryName);
    return category === undefined
      ? undefined
      : {
          action: {
            schemaVersion: 'conversational-transaction-edit.v1',
            selector: {
              ...value.selector,
              accountAlias: null,
            },
            categorization: {
              kind: 'single',
              categoryAlias: category.alias,
            },
            rememberForMerchant: value.rememberForMerchant === true,
          },
          categoryKinds: [
            { categoryAlias: category.alias, kind: category.kind },
          ],
        };
  }
  const splits: Array<{
    categoryAlias: string;
    amountMinorUnits: number;
    notes: string | null;
  }> = [];
  const categoryKinds: Array<ConversationalCategoryKindEvidence[number]> = [];
  for (const split of value.categorization.splits) {
    const category = exactCategory(taxonomy, split.categoryName);
    if (category === undefined) {
      return undefined;
    }
    splits.push({
      categoryAlias: category.alias,
      amountMinorUnits: split.amountMinorUnits,
      notes: split.notes,
    });
    categoryKinds.push({
      categoryAlias: category.alias,
      kind: category.kind,
    });
  }
  return {
    action: {
      schemaVersion: 'conversational-transaction-edit.v1',
      selector: {
        ...value.selector,
        accountAlias: null,
      },
      categorization: {
        kind: 'split',
        splits,
      },
      rememberForMerchant: value.rememberForMerchant === true,
    },
    categoryKinds,
  };
}

function targetDigest(
  context: FinanceQuestionActionContext,
  target: string,
): string {
  return createHash('sha256')
    .update('household-finance.finance-question-write.v1\0', 'utf8')
    .update(context.eventId, 'utf8')
    .update('\0', 'utf8')
    .update(target, 'utf8')
    .digest('hex');
}

function operationUuid(digest: string): string {
  const variant = (
    (Number.parseInt(digest.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  const value = `${digest.slice(0, 12)}8${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function normalizedTransactionOperation(
  action: ConversationalTransactionEditAction,
): Readonly<Record<string, unknown>> {
  return {
    kind: 'categorize-transaction',
    selector: {
      date: action.selector.date,
      amountMinorUnits: action.selector.amountMinorUnits,
      payeeName: action.selector.payeeName,
      accountAlias: action.selector.accountAlias,
    },
    categorization:
      action.categorization.kind === 'single'
        ? {
            kind: 'single',
            categoryAlias: action.categorization.categoryAlias,
          }
        : {
            kind: 'split',
            splits: [...action.categorization.splits]
              .sort((left, right) =>
                left.categoryAlias.localeCompare(right.categoryAlias),
              )
              .map((split) => ({
                categoryAlias: split.categoryAlias,
                amountMinorUnits: split.amountMinorUnits,
                notes: split.notes,
              })),
          },
    rememberForMerchant: action.rememberForMerchant,
  };
}

function normalizedPayeeKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function transactionTargetKey(
  action: ConversationalTransactionEditAction,
): string {
  return JSON.stringify({
    date: action.selector.date,
    amountMinorUnits: action.selector.amountMinorUnits,
    payeeName:
      action.selector.payeeName === null
        ? null
        : normalizedPayeeKey(action.selector.payeeName),
    accountAlias: action.selector.accountAlias,
  });
}

function source(
  context: FinanceQuestionActionContext,
  target: string,
): ConversationalTransactionEditSource {
  const digest = targetDigest(context, target);
  return {
    idempotencyKey: `finance-question-write/${digest}`,
    contextEventId: operationUuid(digest),
    questionEventId: context.eventId,
    backendUrl: context.backendUrl,
    roomToken: context.roomToken,
    actorId: context.actorId,
    messageId: context.messageId,
    message: context.message,
    receivedAt: context.receivedAt,
  };
}

function transactionDurableTarget(targetKey: string): string {
  return `transaction:${targetKey}`;
}

function merchantRuleDurableTarget(payeeKey: string): string {
  return `merchant-rule:${payeeKey}`;
}

function publicStatus(intent: ActualUpdatePublicIntent): {
  readonly status: 'applied' | 'queued' | 'needs-approval' | 'not-applied';
  readonly message: string;
} {
  switch (intent.status) {
    case 'applied':
      return {
        status: 'applied',
        message: 'The categorization is confirmed in Actual.',
      };
    case 'awaiting-approval':
      return {
        status: 'needs-approval',
        message:
          'The categorization is ready for review. A separate Talk message will ask for approval.',
      };
    case 'queued':
    case 'claimed':
    case 'applying':
      return {
        status: 'queued',
        message:
          'The categorization is queued. A separate Talk message will appear only if it needs attention.',
      };
    case 'rejected':
    case 'ambiguous':
    case 'failed':
    case 'undo-queued':
    case 'undo-claimed':
    case 'undo-applying':
    case 'undone':
    case 'undo-ambiguous':
    case 'undo-failed':
      return {
        status: 'not-applied',
        message: 'The categorization was not applied.',
      };
  }
}

function friendlyFailure(error: unknown):
  | {
      readonly status: 'needs-clarification' | 'not-applied';
      readonly message: string;
    }
  | undefined {
  if (error instanceof ActualUpdateStoreConflictError) {
    return {
      status: 'not-applied',
      message:
        'That transaction already has a change in progress, so I left it alone.',
    };
  }
  if (!(error instanceof ConversationalTransactionEditError)) {
    return undefined;
  }
  switch (error.code) {
    case 'target-not-found':
      return {
        status: 'needs-clarification',
        message:
          'I could not find that exact imported transaction. Search again and use its exact date, signed amount, and payee.',
      };
    case 'target-ambiguous':
      return {
        status: 'needs-clarification',
        message:
          'More than one imported transaction matches those details, so I did not choose one.',
      };
    case 'target-unsupported':
      return {
        status: 'not-applied',
        message:
          'That transaction cannot be categorized through this action, so it was left unchanged.',
      };
    case 'target-receipt-reserved':
      return {
        status: 'not-applied',
        message:
          'That transaction is already being handled with a receipt, so I left it alone.',
      };
    case 'target-changed':
      return {
        status: 'needs-clarification',
        message:
          'That transaction changed after it was read. Search again before trying the change.',
      };
    case 'category-kind-mismatch':
      return {
        status: 'not-applied',
        message:
          'That category does not match this kind of transaction, so nothing was changed.',
      };
    case 'preparation-invalid':
    case 'recurring-rule-payee-missing':
    case 'recurring-rule-conflict':
    case 'recurring-rule-id-conflict':
      return {
        status: 'not-applied',
        message:
          'The requested category or split could not be applied, so the transaction was left unchanged.',
      };
  }
}

export function conversationalActualWriteTools(
  options: ConversationalActualWriteToolsOptions,
): readonly FinanceQuestionAdditionalTool[] {
  let categorizationCallCount = 0;
  let durableReplyCallCount = 0;
  const transactionRequests = new Map<string, string>();
  const merchantRuleRequests = new Map<string, string>();
  const tools: FinanceQuestionAdditionalTool[] = [
    {
      stateChanging: true,
      didHandleTalkReply: () =>
        categorizationCallCount > 0 &&
        categorizationCallCount === durableReplyCallCount,
      name: 'categorize_transaction',
      description:
        'Categorize exactly one existing imported ordinary transaction, either into one exact catalog category or a balanced split. Use only when the authenticated current message explicitly asks for this change. First call search_transactions and copy the exact date, signed amount in cents, payee, and exact category names. Set rememberForMerchant true only when that same message explicitly asks to remember the exact payee/category for future imports; never remember a split. Expenses and their split amounts are negative. This tool cannot change amounts, dates, accounts, payees, notes, budgets, schedules, transfers, or existing split transactions.',
      parameters: visibleTransactionEditJsonSchema,
      execute: async (untrusted, signal) => {
        categorizationCallCount += 1;
        const parsed = visibleTransactionEditSchema.safeParse(untrusted);
        if (!parsed.success) {
          return {
            status: 'not-applied',
            message:
              'The requested transaction selector or split was invalid, so nothing was changed.',
          };
        }
        const taxonomy = categoryTaxonomySchema.parse(
          await options.taxonomySource.read(signal),
        );
        const preparedAction = internalAction(parsed.data, taxonomy);
        if (preparedAction === undefined) {
          return {
            status: 'not-applied',
            message:
              'One of the requested category names was not an exact available category, so nothing was changed.',
          };
        }
        const normalizedOperation = normalizedTransactionOperation(
          preparedAction.action,
        );
        const targetKey = transactionTargetKey(preparedAction.action);
        const operationJson = JSON.stringify(normalizedOperation);
        const priorTransactionRequest = transactionRequests.get(targetKey);
        if (
          priorTransactionRequest !== undefined &&
          priorTransactionRequest !== operationJson
        ) {
          return {
            status: 'not-applied',
            message:
              'This message requested two different changes for the same transaction, so the second one was not queued.',
          };
        }
        const recurringCategory =
          preparedAction.action.rememberForMerchant &&
          preparedAction.action.selector.payeeName !== null &&
          preparedAction.action.categorization.kind === 'single'
            ? {
                payeeKey: normalizedPayeeKey(
                  preparedAction.action.selector.payeeName,
                ),
                categoryAlias:
                  preparedAction.action.categorization.categoryAlias,
              }
            : undefined;
        if (
          recurringCategory !== undefined &&
          merchantRuleRequests.has(recurringCategory.payeeKey) &&
          merchantRuleRequests.get(recurringCategory.payeeKey) !==
            recurringCategory.categoryAlias
        ) {
          return {
            status: 'not-applied',
            message:
              'This message requested two different categories for the same merchant, so the conflicting change was not queued.',
          };
        }
        const profile = preparedAction.action.rememberForMerchant
          ? ((await options.profileSource.read(signal))?.profile ??
            createEmptyHouseholdProfile(
              options.actionContext.receivedAt,
              options.timeZone ?? 'UTC',
            ))
          : createEmptyHouseholdProfile(
              options.actionContext.receivedAt,
              options.timeZone ?? 'UTC',
            );
        try {
          const result = await options.adapter.apply({
            action: preparedAction.action,
            categoryKinds: preparedAction.categoryKinds,
            source: source(
              options.actionContext,
              transactionDurableTarget(targetKey),
            ),
            profile,
            ...(signal === undefined ? {} : { signal }),
          });
          if (result.recurringRuleMutation !== undefined) {
            const rulePayeeKey =
              recurringCategory?.payeeKey ??
              (result.recurringRuleMutation.operation.kind ===
              'upsert-merchant-rule'
                ? normalizedPayeeKey(
                    result.recurringRuleMutation.operation.value
                      .merchantPattern,
                  )
                : undefined);
            const ruleMutation =
              rulePayeeKey === undefined
                ? result.recurringRuleMutation
                : {
                    ...result.recurringRuleMutation,
                    mutationId: source(
                      options.actionContext,
                      merchantRuleDurableTarget(rulePayeeKey),
                    ).contextEventId,
                  };
            await options.onRecurringRuleMutation?.(ruleMutation, {
              enqueueResultReply: false,
            });
          }
          const current =
            (await options.onIntentQueued?.(result.intent)) ?? result.intent;
          if (
            result.replyOwnedByDurableInteraction === true ||
            current.status === 'awaiting-approval' ||
            current.status === 'failed'
          ) {
            durableReplyCallCount += 1;
          }
          transactionRequests.set(targetKey, operationJson);
          if (recurringCategory !== undefined) {
            merchantRuleRequests.set(
              recurringCategory.payeeKey,
              recurringCategory.categoryAlias,
            );
          }
          return publicStatus(current);
        } catch (error) {
          const failure = friendlyFailure(error);
          if (failure !== undefined) {
            return failure;
          }
          throw error;
        }
      },
    },
  ];
  const onRecurringRuleMutation = options.onRecurringRuleMutation;
  if (onRecurringRuleMutation !== undefined) {
    tools.push({
      stateChanging: true,
      didHandleTalkReply: () => false,
      name: 'remember_merchant_category',
      description:
        'Remember one exact payee/category rule for future imported transactions without changing any existing transaction. Use only when the authenticated current message explicitly says to remember, always use, or set a rule for that exact payee. Copy the exact category name from read_actual catalog.',
      parameters: visibleMerchantRuleJsonSchema,
      execute: async (untrusted, signal) => {
        const parsed = visibleMerchantRuleSchema.safeParse(untrusted);
        if (!parsed.success) {
          return {
            status: 'not-saved',
            message:
              'That merchant rule was not clear enough to save, so nothing changed.',
          };
        }
        const taxonomy = categoryTaxonomySchema.parse(
          await options.taxonomySource.read(signal),
        );
        const category = exactCategory(taxonomy, parsed.data.categoryName);
        if (category === undefined) {
          return {
            status: 'not-saved',
            message:
              'That category was not an exact available category, so nothing changed.',
          };
        }
        const payeeKey = normalizedPayeeKey(parsed.data.payeeName);
        const priorCategory = merchantRuleRequests.get(payeeKey);
        if (priorCategory !== undefined && priorCategory !== category.alias) {
          return {
            status: 'not-saved',
            message:
              'This message requested two different categories for the same merchant, so the conflicting rule was not saved.',
          };
        }
        const profile =
          (await options.profileSource.read(signal))?.profile ??
          createEmptyHouseholdProfile(options.actionContext.receivedAt);
        const mutation = createConversationalMerchantRuleMutation({
          payeeName: parsed.data.payeeName,
          categoryAlias: category.alias,
          source: source(
            options.actionContext,
            merchantRuleDurableTarget(payeeKey),
          ),
          profile,
        });
        if (mutation === undefined) {
          merchantRuleRequests.set(payeeKey, category.alias);
          return {
            status: 'already-saved',
            message: 'That merchant rule is already active.',
          };
        }
        await onRecurringRuleMutation(mutation, {
          enqueueResultReply: false,
        });
        merchantRuleRequests.set(payeeKey, category.alias);
        return {
          status: 'saved',
          message: 'That merchant rule was saved.',
        };
      },
    });
  }
  return tools;
}
