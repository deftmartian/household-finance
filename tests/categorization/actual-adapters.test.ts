import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActualPrepareCategorizationUpdateRefusedError,
  type ActualDeterministicTransactionPort,
  type ActualImportedTransactionScanResult,
  type ActualPrepareCategorizationUpdateResult,
} from '../../src/actual-read/port.js';
import { captureActualTransactionObservation } from '../../src/actual-update/domain.js';
import type { ActualUpdateTransactionRecord } from '../../src/actual-update/port.js';
import {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateWorkflow,
  type SafeActualUpdateWriter,
} from '../../src/actual-update/workflow.js';
import {
  ActualTransactionCategorizationObservationSource,
  ActualTransactionCategoryUpdateAdapterError,
  ActualTransactionCategoryUpdateSink,
} from '../../src/categorization/actual-adapters.js';
import {
  ActualUpdateIntentStore,
  type ActualUpdateInternalEnvelopePayloadV2,
} from '../../src/storage/actual-update-store.js';
import {
  TransactionCategorizationStore,
  type TransactionCategoryUpdateRequest,
} from '../../src/storage/transaction-categorization-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const sourceFingerprint = 'c'.repeat(64);
const previousWatermark = 'a'.repeat(64);
const scanWatermark = 'b'.repeat(64);
const authenticationKey = 'test-only-actual-update-authentication-key-material';

