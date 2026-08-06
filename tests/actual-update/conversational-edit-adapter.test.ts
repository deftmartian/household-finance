import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ActualDeterministicTransactionPort,
  ActualImportedTransactionObservation,
  ActualImportedTransactionScanResult,
  ActualPrepareCategorizationUpdateResult,
} from '../../src/actual-read/port.js';
import {
  ConversationalTransactionEditAdapter,
  type ConversationalTransactionEditSource,
} from '../../src/actual-update/conversational-edit-adapter.js';
import type { ConversationalTransactionEditError } from '../../src/actual-update/conversational-edit-adapter.js';
import type { ConversationalTransactionEditAction } from '../../src/actual-update/conversational-edit-action.js';
import { captureActualTransactionObservation } from '../../src/actual-update/domain.js';
import type { ActualUpdateTransactionRecord } from '../../src/actual-update/port.js';
import {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateWorkflow,
  type SafeActualUpdateWriter,
} from '../../src/actual-update/workflow.js';
import { createEmptyHouseholdProfile } from '../../src/context/profile.js';
import {
  ActualUpdateIntentStore,
  ActualUpdateStoreConflictError,
  type ActualUpdateInternalEnvelopePayloadV2,
} from '../../src/storage/actual-update-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const authenticationKey = 'test-only-actual-update-authentication-key-material';
const observationFingerprint = 'a'.repeat(64);

const freshness = {
  actualBudgetAsOf: instant,
  bankFeedAsOf: instant,
  lastAttemptAt: instant,
  lastSuccessfulSyncAt: instant,
  lastOutcome: 'succeeded' as const,
  isFresh: true,
  expectedBankDelayHours: 24,
};

const closeables: Array<{ close(): void }> = [];
const authenticators: ActualUpdateEnvelopeAuthenticator[] = [];

afterEach(() => {
  for (const closeable of closeables.splice(0)) {
    closeable.close();
  }
  for (const authenticator of authenticators.splice(0)) {
    authenticator.destroy();
  }
});

function observation(
  patch: Partial<ActualImportedTransactionObservation> = {},
): ActualImportedTransactionObservation {
  return {
    schemaVersion: 'actual-imported-transaction-observation.v1',
    transactionId: 'actual-transaction-secret',
    importedId: 'bank-import-secret',
    accountAlias: 'credit-card',
    accountRole: 'credit-card',
    accountOnBudget: true,
    accountLastFour: '4242',
    date: '2026-07-14',
    amountMinorUnits: -48_966,
    direction: 'expense',
    payeeName: 'Traders Insurance',
    memo: 'EFT Withdrawal to TRADERS MTL.',
    currentCategoryAlias: null,
    currentCategoryName: null,
    currentCategoryStatus: 'uncategorized',
    split: false,
    cleared: true,
    specialKind: 'ordinary',
    alreadyLinkedReceipts: [],
    observationFingerprint,
    ...patch,
  };
}

function scan(
  observations: readonly ActualImportedTransactionObservation[] = [
    observation(),
  ],
): ActualImportedTransactionScanResult {
  return {
    schemaVersion: 'actual-imported-transaction-scan.v1',
    startDate: '2026-07-14',
    endDate: '2026-07-14',
    observations,
    watermark: 'b'.repeat(64),
    importFreshnessToken: 'c'.repeat(64),
    unchanged: false,
    freshness,
  };
}

function rawTransaction(
  patch: Partial<ActualUpdateTransactionRecord> = {},
): ActualUpdateTransactionRecord {
  return {
    id: 'actual-transaction-secret',
    account: 'actual-account-secret',
    date: '2026-07-14',
    amount: -48_966,
    category: null,
    payee: 'actual-payee-secret',
    notes: null,
    imported_id: 'bank-import-secret',
    imported_payee: 'Traders Insurance',
    cleared: true,
    reconciled: false,
    transfer_id: null,
    starting_balance_flag: false,
    is_parent: false,
    is_child: false,
    parent_id: null,
    tombstone: false,
    error: null,
    subtransactions: [],
    ...patch,
  };
}

