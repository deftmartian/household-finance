import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  ActualPrepareCategorizationUpdateRefusedError,
  type ActualDeterministicTransactionPort,
  type ActualImportedTransactionObservation,
  type ActualPrepareCategorizationUpdateResult,
} from '../actual-read/port.js';
import {
  parseImportedTransactionScanResult,
  parsePrepareCategorizationUpdateResult,
} from '../actual-read/protocol.js';
import {
  householdContextMutationSchema,
  type HouseholdContextMutation,
} from '../context/mutation.js';
import {
  householdProfileSchema,
  type HouseholdProfile,
} from '../context/profile.js';
import type {
  ActualUpdateInternalEnvelopePayloadV2,
  ActualUpdatePublicIntent,
  ActualUpdatePublicProposalV2,
} from '../storage/actual-update-store.js';
import {
  parseConversationalTransactionEditAction,
  type ConversationalTransactionEditAction,
} from './conversational-edit-action.js';
import type {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateWorkflow,
} from './workflow.js';

const sourceSchema = z.strictObject({
  idempotencyKey: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => value === value.trim() && !value.includes('\0')),
  contextEventId: z.uuid(),
  actorId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
  receivedAt: z.iso.datetime({ offset: true }),
});

const categoryKindEvidenceSchema = z
  .array(
    z.strictObject({
      categoryAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      kind: z.enum(['expense', 'income', 'savings', 'debt']),
    }),
  )
  .min(1)
  .max(20);

export type ConversationalCategoryKindEvidence = z.infer<
  typeof categoryKindEvidenceSchema
>;

export interface ConversationalTransactionEditSource {
  readonly idempotencyKey: string;
  readonly contextEventId: string;
  readonly actorId: string;
  readonly messageId: string;
  readonly message: string;
  readonly receivedAt: string;
}

export interface ConversationalTransactionEditAdapterOptions {
  readonly actual: Pick<
    ActualDeterministicTransactionPort,
    'scanImportedTransactions' | 'prepareCategorizationUpdate'
  >;
  readonly receiptReservationSource?: {
    isImportedTransactionReserved(
      accountAlias: string,
      importedId: string,
    ): boolean;
  };
  readonly workflow: Pick<ActualUpdateWorkflow, 'enqueue'>;
  readonly authenticator: ActualUpdateEnvelopeAuthenticator;
}

export interface ConversationalTransactionEditResult {
  readonly inserted: boolean;
  readonly intent: ActualUpdatePublicIntent;
  /**
   * The caller records this through HouseholdContextStore before completing
   * its route. A replay after the rule is already present returns undefined.
   */
  readonly recurringRuleMutation?: HouseholdContextMutation;
}

export type ConversationalTransactionEditErrorCode =
  | 'target-not-found'
  | 'target-ambiguous'
  | 'target-unsupported'
  | 'target-receipt-reserved'
  | 'target-changed'
  | 'category-kind-mismatch'
  | 'preparation-invalid'
  | 'recurring-rule-payee-missing'
  | 'recurring-rule-conflict'
  | 'recurring-rule-id-conflict';

export class ConversationalTransactionEditError extends Error {
  constructor(readonly code: ConversationalTransactionEditErrorCode) {
    super(`Conversational transaction edit stopped safely: ${code}`);
    this.name = 'ConversationalTransactionEditError';
  }
}

type ParsedSource = z.infer<typeof sourceSchema>;