const freshness = {
  actualBudgetAsOf: instant,
  bankFeedAsOf: instant,
  lastAttemptAt: instant,
  lastSuccessfulSyncAt: instant,
  lastOutcome: 'succeeded' as const,
  isFresh: true,
  expectedBankDelayHours: 4,
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

function importedScan(
  query: {
    startDate: string;
    endDate: string;
  },
  patch: Partial<ActualImportedTransactionScanResult> = {},
): ActualImportedTransactionScanResult {
  return {
    schemaVersion: 'actual-imported-transaction-scan.v1',
    startDate: query.startDate,
    endDate: query.endDate,
    observations: [
      {
        schemaVersion: 'actual-imported-transaction-observation.v1',
        transactionId: 'raw-actual-transaction-1',
        importedId: 'raw-bank-import-1',
        accountAlias: 'daily-chequing',
        accountRole: 'spending',
        accountOnBudget: true,
        accountLastFour: '4242',
        date: '2026-07-27',
        amountMinorUnits: 1_725,
        direction: 'refund',
        payeeName: 'Example Market',
        memo: 'returned household item',
        currentCategoryAlias: null,
        currentCategoryName: null,
        currentCategoryStatus: 'uncategorized',
        split: false,
        cleared: true,
        specialKind: 'refund',
        alreadyLinkedReceipts: [],
        observationFingerprint: sourceFingerprint,
      },
    ],
    watermark: scanWatermark,
    importFreshnessToken: 'e'.repeat(64),
    unchanged: false,
    freshness,
    ...patch,
  };
}

function rawTransaction(
  patch: Partial<ActualUpdateTransactionRecord> = {},
): ActualUpdateTransactionRecord {
  return {
    id: 'raw-actual-transaction-1',
    account: 'raw-actual-account-1',
    date: '2026-07-27',
    amount: -1_725,
    category: null,
    payee: 'raw-actual-payee-1',
    notes: 'preserve these notes',
    imported_id: 'raw-bank-import-1',
    imported_payee: 'Example Market',
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

function preparedUpdate(
  patch: Partial<ActualPrepareCategorizationUpdateResult> = {},
): ActualPrepareCategorizationUpdateResult {
  return {
    schemaVersion: 'actual-categorization-update-preparation.v1',
    observed: captureActualTransactionObservation(rawTransaction()),
    categories: [
      {
        alias: 'groceries',
        categoryId: 'raw-actual-category-groceries',
      },
    ],
    freshness,
    ...patch,
  };
}

function readyCategorization(): {
  store: TransactionCategorizationStore;
  request: TransactionCategoryUpdateRequest;
} {
  const store = new TransactionCategorizationStore(':memory:');
  closeables.push(store);
  store.recordScanPage({
    previousWatermark: null,
    watermark: scanWatermark,
    observations: [
      {
        schemaVersion: 'transaction-categorization-observer-record.v1',
        transactionId: 'raw-actual-transaction-1',
        importedId: 'raw-bank-import-1',
        actualObservationFingerprint: sourceFingerprint,
        accountOnBudget: true,
        currentCategoryStatus: 'uncategorized',
        split: false,
        observation: {
          schemaVersion: 'transaction-categorization-observation.v1',
          date: '2026-07-27',
          accountAlias: 'daily-chequing',
          amountMinorUnits: -1_725,
          direction: 'expense',
          payeeName: 'Example Market',
          memo: 'weekly groceries',
          specialKind: 'ordinary',
          currentCategoryAlias: null,
          originalRefundCategoryAlias: null,
        },
      },
    ],
    observedAt: instant,
  });
  const target = store.getByImportedId('raw-bank-import-1');
  const classify = store.claimNextJob(instant);
  store.recordReady(
    classify?.id ?? -1,
    target?.id ?? '',
    'groceries',
    'model',
    instant,
  );
  const apply = store.claimNextJob(instant);
  if (apply?.kind !== 'apply-transaction-category') {
    throw new Error('Synthetic category request was not queued');
  }
  return {
    store,
    request: apply.payload as TransactionCategoryUpdateRequest,
  };
}

function updateHarness(
  prepareImplementation: Pick<
    ActualDeterministicTransactionPort,
    'prepareCategorizationUpdate'
  >['prepareCategorizationUpdate'] = async () => preparedUpdate(),
): {
  intentStore: ActualUpdateIntentStore;
  workflow: ActualUpdateWorkflow;
  authenticator: ActualUpdateEnvelopeAuthenticator;
  enqueuedPayloads: ActualUpdateInternalEnvelopePayloadV2[];
  prepareCategorizationUpdate: ReturnType<
    typeof vi.fn<
      Pick<
        ActualDeterministicTransactionPort,
        'prepareCategorizationUpdate'
      >['prepareCategorizationUpdate']
    >
  >;
  workflowPort: Pick<ActualUpdateWorkflow, 'enqueue'>;
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
      throw new Error('The adapter must not bypass approval');
    },
    async undo() {
      throw new Error('The adapter must not invoke undo');
    },
  };
  const workflow = new ActualUpdateWorkflow({
    store: intentStore,
    writer,
    authenticator,
    now: () => new Date(instant),
  });
  const enqueuedPayloads: ActualUpdateInternalEnvelopePayloadV2[] = [];
  const workflowPort: Pick<ActualUpdateWorkflow, 'enqueue'> = {
    enqueue(payload) {
      enqueuedPayloads.push(structuredClone(payload));
      return workflow.enqueue(payload);
    },
  };
  const prepareCategorizationUpdate = vi.fn(prepareImplementation);
  return {
    intentStore,
    workflow,
    authenticator,
    enqueuedPayloads,
    prepareCategorizationUpdate,
    workflowPort,
  };
}

function sink(
  store: TransactionCategorizationStore,
  harness: ReturnType<typeof updateHarness>,
): ActualTransactionCategoryUpdateSink {
  return new ActualTransactionCategoryUpdateSink({
    actual: {
      prepareCategorizationUpdate: harness.prepareCategorizationUpdate,
    },
    categorizationStore: store,
    actualUpdateWorkflow: harness.workflowPort,
    actualUpdateIntents: harness.intentStore,
    authenticator: harness.authenticator,
  });
}

describe('Actual categorization observation adapter', () => {
  it('scans one bounded local-calendar window and keeps raw guards outside the model observation', async () => {
    const scanImportedTransactions = vi.fn<
      Pick<
        ActualDeterministicTransactionPort,
        'scanImportedTransactions'
      >['scanImportedTransactions']
    >(async (query) => importedScan(query));
    const source = new ActualTransactionCategorizationObservationSource({
      actual: { scanImportedTransactions },
      rollingWindowDays: 3,
      timeZone: 'America/Halifax',
      // 2026-07-29 UTC is still July 28 in Halifax.
      now: () => new Date('2026-07-29T02:30:00.000Z'),
    });

    const page = await source.scan(previousWatermark);

    expect(scanImportedTransactions).toHaveBeenCalledWith({
      startDate: '2026-07-26',
      endDate: '2026-07-28',
      previousWatermark,
    });
    expect(page).toMatchObject({
      watermark: scanWatermark,
      unchanged: false,
      observations: [
        {
          transactionId: 'raw-actual-transaction-1',
          importedId: 'raw-bank-import-1',
          actualObservationFingerprint: sourceFingerprint,
          observation: {
            direction: 'refund',
            specialKind: 'ordinary',
            originalRefundCategoryAlias: null,
          },
        },
      ],
    });
    const modelObservation = JSON.stringify(page.observations[0]?.observation);
    expect(modelObservation).not.toContain('raw-actual-transaction-1');
    expect(modelObservation).not.toContain('raw-bank-import-1');
    expect(modelObservation).not.toContain(sourceFingerprint);
    expect(modelObservation).not.toContain('4242');
  });

  it('omits an imported transaction already reserved by a receipt', async () => {
    const scanImportedTransactions = vi.fn<
      Pick<
        ActualDeterministicTransactionPort,
        'scanImportedTransactions'
      >['scanImportedTransactions']
    >(async (query) => importedScan(query));
    const isImportedTransactionReserved = vi.fn().mockReturnValue(true);
    const source = new ActualTransactionCategorizationObservationSource({
      actual: { scanImportedTransactions },
      rollingWindowDays: 3,
      timeZone: 'America/Halifax',
      receiptReservationSource: { isImportedTransactionReserved },
      now: () => new Date('2026-07-29T02:30:00.000Z'),
    });

    await expect(source.scan(previousWatermark)).resolves.toMatchObject({
      observations: [],
    });
    expect(isImportedTransactionReserved).toHaveBeenCalledWith(
      'daily-chequing',
      'raw-bank-import-1',
    );
  });
});

describe('Actual transaction category update sink', () => {
  it('creates one idempotent, approval-gated handoff with an alias-only public intent', async () => {
    const categorization = readyCategorization();
    const harness = updateHarness();
    const adapter = sink(categorization.store, harness);

    await expect(adapter.reconcile(categorization.request)).resolves.toBe(
      'needs-apply',
    );
    expect(harness.prepareCategorizationUpdate).toHaveBeenCalledWith({
      accountAlias: 'daily-chequing',
      transactionId: 'raw-actual-transaction-1',
      importedId: 'raw-bank-import-1',
      date: '2026-07-27',
      amountMinorUnits: -1_725,
      expectedObservationFingerprint: sourceFingerprint,
      categoryAliases: ['groceries'],
    });

    await adapter.apply(categorization.request);
    expect(harness.enqueuedPayloads).toHaveLength(1);
    const payload = harness.enqueuedPayloads[0];
    expect(payload).toMatchObject({
      publicProposal: {
        targetRef: expect.stringMatching(/^actual-target\/[a-f0-9]{64}$/),
        accountAlias: 'daily-chequing',
        summary: {
          date: '2026-07-27',
          amountMinorUnits: -1_725,
          payeeName: 'Example Market',
        },
        payee: { kind: 'preserve' },
        notes: { kind: 'preserve' },
        categorization: {
          kind: 'single',
          categoryAlias: 'groceries',
        },
      },
      writerRequest: {
        observed: {
          transactionId: 'raw-actual-transaction-1',
          importedId: 'raw-bank-import-1',
        },
        edit: {
          payee: { kind: 'preserve' },
          notes: { kind: 'preserve' },
          categorization: {
            kind: 'single',
            categoryId: 'raw-actual-category-groceries',
          },
        },
      },
    });
    const publicIntent = harness.intentStore.getPublicIntent(
      payload?.publicProposal.intentId ?? '',
    );
    expect(publicIntent).toMatchObject({
      status: 'awaiting-approval',
      proposal: {
        categorization: { categoryAlias: 'groceries' },
      },
    });
    const publicJson = JSON.stringify(publicIntent);
    for (const internalValue of [
      'raw-actual-transaction-1',
      'raw-bank-import-1',
      'raw-actual-account-1',
      'raw-actual-category-groceries',
      sourceFingerprint,
    ]) {
      expect(publicJson).not.toContain(internalValue);
    }

    await expect(adapter.reconcile(categorization.request)).resolves.toBe(
      'already-applied',
    );
    await adapter.apply(categorization.request);
    expect(harness.enqueuedPayloads).toHaveLength(1);
    expect(harness.prepareCategorizationUpdate).toHaveBeenCalledTimes(1);
  });

  it('treats an existing intent with different review context as a conflict', async () => {
    const categorization = readyCategorization();
    const harness = updateHarness();
    const adapter = sink(categorization.store, harness);
    await adapter.reconcile(categorization.request);
    await adapter.apply(categorization.request);
    const payload = harness.enqueuedPayloads[0];
    if (payload === undefined) {
      throw new Error('Synthetic update intent was not captured');
    }
    const intent = harness.intentStore.getPublicIntent(
      payload.publicProposal.intentId,
    );
    if (intent === undefined) {
      throw new Error('Synthetic public intent was not created');
    }
    Object.assign(intent.proposal, {
      summary: {
        ...intent.proposal.summary!,
        amountMinorUnits: -9_999,
      },
    });
    const publicIntentSource = {
      getPublicIntent() {
        return intent;
      },
    };
    const conflicting = new ActualTransactionCategoryUpdateSink({
      actual: {
        prepareCategorizationUpdate: harness.prepareCategorizationUpdate,
      },
      categorizationStore: categorization.store,
      actualUpdateWorkflow: harness.workflowPort,
      actualUpdateIntents: publicIntentSource,
      authenticator: harness.authenticator,
    });

    await expect(conflicting.reconcile(categorization.request)).resolves.toBe(
      'conflict',
    );
  });

  it('maps a reader drift refusal to a conflict without creating an update intent', async () => {
    const categorization = readyCategorization();
    const harness = updateHarness(async () => {
      throw new ActualPrepareCategorizationUpdateRefusedError('target-changed');
    });
    const adapter = sink(categorization.store, harness);

    await expect(adapter.reconcile(categorization.request)).resolves.toBe(
      'conflict',
    );
    expect(harness.enqueuedPayloads).toEqual([]);
  });

  it('rejects a mismatched reader guard before calling the Actual preparation plane', async () => {
    const categorization = readyCategorization();
    const harness = updateHarness();
    const adapter = sink(categorization.store, harness);

    await expect(
      adapter.reconcile({
        ...categorization.request,
        observationFingerprint: 'f'.repeat(64),
      }),
    ).resolves.toBe('conflict');
    expect(harness.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(harness.enqueuedPayloads).toEqual([]);
  });

  it('fails closed when the prepared alias does not match the requested category', async () => {
    const categorization = readyCategorization();
    const harness = updateHarness(async () =>
      preparedUpdate({
        categories: [
          {
            alias: 'dining',
            categoryId: 'raw-actual-category-dining',
          },
        ],
      }),
    );
    const adapter = sink(categorization.store, harness);

    await expect(
      adapter.reconcile(categorization.request),
    ).rejects.toMatchObject({
      name: ActualTransactionCategoryUpdateAdapterError.name,
      code: 'preparation-invalid',
    });
    expect(harness.enqueuedPayloads).toEqual([]);
  });

  it('treats a rejected durable Actual intent as a conflict rather than silently re-enqueueing it', async () => {
    const categorization = readyCategorization();
    const harness = updateHarness();
    const adapter = sink(categorization.store, harness);
    await adapter.reconcile(categorization.request);
    await adapter.apply(categorization.request);
    const payload = harness.enqueuedPayloads[0];
    if (payload === undefined) {
      throw new Error('Synthetic update intent was not captured');
    }
    harness.workflow.reject({
      intentId: payload.publicProposal.intentId,
      decisionId: 'rejection-1',
      actorId: 'alex',
      reasonCode: 'user-rejected',
      rejectedAt: instant,
    });

    await expect(adapter.reconcile(categorization.request)).resolves.toBe(
      'conflict',
    );
    await expect(adapter.apply(categorization.request)).rejects.toMatchObject({
      name: ActualTransactionCategoryUpdateAdapterError.name,
      code: 'existing-intent-conflict',
    });
    expect(harness.enqueuedPayloads).toHaveLength(1);
  });
});