function prepared(
  aliases: readonly string[],
): ActualPrepareCategorizationUpdateResult {
  return {
    schemaVersion: 'actual-categorization-update-preparation.v1',
    observed: captureActualTransactionObservation(rawTransaction()),
    categories: [...aliases]
      .sort()
      .map((alias) => ({ alias, categoryId: `actual-category-${alias}` })),
    freshness,
  };
}

function source(): ConversationalTransactionEditSource {
  return {
    idempotencyKey: 'context-route-edit/one',
    contextEventId: randomUUID(),
    actorId: 'alex',
    messageId: '34084',
    message: 'The larger Traders payment is house insurance. Remember that.',
    receivedAt: instant,
  };
}

function action(
  patch: Partial<ConversationalTransactionEditAction> = {},
): ConversationalTransactionEditAction {
  return {
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
    ...patch,
  };
}

function expenseCategoryKinds(...categoryAliases: string[]) {
  return categoryAliases.map((categoryAlias) => ({
    categoryAlias,
    kind: 'expense' as const,
  }));
}

function harness(
  observations: readonly ActualImportedTransactionObservation[] = [
    observation(),
  ],
  receiptReservationSource?: {
    isImportedTransactionReserved(
      accountAlias: string,
      importedId: string,
    ): boolean;
  },
): {
  adapter: ConversationalTransactionEditAdapter;
  intentStore: ActualUpdateIntentStore;
  payloads: ActualUpdateInternalEnvelopePayloadV2[];
  prepare: ReturnType<
    typeof vi.fn<
      Pick<
        ActualDeterministicTransactionPort,
        'prepareCategorizationUpdate'
      >['prepareCategorizationUpdate']
    >
  >;
} {
  const authenticator = new ActualUpdateEnvelopeAuthenticator({
    activeKeyId: 'test-key',
    keys: { 'test-key': authenticationKey },
    targetReferenceKey: authenticationKey,
  });
  authenticators.push(authenticator);
  const intentStore = new ActualUpdateIntentStore(':memory:');
  closeables.push(intentStore);
  const writer: SafeActualUpdateWriter = {
    async update() {
      throw new Error('Conversational adapter must not bypass approval');
    },
    async undo() {
      throw new Error('Conversational adapter must not invoke undo');
    },
  };
  const workflow = new ActualUpdateWorkflow({
    store: intentStore,
    writer,
    authenticator,
    now: () => new Date(instant),
  });
  const payloads: ActualUpdateInternalEnvelopePayloadV2[] = [];
  const prepare = vi.fn(async (request) => prepared(request.categoryAliases));
  const actual: Pick<
    ActualDeterministicTransactionPort,
    'scanImportedTransactions' | 'prepareCategorizationUpdate'
  > = {
    async scanImportedTransactions() {
      return scan(observations);
    },
    prepareCategorizationUpdate: prepare,
  };
  const adapter = new ConversationalTransactionEditAdapter({
    actual,
    ...(receiptReservationSource === undefined
      ? {}
      : { receiptReservationSource }),
    workflow: {
      enqueue(payload) {
        payloads.push(structuredClone(payload));
        return workflow.enqueue(payload);
      },
    },
    authenticator,
  });
  return { adapter, intentStore, payloads, prepare };
}

