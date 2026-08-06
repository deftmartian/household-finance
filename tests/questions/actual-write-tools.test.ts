import { describe, expect, it, vi } from 'vitest';

import {
  createConversationalMerchantRuleMutation,
  ConversationalTransactionEditError,
  type ConversationalTransactionEditSource,
} from '../../src/actual-update/conversational-edit-adapter.js';
import type { HouseholdContextMutation } from '../../src/context/mutation.js';
import { createEmptyHouseholdProfile } from '../../src/context/profile.js';
import { conversationalActualWriteTools } from '../../src/questions/actual-write-tools.js';
import type { FinanceQuestionActionContext } from '../../src/questions/xai-finance-agent.js';
import type { ActualUpdatePublicIntent } from '../../src/storage/actual-update-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const actionContext: FinanceQuestionActionContext = {
  idempotencyKey: 'context-route:question:one',
  eventId: '2ba92388-d8d8-4c34-9be8-15dfe0ed99b9',
  backendUrl: 'https://cloud.example.test',
  roomToken: 'household-finance',
  actorId: 'alex',
  messageId: '34084',
  message: 'Categorize the larger Traders payment as Home Insurance.',
  receivedAt: instant,
};

const taxonomy = {
  schemaVersion: 'household-category-taxonomy.v1' as const,
  currency: 'CAD' as const,
  categories: [
    {
      alias: 'home-insurance',
      name: 'Home Insurance',
      description: 'Insurance for the home.',
      kind: 'expense' as const,
      modelSelectable: true,
    },
    {
      alias: 'car-insurance',
      name: 'Car Insurance',
      description: 'Insurance for vehicles.',
      kind: 'expense' as const,
      modelSelectable: true,
    },
  ],
};

function intent(
  status: ActualUpdatePublicIntent['status'],
): ActualUpdatePublicIntent {
  return {
    proposal: {
      schemaVersion: 'actual-update-public-proposal.v2',
      intentId: 'talk-transaction-edit/one',
      idempotencyKey: 'talk-transaction-edit/one',
      targetRef: `actual-target/${'a'.repeat(64)}`,
      accountAlias: 'credit-card',
      summary: {
        date: '2026-07-14',
        amountMinorUnits: -48_966,
        payeeName: 'Traders Insurance',
      },
      payee: { kind: 'preserve' },
      notes: { kind: 'preserve' },
      categorization: {
        kind: 'single',
        categoryAlias: 'home-insurance',
      },
      sourceId: 'talk-transaction-edit/one',
      auditId: 'talk-transaction-edit-audit/one',
      createdAt: instant,
    },
    status,
    approval: null,
    applyAttemptCount: 0,
    undoAttemptCount: 0,
    lastErrorCode: null,
    applyOutcome: null,
    undoOutcome: null,
    updatedAt: instant,
  };
}