function normalizedMerchant(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function canonicalInstant(value: string): string {
  return new Date(value).toISOString();
}

function normalizedAction(
  action: ConversationalTransactionEditAction,
): ConversationalTransactionEditAction {
  if (action.categorization.kind === 'single') {
    return structuredClone(action);
  }
  return {
    ...structuredClone(action),
    categorization: {
      kind: 'split',
      splits: [...action.categorization.splits].sort((left, right) =>
        left.categoryAlias.localeCompare(right.categoryAlias),
      ),
    },
  };
}

function sourceEventDigest(source: ParsedSource): string {
  return createHash('sha256')
    .update('household-finance.conversational-transaction-edit.v1\0', 'utf8')
    .update(source.contextEventId, 'utf8')
    .digest('hex');
}

function identity(source: ParsedSource): {
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly sourceId: string;
  readonly auditId: string;
} {
  const digest = sourceEventDigest(source);
  return {
    intentId: `talk-transaction-edit/${digest}`,
    idempotencyKey: `talk-transaction-edit/${digest}`,
    sourceId: `talk-transaction-edit/${digest}`,
    auditId: `talk-transaction-edit-audit/${digest}`,
  };
}

function selectorMatches(
  candidate: ActualImportedTransactionObservation,
  action: ConversationalTransactionEditAction,
): boolean {
  const selector = action.selector;
  return (
    candidate.date === selector.date &&
    candidate.amountMinorUnits === selector.amountMinorUnits &&
    (selector.accountAlias === null ||
      candidate.accountAlias === selector.accountAlias) &&
    (selector.payeeName === null
      ? candidate.payeeName === null
      : candidate.payeeName !== null &&
        normalizedMerchant(candidate.payeeName) ===
          normalizedMerchant(selector.payeeName))
  );
}

function assertSupportedTarget(
  target: ActualImportedTransactionObservation,
): void {
  if (
    !target.accountOnBudget ||
    (target.accountRole !== 'spending' &&
      target.accountRole !== 'credit-card' &&
      target.accountRole !== 'cashback-staging') ||
    target.split ||
    target.currentCategoryStatus === 'split' ||
    target.specialKind === 'transfer' ||
    target.specialKind === 'card-payment' ||
    target.specialKind === 'debt-payment'
  ) {
    throw new ConversationalTransactionEditError('target-unsupported');
  }
}

function categoryAliases(
  action: ConversationalTransactionEditAction,
): readonly string[] {
  return action.categorization.kind === 'single'
    ? [action.categorization.categoryAlias]
    : action.categorization.splits.map((split) => split.categoryAlias);
}

function assertCategoryKinds(
  action: ConversationalTransactionEditAction,
  target: ActualImportedTransactionObservation,
  untrustedEvidence: ConversationalCategoryKindEvidence,
): void {
  const evidence = categoryKindEvidenceSchema.parse(untrustedEvidence);
  const aliases = categoryAliases(action);
  const byAlias = new Map(
    evidence.map((category) => [category.categoryAlias, category.kind]),
  );
  const expectedKind = target.direction === 'income' ? 'income' : 'expense';
  if (
    byAlias.size !== evidence.length ||
    byAlias.size !== aliases.length ||
    aliases.some((alias) => byAlias.get(alias) !== expectedKind)
  ) {
    throw new ConversationalTransactionEditError('category-kind-mismatch');
  }
}

function resolvedCategories(
  prepared: ActualPrepareCategorizationUpdateResult,
  aliases: readonly string[],
): ReadonlyMap<string, string> {
  if (
    prepared.categories.length !== aliases.length ||
    prepared.categories.some((category) => !aliases.includes(category.alias))
  ) {
    throw new ConversationalTransactionEditError('preparation-invalid');
  }
  const categories = new Map(
    prepared.categories.map((category) => [
      category.alias,
      category.categoryId,
    ]),
  );
  if (categories.size !== aliases.length) {
    throw new ConversationalTransactionEditError('preparation-invalid');
  }
  return categories;
}

function recurringRuleId(payeeName: string): string {
  return `merchant-${createHash('sha256')
    .update('household-finance.merchant-rule.v1\0', 'utf8')
    .update(normalizedMerchant(payeeName), 'utf8')
    .digest('hex')}`;
}

function isActiveConfirmedRule(
  rule: HouseholdProfile['merchantRules'][number],
  at: string,
): boolean {
  return (
    rule.status === 'confirmed' &&
    (rule.validFrom === undefined || rule.validFrom <= at.slice(0, 10)) &&
    (rule.expiresAt === undefined || rule.expiresAt > at)
  );
}

export function createConversationalMerchantRuleMutation(input: {
  readonly payeeName: string;
  readonly categoryAlias: string;
  readonly source: ConversationalTransactionEditSource;
  readonly profile: HouseholdProfile;
}): HouseholdContextMutation | undefined {
  const source = sourceSchema.parse(input.source);
  const profile = householdProfileSchema.parse(input.profile);
  const payeeName = input.payeeName.normalize('NFC').trim();
  if (payeeName.length === 0 || payeeName.length > 240) {
    throw new ConversationalTransactionEditError(
      'recurring-rule-payee-missing',
    );
  }
  const categoryAlias = z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .parse(input.categoryAlias);
  const payeeKey = normalizedMerchant(payeeName);
  const matches = profile.merchantRules.filter(
    (rule) => normalizedMerchant(rule.merchantPattern) === payeeKey,
  );
  if (matches.length > 1) {
    throw new ConversationalTransactionEditError('recurring-rule-conflict');
  }
  const existing = matches[0];
  const receivedAt = canonicalInstant(source.receivedAt);
  if (
    existing !== undefined &&
    existing.categoryAlias === categoryAlias &&
    isActiveConfirmedRule(existing, receivedAt)
  ) {
    return undefined;
  }
  const id = existing?.id ?? recurringRuleId(payeeName);
  if (
    existing === undefined &&
    profile.merchantRules.some((rule) => rule.id === id)
  ) {
    throw new ConversationalTransactionEditError('recurring-rule-id-conflict');
  }
  const correctionCount =
    existing !== undefined && existing.categoryAlias !== categoryAlias
      ? existing.correctionCount + 1
      : (existing?.correctionCount ?? 0);
  if (!Number.isSafeInteger(correctionCount)) {
    throw new ConversationalTransactionEditError('recurring-rule-conflict');
  }
  return householdContextMutationSchema.parse({
    schemaVersion: 'household-context-mutation.v1',
    mutationId: source.contextEventId,
    expectedRevision: profile.revision,
    actorId: source.actorId,
    messageId: source.messageId,
    requestedAt: receivedAt,
    operation: {
      kind: 'upsert-merchant-rule',
      value: {
        id,
        merchantPattern: payeeName,
        categoryAlias,
        applicationCount: existing?.applicationCount ?? 0,
        correctionCount,
        status: 'confirmed',
        validFrom: receivedAt.slice(0, 10),
        provenance: {
          source: 'talk-explicit',
          actorId: source.actorId,
          messageId: source.messageId,
          recordedAt: receivedAt,
        },
      },
    },
  });
}

function recurringRuleMutation(input: {
  readonly action: ConversationalTransactionEditAction;
  readonly target: ActualImportedTransactionObservation;
  readonly source: ParsedSource;
  readonly profile: HouseholdProfile;
}): HouseholdContextMutation | undefined {
  if (!input.action.rememberForMerchant) {
    return undefined;
  }
  if (
    input.action.categorization.kind !== 'single' ||
    input.target.payeeName === null
  ) {
    throw new ConversationalTransactionEditError(
      'recurring-rule-payee-missing',
    );
  }
  return createConversationalMerchantRuleMutation({
    payeeName: input.target.payeeName,
    categoryAlias: input.action.categorization.categoryAlias,
    source: input.source,
    profile: input.profile,
  });
}

function publicCategorization(
  action: ConversationalTransactionEditAction,
): ActualUpdatePublicProposalV2['categorization'] {
  return action.categorization.kind === 'single'
    ? {
        kind: 'single',
        categoryAlias: action.categorization.categoryAlias,
      }
    : {
        kind: 'split',
        splits: action.categorization.splits.map((split) => ({ ...split })),
      };
}

function writerCategorization(
  action: ConversationalTransactionEditAction,
  categories: ReadonlyMap<string, string>,
):
  | {
      readonly kind: 'single';
      readonly categoryId: string;
    }
  | {
      readonly kind: 'split';
      readonly splits: readonly {
        readonly categoryId: string;
        readonly amountMinorUnits: number;
        readonly notes: string | null;
      }[];
    } {
  if (action.categorization.kind === 'single') {
    const categoryId = categories.get(action.categorization.categoryAlias);
    if (categoryId === undefined) {
      throw new ConversationalTransactionEditError('preparation-invalid');
    }
    return { kind: 'single', categoryId };
  }
  return {
    kind: 'split',
    splits: action.categorization.splits.map((split) => {
      const categoryId = categories.get(split.categoryAlias);
      if (categoryId === undefined) {
        throw new ConversationalTransactionEditError('preparation-invalid');
      }
      return {
        categoryId,
        amountMinorUnits: split.amountMinorUnits,
        notes: split.notes,
      };
    }),
  };
}

export class ConversationalTransactionEditAdapter {
  readonly #actual: ConversationalTransactionEditAdapterOptions['actual'];
  readonly #receiptReservations:
    | ConversationalTransactionEditAdapterOptions['receiptReservationSource']
    | undefined;
  readonly #workflow: ConversationalTransactionEditAdapterOptions['workflow'];
  readonly #authenticator: ActualUpdateEnvelopeAuthenticator;

  constructor(options: ConversationalTransactionEditAdapterOptions) {
    this.#actual = options.actual;
    this.#receiptReservations = options.receiptReservationSource;
    this.#workflow = options.workflow;
    this.#authenticator = options.authenticator;
  }

  async apply(input: {
    readonly action: ConversationalTransactionEditAction;
    readonly categoryKinds: ConversationalCategoryKindEvidence;
    readonly source: ConversationalTransactionEditSource;
    readonly profile: HouseholdProfile;
    readonly signal?: AbortSignal;
  }): Promise<ConversationalTransactionEditResult> {
    const action = normalizedAction(
      parseConversationalTransactionEditAction(input.action),
    );
    const source = sourceSchema.parse(input.source);
    const profile = householdProfileSchema.parse(input.profile);
    input.signal?.throwIfAborted();

    const scan = parseImportedTransactionScanResult(
      await this.#actual.scanImportedTransactions({
        startDate: action.selector.date,
        endDate: action.selector.date,
        previousWatermark: null,
      }),
    );
    input.signal?.throwIfAborted();
    const matches = scan.observations.filter((candidate) =>
      selectorMatches(candidate, action),
    );
    if (matches.length === 0) {
      throw new ConversationalTransactionEditError('target-not-found');
    }
    if (matches.length !== 1) {
      throw new ConversationalTransactionEditError('target-ambiguous');
    }
    const target = matches[0]!;
    assertSupportedTarget(target);
    assertCategoryKinds(action, target, input.categoryKinds);
    const ruleMutation = recurringRuleMutation({
      action,
      target,
      source,
      profile,
    });

    const aliases = categoryAliases(action);
    let prepared: ActualPrepareCategorizationUpdateResult;
    try {
      prepared = parsePrepareCategorizationUpdateResult(
        await this.#actual.prepareCategorizationUpdate({
          accountAlias: target.accountAlias,
          transactionId: target.transactionId,
          importedId: target.importedId,
          date: target.date,
          amountMinorUnits: target.amountMinorUnits,
          expectedObservationFingerprint: target.observationFingerprint,
          categoryAliases: aliases,
        }),
      );
    } catch (error) {
      if (error instanceof ActualPrepareCategorizationUpdateRefusedError) {
        throw new ConversationalTransactionEditError(
          error.code === 'target-unsupported'
            ? 'target-unsupported'
            : error.code === 'category-not-allowed'
              ? 'preparation-invalid'
              : 'target-changed',
        );
      }
      throw error;
    }
    input.signal?.throwIfAborted();
    if (
      prepared.observed.transactionId !== target.transactionId ||
      prepared.observed.importedId !== target.importedId ||
      prepared.observed.date !== target.date ||
      prepared.observed.amountMinorUnits !== target.amountMinorUnits
    ) {
      throw new ConversationalTransactionEditError('preparation-invalid');
    }
    if (
      this.#receiptReservations?.isImportedTransactionReserved(
        target.accountAlias,
        target.importedId,
      )
    ) {
      throw new ConversationalTransactionEditError('target-receipt-reserved');
    }
    const categories = resolvedCategories(prepared, aliases);
    const editIdentity = identity(source);
    const payload: ActualUpdateInternalEnvelopePayloadV2 = {
      schemaVersion: 'actual-update-internal-payload.v2',
      publicProposal: {
        schemaVersion: 'actual-update-public-proposal.v2',
        intentId: editIdentity.intentId,
        idempotencyKey: editIdentity.idempotencyKey,
        targetRef: this.#authenticator.createTargetRef({
          transactionId: target.transactionId,
          importedId: target.importedId,
        }),
        accountAlias: target.accountAlias,
        summary: {
          date: target.date,
          amountMinorUnits: target.amountMinorUnits,
          payeeName: target.payeeName,
        },
        payee: { kind: 'preserve' },
        notes: { kind: 'preserve' },
        categorization: publicCategorization(action),
        sourceId: editIdentity.sourceId,
        auditId: editIdentity.auditId,
        createdAt: canonicalInstant(source.receivedAt),
      },
      writerRequest: {
        idempotencyKey: editIdentity.idempotencyKey,
        observed: prepared.observed,
        edit: {
          payee: { kind: 'preserve' },
          notes: { kind: 'preserve' },
          categorization: writerCategorization(action, categories),
        },
      },
    };
    const enqueued = this.#workflow.enqueue(payload);
    if (
      JSON.stringify(enqueued.intent.proposal) !==
      JSON.stringify(payload.publicProposal)
    ) {
      throw new ConversationalTransactionEditError('preparation-invalid');
    }
    return {
      inserted: enqueued.inserted,
      intent: enqueued.intent,
      ...(ruleMutation === undefined
        ? {}
        : { recurringRuleMutation: ruleMutation }),
    };
  }
}