describe('ConversationalTransactionEditAdapter', () => {
  it('enqueues one identifier-free public single-category intent idempotently', async () => {
    const { adapter, payloads } = harness();
    const requestSource = source();
    const profile = createEmptyHouseholdProfile(instant);

    const first = await adapter.apply({
      action: action(),
      categoryKinds: expenseCategoryKinds('home-insurance'),
      source: requestSource,
      profile,
    });
    const replay = await adapter.apply({
      action: action(),
      categoryKinds: expenseCategoryKinds('home-insurance'),
      source: requestSource,
      profile,
    });

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(first.intent.status).toBe('awaiting-approval');
    expect(first.intent.proposal.categorization).toEqual({
      kind: 'single',
      categoryAlias: 'home-insurance',
    });
    expect(payloads[0]?.writerRequest.edit.categorization).toEqual({
      kind: 'single',
      categoryId: 'actual-category-home-insurance',
    });
    expect(JSON.stringify(first.intent)).not.toMatch(
      /actual-transaction-secret|bank-import-secret|actual-account-secret|actual-category-home-insurance/u,
    );
    expect(payloads).toHaveLength(2);
  });

  it('refuses changed action content when the authenticated source event is replayed', async () => {
    const { adapter, intentStore } = harness();
    const requestSource = source();
    const profile = createEmptyHouseholdProfile(instant);

    const first = await adapter.apply({
      action: action(),
      categoryKinds: expenseCategoryKinds('home-insurance'),
      source: requestSource,
      profile,
    });

    await expect(
      adapter.apply({
        action: action({
          categorization: {
            kind: 'single',
            categoryAlias: 'car-insurance',
          },
        }),
        categoryKinds: expenseCategoryKinds('car-insurance'),
        source: requestSource,
        profile,
      }),
    ).rejects.toBeInstanceOf(ActualUpdateStoreConflictError);

    expect(intentStore.listPublicIntentsByStatus('awaiting-approval')).toEqual([
      first.intent,
    ]);
  });

  it('creates a balanced signed split without exposing child identities', async () => {
    const { adapter, payloads, prepare } = harness();
    const splitAction = action({
      categorization: {
        kind: 'split',
        splits: [
          {
            categoryAlias: 'car-insurance',
            amountMinorUnits: -15_416,
            notes: 'Vehicle portion',
          },
          {
            categoryAlias: 'home-insurance',
            amountMinorUnits: -33_550,
            notes: 'House portion',
          },
        ],
      },
    });

    const result = await adapter.apply({
      action: splitAction,
      categoryKinds: expenseCategoryKinds('car-insurance', 'home-insurance'),
      source: source(),
      profile: createEmptyHouseholdProfile(instant),
    });

    expect(result.intent.proposal.categorization).toEqual({
      kind: 'split',
      splits: [
        {
          categoryAlias: 'car-insurance',
          amountMinorUnits: -15_416,
          notes: 'Vehicle portion',
        },
        {
          categoryAlias: 'home-insurance',
          amountMinorUnits: -33_550,
          notes: 'House portion',
        },
      ],
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryAliases: ['car-insurance', 'home-insurance'],
      }),
    );
    const categorization = payloads[0]?.writerRequest.edit.categorization;
    expect(categorization?.kind).toBe('split');
    if (categorization?.kind !== 'split') {
      throw new Error('Expected a split writer request');
    }
    expect(
      categorization.splits.reduce(
        (total, split) => total + split.amountMinorUnits,
        0,
      ),
    ).toBe(-48_966);
  });

  it('refuses an income category for an expense before preparing a write', async () => {
    const { adapter, intentStore, prepare } = harness();

    await expect(
      adapter.apply({
        action: action(),
        categoryKinds: [
          {
            categoryAlias: 'home-insurance',
            kind: 'income',
          },
        ],
        source: source(),
        profile: createEmptyHouseholdProfile(instant),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationalTransactionEditError>>({
        code: 'category-kind-mismatch',
      }),
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(
      intentStore.listPublicIntentsByStatus('awaiting-approval'),
    ).toHaveLength(0);
  });

  it('returns a durable confirmed merchant-rule mutation with the edit', async () => {
    const { adapter } = harness();
    const requestSource = source();

    const result = await adapter.apply({
      action: action({ rememberForMerchant: true }),
      categoryKinds: expenseCategoryKinds('home-insurance'),
      source: requestSource,
      profile: createEmptyHouseholdProfile(instant),
    });

    expect(result.recurringRuleMutation).toMatchObject({
      schemaVersion: 'household-context-mutation.v1',
      mutationId: requestSource.contextEventId,
      expectedRevision: 0,
      actorId: 'alex',
      messageId: '34084',
      operation: {
        kind: 'upsert-merchant-rule',
        value: {
          merchantPattern: 'Traders Insurance',
          categoryAlias: 'home-insurance',
          applicationCount: 0,
          correctionCount: 0,
          status: 'confirmed',
          provenance: {
            source: 'talk-explicit',
            actorId: 'alex',
            messageId: '34084',
          },
        },
      },
    });
  });

  it('updates an existing exact merchant rule and records the correction', async () => {
    const { adapter } = harness();
    const profile = createEmptyHouseholdProfile(instant);
    profile.revision = 7;
    profile.merchantRules = [
      {
        id: 'traders-insurance',
        merchantPattern: 'TRADERS INSURANCE',
        categoryAlias: 'car-insurance',
        applicationCount: 3,
        correctionCount: 1,
        status: 'confirmed',
        provenance: {
          source: 'talk-explicit',
          actorId: 'alex',
          messageId: 'old-message',
          recordedAt: '2026-07-01T12:00:00.000Z',
        },
      },
    ];

    const result = await adapter.apply({
      action: action({ rememberForMerchant: true }),
      categoryKinds: expenseCategoryKinds('home-insurance'),
      source: source(),
      profile,
    });

    expect(result.recurringRuleMutation).toMatchObject({
      expectedRevision: 7,
      operation: {
        kind: 'upsert-merchant-rule',
        value: {
          id: 'traders-insurance',
          merchantPattern: 'Traders Insurance',
          categoryAlias: 'home-insurance',
          applicationCount: 3,
          correctionCount: 2,
          status: 'confirmed',
        },
      },
    });
  });

  it('refuses an ambiguous visible selector before preparing or enqueueing', async () => {
    const second = observation({
      transactionId: 'another-secret-transaction',
      importedId: 'another-secret-import',
      observationFingerprint: 'd'.repeat(64),
    });
    const { adapter, intentStore, prepare } = harness([observation(), second]);

    await expect(
      adapter.apply({
        action: action(),
        categoryKinds: expenseCategoryKinds('home-insurance'),
        source: source(),
        profile: createEmptyHouseholdProfile(instant),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationalTransactionEditError>>({
        code: 'target-ambiguous',
      }),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(
      intentStore.listPublicIntentsByStatus('awaiting-approval'),
    ).toHaveLength(0);
  });

  it('rechecks receipt ownership after preparation and refuses a reserved transaction', async () => {
    const isImportedTransactionReserved = vi.fn().mockReturnValue(true);
    const { adapter, intentStore, payloads, prepare } = harness(
      [observation()],
      { isImportedTransactionReserved },
    );

    await expect(
      adapter.apply({
        action: action(),
        categoryKinds: expenseCategoryKinds('home-insurance'),
        source: source(),
        profile: createEmptyHouseholdProfile(instant),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConversationalTransactionEditError>>({
        code: 'target-receipt-reserved',
      }),
    );

    expect(prepare).toHaveBeenCalledOnce();
    expect(isImportedTransactionReserved).toHaveBeenCalledWith(
      'credit-card',
      'bank-import-secret',
    );
    expect(payloads).toHaveLength(0);
    expect(
      intentStore.listPublicIntentsByStatus('awaiting-approval'),
    ).toHaveLength(0);
  });

  it('rejects an unbalanced split and a recurring split at the schema boundary', async () => {
    const { adapter, prepare } = harness();
    const profile = createEmptyHouseholdProfile(instant);
    const requestSource = source();

    await expect(
      adapter.apply({
        action: action({
          categorization: {
            kind: 'split',
            splits: [
              {
                categoryAlias: 'car-insurance',
                amountMinorUnits: -15_000,
                notes: null,
              },
              {
                categoryAlias: 'home-insurance',
                amountMinorUnits: -30_000,
                notes: null,
              },
            ],
          },
        }),
        categoryKinds: expenseCategoryKinds('car-insurance', 'home-insurance'),
        source: requestSource,
        profile,
      }),
    ).rejects.toBeDefined();
    await expect(
      adapter.apply({
        action: action({
          categorization: {
            kind: 'split',
            splits: [
              {
                categoryAlias: 'car-insurance',
                amountMinorUnits: -15_416,
                notes: null,
              },
              {
                categoryAlias: 'home-insurance',
                amountMinorUnits: -33_550,
                notes: null,
              },
            ],
          },
          rememberForMerchant: true,
        }),
        categoryKinds: expenseCategoryKinds('car-insurance', 'home-insurance'),
        source: requestSource,
        profile,
      }),
    ).rejects.toBeDefined();
    expect(prepare).not.toHaveBeenCalled();
  });
});