describe('conversational Actual write tool', () => {
  it('maps exact visible category names to aliases and queues one bound edit', async () => {
    const apply = vi.fn(async () => ({
      inserted: true,
      intent: intent('awaiting-approval'),
    }));
    const onIntentQueued = vi.fn(async () => intent('queued'));
    const [tool] = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: {
        read: async () => ({
          profile: createEmptyHouseholdProfile(instant),
        }),
      },
      actionContext,
      onIntentQueued,
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'single',
          categoryName: 'Home Insurance',
        },
      }),
    ).resolves.toEqual({
      status: 'queued',
      message:
        'The categorization is queued. A separate Talk message will appear only if it needs attention.',
    });

    expect(apply).toHaveBeenCalledWith({
      action: {
        schemaVersion: 'conversational-transaction-edit.v1',
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
          accountAlias: null,
        },
        categorization: {
          kind: 'single',
          categoryAlias: 'home-insurance',
        },
        rememberForMerchant: false,
      },
      categoryKinds: [
        {
          categoryAlias: 'home-insurance',
          kind: 'expense',
        },
      ],
      source: {
        idempotencyKey: expect.stringMatching(
          /^finance-question-write\/[0-9a-f]{64}$/u,
        ),
        contextEventId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        actorId: 'alex',
        messageId: '34084',
        message: actionContext.message,
        receivedAt: instant,
      },
      profile: createEmptyHouseholdProfile(instant),
    });
    expect(onIntentQueued).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({
          sourceId: 'talk-transaction-edit/one',
        }),
      }),
    );
    expect(tool!.didHandleTalkReply?.()).toBe(false);
  });

  it('does not require household context for a one-off categorization', async () => {
    const apply = vi.fn(async () => ({
      inserted: true,
      intent: intent('queued'),
    }));
    const onRecurringRuleMutation = vi.fn();
    const readProfile = vi.fn(async () => {
      throw new Error('profile enrichment is unavailable');
    });
    const [tool] = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: readProfile },
      actionContext,
      onRecurringRuleMutation,
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'single',
          categoryName: 'Home Insurance',
        },
      }),
    ).resolves.toMatchObject({ status: 'queued' });

    expect(readProfile).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({ rememberForMerchant: false }),
        profile: createEmptyHouseholdProfile(instant),
      }),
    );
    expect(onRecurringRuleMutation).not.toHaveBeenCalled();
  });

  it('lets the durable approval prompt own the reply for an explicit edit', async () => {
    const [tool] = conversationalActualWriteTools({
      adapter: {
        apply: async () => ({
          inserted: true,
          intent: intent('awaiting-approval'),
        }),
      },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
      onIntentQueued: async () => intent('awaiting-approval'),
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'single',
          categoryName: 'Home Insurance',
        },
      }),
    ).resolves.toMatchObject({ status: 'needs-approval' });
    expect(tool!.didHandleTalkReply?.()).toBe(true);
  });

  it('rejects an unbalanced visible split before calling the writer adapter', async () => {
    const apply = vi.fn();
    const [tool] = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'split',
          splits: [
            {
              categoryName: 'Home Insurance',
              amountMinorUnits: -30_000,
              notes: null,
            },
            {
              categoryName: 'Car Insurance',
              amountMinorUnits: -15_000,
              notes: null,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: 'not-applied' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('creates a merchant rule only when the current request explicitly asks for it', async () => {
    const apply = vi.fn(async () => ({
      inserted: true,
      intent: intent('queued'),
      recurringRuleMutation: {
        schemaVersion: 'household-context-mutation.v1' as const,
        mutationId: actionContext.eventId,
        expectedRevision: 0,
        actorId: actionContext.actorId,
        messageId: actionContext.messageId,
        requestedAt: actionContext.receivedAt,
        operation: {
          kind: 'upsert-merchant-rule' as const,
          value: {
            id: 'traders-insurance',
            merchantPattern: 'Traders Insurance',
            categoryAlias: 'home-insurance',
            applicationCount: 0,
            correctionCount: 0,
            status: 'confirmed' as const,
            provenance: {
              source: 'talk-explicit' as const,
              actorId: actionContext.actorId,
              messageId: actionContext.messageId,
              recordedAt: actionContext.receivedAt,
            },
          },
        },
      },
    }));
    const onRecurringRuleMutation = vi.fn(async () => undefined);
    const [tool] = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: {
        read: async () => ({
          profile: createEmptyHouseholdProfile(instant),
        }),
      },
      actionContext: {
        ...actionContext,
        message:
          'Categorize this as Home Insurance and always use that for Traders Insurance.',
      },
      onRecurringRuleMutation,
    });

    await tool!.execute({
      selector: {
        date: '2026-07-14',
        amountMinorUnits: -48_966,
        payeeName: 'Traders Insurance',
      },
      categorization: {
        kind: 'single',
        categoryName: 'Home Insurance',
      },
      rememberForMerchant: true,
    });

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          rememberForMerchant: true,
        }),
      }),
    );
    expect(onRecurringRuleMutation).toHaveBeenCalledWith(expect.any(Object), {
      enqueueResultReply: false,
    });
    expect(tool!.stateChanging).toBe(true);
    expect(tool!.didHandleTalkReply?.()).toBe(false);
  });

  it('saves an explicit standalone payee rule without editing a transaction', async () => {
    const apply = vi.fn();
    const onRecurringRuleMutation = vi.fn(async () => undefined);
    const tools = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: {
        read: async () => ({
          profile: createEmptyHouseholdProfile(instant),
        }),
      },
      actionContext: {
        ...actionContext,
        message: 'Always categorize Traders Insurance as Home Insurance.',
      },
      onRecurringRuleMutation,
    });
    const tool = tools.find(
      (candidate) => candidate.name === 'remember_merchant_category',
    );

    await expect(
      tool!.execute({
        payeeName: 'Traders Insurance',
        categoryName: 'Home Insurance',
      }),
    ).resolves.toEqual({
      status: 'saved',
      message: 'That merchant rule was saved.',
    });

    expect(apply).not.toHaveBeenCalled();
    expect(onRecurringRuleMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          kind: 'upsert-merchant-rule',
          value: expect.objectContaining({
            merchantPattern: 'Traders Insurance',
            categoryAlias: 'home-insurance',
            status: 'confirmed',
          }),
        },
      }),
      { enqueueResultReply: false },
    );
    expect(tool!.didHandleTalkReply?.()).toBe(false);
  });

  it('derives stable distinct identities for multiple transaction edits from one message', async () => {
    const sources: ConversationalTransactionEditSource[] = [];
    const apply = vi.fn(
      async (input: {
        readonly source: ConversationalTransactionEditSource;
      }) => {
        sources.push(input.source);
        return {
          inserted: true,
          intent: intent('queued'),
        };
      },
    );
    const [tool] = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
    });
    const first = {
      selector: {
        date: '2026-07-14',
        amountMinorUnits: -48_966,
        payeeName: 'Traders Insurance',
      },
      categorization: {
        kind: 'single' as const,
        categoryName: 'Home Insurance',
      },
    };
    const second = {
      selector: {
        date: '2026-07-14',
        amountMinorUnits: -15_416,
        payeeName: 'Traders Insurance',
      },
      categorization: {
        kind: 'single' as const,
        categoryName: 'Car Insurance',
      },
    };

    await tool!.execute(first);
    await tool!.execute(second);
    await tool!.execute(first);

    expect(sources[0]).toEqual(sources[2]);
    expect(sources[0]?.contextEventId).not.toBe(sources[1]?.contextEventId);
    expect(sources[0]?.idempotencyKey).not.toBe(sources[1]?.idempotencyKey);
    expect(sources[0]?.actorId).toBe(actionContext.actorId);
    expect(sources.every((source) => source.messageId === '34084')).toBe(true);
  });

  it('keeps one durable identity for a transaction target across agent retries', async () => {
    const sources: ConversationalTransactionEditSource[] = [];
    const adapter = {
      apply: vi.fn(
        async (input: {
          readonly source: ConversationalTransactionEditSource;
        }) => {
          sources.push(input.source);
          return {
            inserted: true,
            intent: intent('queued'),
          };
        },
      ),
    };
    const build = () =>
      conversationalActualWriteTools({
        adapter,
        taxonomySource: { read: async () => taxonomy },
        profileSource: { read: async () => undefined },
        actionContext,
      })[0]!;
    const selector = {
      date: '2026-07-14',
      amountMinorUnits: -48_966,
      payeeName: 'Traders Insurance',
    };

    await build().execute({
      selector,
      categorization: {
        kind: 'single',
        categoryName: 'Home Insurance',
      },
    });
    await build().execute({
      selector,
      categorization: {
        kind: 'single',
        categoryName: 'Car Insurance',
      },
    });

    expect(sources[0]?.contextEventId).toBe(sources[1]?.contextEventId);
    expect(sources[0]?.idempotencyKey).toBe(sources[1]?.idempotencyKey);
  });

  it('rejects two different changes for the same transaction in one run', async () => {
    const apply = vi.fn(async () => ({
      inserted: true,
      intent: intent('queued'),
    }));
    const [tool] = conversationalActualWriteTools({
      adapter: { apply },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
    });
    const selector = {
      date: '2026-07-14',
      amountMinorUnits: -48_966,
      payeeName: 'Traders Insurance',
    };

    await tool!.execute({
      selector,
      categorization: {
        kind: 'single',
        categoryName: 'Home Insurance',
      },
    });
    await expect(
      tool!.execute({
        selector,
        categorization: {
          kind: 'single',
          categoryName: 'Car Insurance',
        },
      }),
    ).resolves.toEqual({
      status: 'not-applied',
      message:
        'This message requested two different changes for the same transaction, so the second one was not queued.',
    });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('derives stable distinct mutation IDs for multiple merchant rules from one message', async () => {
    const mutations: HouseholdContextMutation[] = [];
    const replyOptions: { readonly enqueueResultReply: boolean }[] = [];
    const onRecurringRuleMutation = vi.fn(
      async (
        mutation: HouseholdContextMutation,
        options: { readonly enqueueResultReply: boolean },
      ) => {
        mutations.push(mutation);
        replyOptions.push(options);
      },
    );
    const tools = conversationalActualWriteTools({
      adapter: { apply: vi.fn() },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext: {
        ...actionContext,
        message:
          'Always use Home Insurance for Traders and Car Insurance for Proxi.',
      },
      onRecurringRuleMutation,
    });
    const tool = tools.find(
      (candidate) => candidate.name === 'remember_merchant_category',
    )!;
    const traders = {
      payeeName: 'Traders Insurance',
      categoryName: 'Home Insurance',
    };
    const proxi = {
      payeeName: 'Proxi West',
      categoryName: 'Car Insurance',
    };

    await tool.execute(traders);
    await tool.execute(proxi);
    await tool.execute(traders);

    expect(mutations[0]?.mutationId).toBe(mutations[2]?.mutationId);
    expect(mutations[0]?.mutationId).not.toBe(mutations[1]?.mutationId);
    expect(mutations[0]?.messageId).toBe(mutations[2]?.messageId);
    expect(mutations[0]?.messageId).toBe(mutations[1]?.messageId);
    expect(onRecurringRuleMutation).toHaveBeenCalledTimes(3);
    expect(replyOptions).toEqual([
      { enqueueResultReply: false },
      { enqueueResultReply: false },
      { enqueueResultReply: false },
    ]);
    expect(tool.didHandleTalkReply?.()).toBe(false);
  });

  it('keeps one durable identity for a merchant target across agent retries', async () => {
    const mutations: HouseholdContextMutation[] = [];
    const onRecurringRuleMutation = vi.fn(
      async (mutation: HouseholdContextMutation) => {
        mutations.push(mutation);
      },
    );
    const build = () =>
      conversationalActualWriteTools({
        adapter: { apply: vi.fn() },
        taxonomySource: { read: async () => taxonomy },
        profileSource: { read: async () => undefined },
        actionContext,
        onRecurringRuleMutation,
      }).find((candidate) => candidate.name === 'remember_merchant_category')!;

    await build().execute({
      payeeName: 'Proxi West',
      categoryName: 'Home Insurance',
    });
    await build().execute({
      payeeName: 'PROXI-WEST',
      categoryName: 'Car Insurance',
    });

    expect(mutations[0]?.mutationId).toBe(mutations[1]?.mutationId);
    expect(mutations[0]?.messageId).toBe(actionContext.messageId);
    expect(mutations[1]?.messageId).toBe(actionContext.messageId);
  });

  it('uses the same merchant identity whether a rule is bundled with an edit or saved alone', async () => {
    const mutations: HouseholdContextMutation[] = [];
    const onRecurringRuleMutation = vi.fn(
      async (mutation: HouseholdContextMutation) => {
        mutations.push(mutation);
      },
    );
    const profile = createEmptyHouseholdProfile(instant);
    const bundled = conversationalActualWriteTools({
      adapter: {
        apply: async (input) => {
          const recurringRuleMutation =
            createConversationalMerchantRuleMutation({
              payeeName: 'Proxi West',
              categoryAlias: 'car-insurance',
              source: input.source,
              profile,
            });
          if (recurringRuleMutation === undefined) {
            throw new Error('expected a new merchant rule');
          }
          return {
            inserted: true,
            intent: intent('queued'),
            recurringRuleMutation,
          };
        },
      },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => ({ profile }) },
      actionContext,
      onRecurringRuleMutation,
    })[0]!;
    await bundled.execute({
      selector: {
        date: '2026-07-14',
        amountMinorUnits: -15_416,
        payeeName: 'Proxi West',
      },
      categorization: {
        kind: 'single',
        categoryName: 'Car Insurance',
      },
      rememberForMerchant: true,
    });

    const standalone = conversationalActualWriteTools({
      adapter: { apply: vi.fn() },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => ({ profile }) },
      actionContext,
      onRecurringRuleMutation,
    }).find((candidate) => candidate.name === 'remember_merchant_category')!;
    await standalone.execute({
      payeeName: 'Proxi West',
      categoryName: 'Car Insurance',
    });

    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.mutationId).toBe(mutations[1]?.mutationId);
  });

  it('rejects two different rules for the same merchant in one run', async () => {
    const onRecurringRuleMutation = vi.fn(async () => undefined);
    const tool = conversationalActualWriteTools({
      adapter: { apply: vi.fn() },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
      onRecurringRuleMutation,
    }).find((candidate) => candidate.name === 'remember_merchant_category')!;

    await tool.execute({
      payeeName: 'Proxi West',
      categoryName: 'Home Insurance',
    });
    await expect(
      tool.execute({
        payeeName: 'PROXI-WEST',
        categoryName: 'Car Insurance',
      }),
    ).resolves.toEqual({
      status: 'not-saved',
      message:
        'This message requested two different categories for the same merchant, so the conflicting rule was not saved.',
    });
    expect(onRecurringRuleMutation).toHaveBeenCalledTimes(1);
  });

  it('lets Grok explain an ambiguous write instead of suppressing every reply', async () => {
    const [tool] = conversationalActualWriteTools({
      adapter: {
        apply: async () => ({
          inserted: false,
          intent: intent('ambiguous'),
        }),
      },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'single',
          categoryName: 'Home Insurance',
        },
      }),
    ).resolves.toMatchObject({ status: 'not-applied' });

    expect(tool!.didHandleTalkReply?.()).toBe(false);
  });

  it('turns an ambiguous deterministic selector into a calm clarification', async () => {
    const [tool] = conversationalActualWriteTools({
      adapter: {
        apply: async () => {
          throw new ConversationalTransactionEditError('target-ambiguous');
        },
      },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'single',
          categoryName: 'Home Insurance',
        },
      }),
    ).resolves.toEqual({
      status: 'needs-clarification',
      message:
        'More than one imported transaction matches those details, so I did not choose one.',
    });
  });

  it('plainly explains when receipt matching already owns the transaction', async () => {
    const [tool] = conversationalActualWriteTools({
      adapter: {
        apply: async () => {
          throw new ConversationalTransactionEditError(
            'target-receipt-reserved',
          );
        },
      },
      taxonomySource: { read: async () => taxonomy },
      profileSource: { read: async () => undefined },
      actionContext,
    });

    await expect(
      tool!.execute({
        selector: {
          date: '2026-07-14',
          amountMinorUnits: -48_966,
          payeeName: 'Traders Insurance',
        },
        categorization: {
          kind: 'single',
          categoryName: 'Home Insurance',
        },
      }),
    ).resolves.toEqual({
      status: 'not-applied',
      message:
        'That transaction is already being handled with a receipt, so I left it alone.',
    });
  });
});
