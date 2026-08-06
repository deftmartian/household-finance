import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ActualImportedTransactionScanResult,
  ActualPrepareCategorizationUpdateRequest,
  ActualPrepareCategorizationUpdateResult,
} from '../../src/actual-read/port.js';
import { captureActualTransactionObservation } from '../../src/actual-update/domain.js';
import type { ActualUpdateTransactionRecord } from '../../src/actual-update/port.js';
import { ActualUpdateEnvelopeAuthenticator } from '../../src/actual-update/workflow.js';
import {
  ActualReceiptMatchUpdateApplier,
  allocateReceiptSplitsToLedgerTotal,
  type ActualReceiptMatchUpdateError,
} from '../../src/categorization/receipt-actual-applier.js';
import type {
  ActualUpdateInternalEnvelopePayloadV2,
  ActualUpdatePublicIntent,
} from '../../src/storage/actual-update-store.js';
import type {
  ReadyReceiptCategorizationRecord,
  ReceiptCategorizationSource,
} from '../../src/storage/receipt-categorization-store.js';
import type { ReceiptImportedTransactionLink } from '../../src/storage/receipt-match-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const sourceFingerprint = 'c'.repeat(64);
const receiptSourceSha256 = 'a'.repeat(64);
const expectedReceiptLinkToken = `[[household-finance:receipt-link:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:${receiptSourceSha256}]]`;
const authenticationKey = 'test-only-receipt-update-authentication-key';
const freshness = {
  actualBudgetAsOf: instant,
  bankFeedAsOf: instant,
  lastAttemptAt: instant,
  lastSuccessfulSyncAt: instant,
  lastOutcome: 'succeeded' as const,
  isFresh: true,
  expectedBankDelayHours: 4,
};

const authenticators: ActualUpdateEnvelopeAuthenticator[] = [];

afterEach(() => {
  for (const authenticator of authenticators.splice(0)) {
    authenticator.destroy();
  }
});

function receipt(): ReadyReceiptCategorizationRecord {
  return {
    schemaVersion: 'ready-receipt-categorization.v1',
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idempotencyKey: `receipt-source-sha256:${receiptSourceSha256}`,
    sourceSha256: receiptSourceSha256,
    roomToken: 'production-room',
    messageId: '42',
    receivedAt: instant,
    record: {
      schemaVersion: 'household-finance.receipt.v1',
      receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
      createdAt: instant,
      updatedAt: instant,
      sources: [
        {
          nextcloudFileId: '42',
          archivePath: 'Receipts/example.jpg',
          sha256: sourceFingerprint,
          mediaType: 'image/jpeg',
          receivedAt: instant,
          talk: {
            roomToken: 'production-room',
            actorId: 'alex',
            messageId: '42',
          },
        },
      ],
      status: 'active',
      merchant: 'Example Market',
      purchaseDate: '2026-07-27',
      purchaseTime: null,
      timezoneOffset: null,
      currency: 'CAD',
      amounts: {
        subtotalMinor: 1_500,
        taxMinor: 225,
        discountMinor: 0,
        tipMinor: 0,
        totalMinor: 1_725,
      },
      paymentEvidence: {
        kind: 'unknown',
        lastFour: null,
      },
      receiptReference: null,
      items: [
        {
          description: 'Food',
          quantity: 1,
          unitPriceMinor: 1_000,
          totalMinor: 1_000,
        },
        {
          description: 'Paper',
          quantity: 1,
          unitPriceMinor: 500,
          totalMinor: 500,
        },
      ],
      extraction: {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        zeroDataRetention: true,
        extractedAt: instant,
        sourceSha256s: [sourceFingerprint],
      },
    },
    splits: [
      { categoryAlias: 'groceries', amountMinorUnits: 1_150 },
      { categoryAlias: 'everyday-shopping', amountMinorUnits: 575 },
    ],
    totalMinorUnits: 1_725,
    status: 'published',
  };
}

function source(
  ready: ReadyReceiptCategorizationRecord = receipt(),
): ReceiptCategorizationSource {
  return {
    schemaVersion: 'receipt-categorization-source.v1',
    eventId: ready.receiptId,
    sourceSha256: ready.sourceSha256,
    roomToken: ready.roomToken,
    messageId: ready.messageId,
    receivedAt: ready.receivedAt,
    record: structuredClone(ready.record),
  };
}

function link(): ReceiptImportedTransactionLink {
  return {
    receiptId: receipt().receiptId,
    transactionId: 'raw-transaction-1',
    importedId: 'raw-import-1',
    accountAlias: 'active-mastercard',
    linkedAt: instant,
  };
}

function scan(): ActualImportedTransactionScanResult {
  return {
    schemaVersion: 'actual-imported-transaction-scan.v1',
    startDate: '2026-07-26',
    endDate: '2026-08-03',
    observations: [
      {
        schemaVersion: 'actual-imported-transaction-observation.v1',
        transactionId: 'raw-transaction-1',
        importedId: 'raw-import-1',
        accountAlias: 'active-mastercard',
        accountRole: 'credit-card',
        accountOnBudget: true,
        accountLastFour: '4242',
        date: '2026-07-28',
        amountMinorUnits: -1_725,
        direction: 'expense',
        payeeName: 'Example Market',
        memo: null,
        currentCategoryAlias: null,
        currentCategoryName: null,
        currentCategoryStatus: 'uncategorized',
        split: false,
        cleared: true,
        specialKind: 'ordinary',
        alreadyLinkedReceipts: [],
        observationFingerprint: sourceFingerprint,
      },
    ],
    watermark: 'b'.repeat(64),
    importFreshnessToken: 'd'.repeat(64),
    unchanged: false,
    freshness,
  };
}

function rawTransaction(): ActualUpdateTransactionRecord {
  return {
    id: 'raw-transaction-1',
    account: 'raw-account-1',
    date: '2026-07-28',
    amount: -1_725,
    category: null,
    payee: 'raw-payee-1',
    notes: 'preserve',
    imported_id: 'raw-import-1',
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
  };
}

function prepared(): ActualPrepareCategorizationUpdateResult {
  return {
    schemaVersion: 'actual-categorization-update-preparation.v1',
    observed: captureActualTransactionObservation(rawTransaction()),
    categories: [
      { alias: 'groceries', categoryId: 'raw-groceries-id' },
      {
        alias: 'everyday-shopping',
        categoryId: 'raw-everyday-shopping-id',
      },
    ],
    freshness,
  };
}

function publicIntent(
  payload: ActualUpdateInternalEnvelopePayloadV2,
  status: ActualUpdatePublicIntent['status'],
): ActualUpdatePublicIntent {
  return {
    proposal: structuredClone(payload.publicProposal),
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

function harness(options?: {
  receipt?: ReadyReceiptCategorizationRecord | null;
  source?: ReceiptCategorizationSource | null;
  scan?: ActualImportedTransactionScanResult;
  prepared?: ActualPrepareCategorizationUpdateResult;
}) {
  const receiptRecord =
    options?.receipt === null ? undefined : (options?.receipt ?? receipt());
  const sourceRecord =
    options?.source === null
      ? undefined
      : (options?.source ?? source(receiptRecord ?? receipt()));
  const scanResult = options?.scan ?? scan();
  const preparedResult = options?.prepared ?? prepared();
  const authenticator = new ActualUpdateEnvelopeAuthenticator({
    activeKeyId: 'test-key',
    keys: { 'test-key': authenticationKey },
    targetReferenceKey: authenticationKey,
  });
  authenticators.push(authenticator);
  let existing: ActualUpdatePublicIntent | undefined;
  const intents = new Map<string, ActualUpdatePublicIntent>();
  const payloads: ActualUpdateInternalEnvelopePayloadV2[] = [];
  const scanImportedTransactions = vi.fn(async () => scanResult);
  const prepareCategorizationUpdate = vi.fn(
    async (request: ActualPrepareCategorizationUpdateRequest) => {
      void request;
      return preparedResult;
    },
  );
  const applier = new ActualReceiptMatchUpdateApplier({
    actual: { scanImportedTransactions, prepareCategorizationUpdate },
    receipts: {
      getSource: () => sourceRecord,
      getReadyReceipt: () => receiptRecord,
    },
    actualUpdateWorkflow: {
      enqueue(payload) {
        payloads.push(structuredClone(payload));
        existing = publicIntent(payload, 'awaiting-approval');
        intents.set(existing.proposal.intentId, existing);
        return { inserted: true, intent: existing };
      },
    },
    actualUpdateIntents: {
      getPublicIntent(intentId) {
        return intents.get(intentId);
      },
    },
    authenticator,
    now: () => new Date(instant),
  });
  return {
    applier,
    authenticator,
    payloads,
    scanImportedTransactions,
    prepareCategorizationUpdate,
    get existing() {
      return existing;
    },
    setExisting(value: ActualUpdatePublicIntent) {
      existing = value;
      intents.set(value.proposal.intentId, value);
    },
  };
}

describe('ActualReceiptMatchUpdateApplier', () => {
  it('reconciles proportional split remainders deterministically', () => {
    expect(
      allocateReceiptSplitsToLedgerTotal(
        [
          { categoryAlias: 'groceries', amountMinorUnits: 100 },
          { categoryAlias: 'everyday-shopping', amountMinorUnits: 100 },
          { categoryAlias: 'office', amountMinorUnits: 100 },
        ],
        300,
        100,
      ),
    ).toEqual([
      { categoryAlias: 'groceries', amountMinorUnits: 33 },
      { categoryAlias: 'everyday-shopping', amountMinorUnits: 34 },
      { categoryAlias: 'office', amountMinorUnits: 33 },
    ]);
  });

  it('reports a non-failing wait while receipt categorization is pending', async () => {
    const setup = harness({ receipt: null });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('categorization-pending');
    expect(setup.scanImportedTransactions).toHaveBeenCalledTimes(1);
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toEqual([]);
  });

  it('settles an existing current Actual link before categorization is ready', async () => {
    const baseScan = scan();
    const setup = harness({
      receipt: null,
      scan: {
        ...baseScan,
        observations: [
          {
            ...baseScan.observations[0]!,
            alreadyLinkedReceipts: [
              {
                receiptId: receipt().receiptId,
                sourceSha256: receipt().sourceSha256,
              },
            ],
            split: true,
            currentCategoryStatus: 'split',
          },
        ],
      },
    });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('applied');
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toEqual([]);
  });

  it('does not settle an existing link after the transaction amount changes', async () => {
    const baseScan = scan();
    const setup = harness({
      receipt: null,
      scan: {
        ...baseScan,
        observations: [
          {
            ...baseScan.observations[0]!,
            amountMinorUnits: -999,
            alreadyLinkedReceipts: [
              {
                receiptId: receipt().receiptId,
                sourceSha256: receipt().sourceSha256,
              },
            ],
          },
        ],
      },
    });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).rejects.toMatchObject({ code: 'target-changed' });
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toEqual([]);
  });

  it('builds one signed-workflow handoff with exact negative split arithmetic', async () => {
    const setup = harness();

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('pending');

    expect(setup.scanImportedTransactions).toHaveBeenCalledWith({
      startDate: '2026-07-27',
      endDate: '2026-08-03',
      previousWatermark: null,
    });
    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledWith({
      accountAlias: 'active-mastercard',
      transactionId: 'raw-transaction-1',
      importedId: 'raw-import-1',
      date: '2026-07-28',
      amountMinorUnits: -1_725,
      expectedObservationFingerprint: sourceFingerprint,
      categoryAliases: ['groceries', 'everyday-shopping'],
    });
    expect(setup.payloads).toHaveLength(1);
    expect(setup.payloads[0]).toMatchObject({
      publicProposal: {
        accountAlias: 'active-mastercard',
        summary: {
          date: '2026-07-27',
          amountMinorUnits: -1_725,
          payeeName: 'Example Market',
        },
        categorization: {
          kind: 'split',
          splits: [
            { categoryAlias: 'groceries', amountMinorUnits: -1_150 },
            {
              categoryAlias: 'everyday-shopping',
              amountMinorUnits: -575,
            },
          ],
        },
      },
      writerRequest: {
        edit: {
          payee: { kind: 'preserve' },
          notes: {
            kind: 'set',
            value: `preserve\n${expectedReceiptLinkToken}`,
          },
          categorization: {
            kind: 'split',
            splits: [
              {
                categoryId: 'raw-groceries-id',
                amountMinorUnits: -1_150,
              },
              {
                categoryId: 'raw-everyday-shopping-id',
                amountMinorUnits: -575,
              },
            ],
          },
        },
      },
    });
    const publicJson = JSON.stringify(setup.payloads[0]!.publicProposal);
    expect(publicJson).not.toContain('raw-transaction-1');
    expect(publicJson).not.toContain('raw-import-1');
    expect(publicJson).not.toContain('raw-groceries-id');
  });

  it('queues each exact charge for a single-category multi-charge receipt', async () => {
    const singleCategoryReceipt: ReadyReceiptCategorizationRecord = {
      ...receipt(),
      splits: [{ categoryAlias: 'groceries', amountMinorUnits: 1_725 }],
    };
    const firstLink = link();
    const secondLink: ReceiptImportedTransactionLink = {
      ...link(),
      transactionId: 'raw-transaction-2',
      importedId: 'raw-import-2',
    };
    const baseScan = scan();
    const setup = harness({
      receipt: singleCategoryReceipt,
      scan: {
        ...baseScan,
        observations: [
          {
            ...baseScan.observations[0]!,
            amountMinorUnits: -600,
          },
          {
            ...baseScan.observations[0]!,
            transactionId: secondLink.transactionId,
            importedId: secondLink.importedId,
            amountMinorUnits: -1_125,
            observationFingerprint: 'e'.repeat(64),
          },
        ],
      },
    });
    setup.prepareCategorizationUpdate.mockImplementation(async (request) => ({
      ...prepared(),
      observed: captureActualTransactionObservation({
        ...rawTransaction(),
        id: request.transactionId,
        imported_id: request.importedId,
        amount: request.amountMinorUnits,
      }),
      categories: [{ alias: 'groceries', categoryId: 'raw-groceries-id' }],
    }));

    await expect(
      setup.applier.applyReceiptMatch(singleCategoryReceipt.receiptId, [
        firstLink,
        secondLink,
      ]),
    ).resolves.toBe('pending');
    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledTimes(2);
    expect(setup.payloads).toHaveLength(2);
    for (const payload of setup.payloads) {
      expect(payload.writerRequest.edit.categorization).toEqual({
        kind: 'single',
        categoryId: 'raw-groceries-id',
      });
    }
  });

  it('enqueues nothing when a later charge in a multi-charge match is unsafe', async () => {
    const singleCategoryReceipt: ReadyReceiptCategorizationRecord = {
      ...receipt(),
      splits: [{ categoryAlias: 'groceries', amountMinorUnits: 1_725 }],
    };
    const firstLink = link();
    const secondLink: ReceiptImportedTransactionLink = {
      ...link(),
      transactionId: 'raw-transaction-2',
      importedId: 'raw-import-2',
    };
    const baseScan = scan();
    const setup = harness({
      receipt: singleCategoryReceipt,
      scan: {
        ...baseScan,
        observations: [
          {
            ...baseScan.observations[0]!,
            amountMinorUnits: -600,
          },
          {
            ...baseScan.observations[0]!,
            transactionId: secondLink.transactionId,
            importedId: secondLink.importedId,
            amountMinorUnits: -1_125,
            split: true,
            currentCategoryStatus: 'split',
            observationFingerprint: 'e'.repeat(64),
          },
        ],
      },
    });
    setup.prepareCategorizationUpdate.mockImplementation(async (request) => ({
      ...prepared(),
      observed: captureActualTransactionObservation({
        ...rawTransaction(),
        id: request.transactionId,
        imported_id: request.importedId,
        amount: request.amountMinorUnits,
      }),
      categories: [{ alias: 'groceries', categoryId: 'raw-groceries-id' }],
    }));

    await expect(
      setup.applier.applyReceiptMatch(singleCategoryReceipt.receiptId, [
        firstLink,
        secondLink,
      ]),
    ).rejects.toMatchObject({ code: 'target-changed' });
    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledTimes(1);
    expect(setup.payloads).toEqual([]);
  });

  it('asks for clarification instead of inventing a plural split allocation', async () => {
    const setup = harness();
    const secondLink: ReceiptImportedTransactionLink = {
      ...link(),
      transactionId: 'raw-transaction-2',
      importedId: 'raw-import-2',
    };

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [
        link(),
        secondLink,
      ]),
    ).resolves.toBe('needs-clarification');
    expect(setup.scanImportedTransactions).not.toHaveBeenCalled();
    expect(setup.payloads).toEqual([]);
  });

  it('rebuilds an already-tokened link as applied without a local intent', async () => {
    const baseScan = scan();
    const linkedScan: ActualImportedTransactionScanResult = {
      ...baseScan,
      observations: [
        {
          ...baseScan.observations[0]!,
          alreadyLinkedReceipts: [
            {
              receiptId: receipt().receiptId,
              sourceSha256: receipt().sourceSha256,
            },
          ],
          split: true,
          currentCategoryStatus: 'split',
        },
      ],
    };
    const setup = harness({ scan: linkedScan });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('applied');
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toEqual([]);
  });

  it('asks for review when Actual carries an older source revision', async () => {
    const baseScan = scan();
    const setup = harness({
      scan: {
        ...baseScan,
        observations: [
          {
            ...baseScan.observations[0]!,
            alreadyLinkedReceipts: [
              {
                receiptId: receipt().receiptId,
                sourceSha256: 'b'.repeat(64),
              },
            ],
            split: true,
            currentCategoryStatus: 'split',
          },
        ],
      },
    });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('needs-clarification');
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toEqual([]);
  });

  it('finishes only after a fresh Actual scan confirms the receipt token', async () => {
    const setup = harness();
    await setup.applier.applyReceiptMatch(receipt().receiptId, [link()]);

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('pending');
    expect(setup.scanImportedTransactions).toHaveBeenCalledTimes(2);
    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledTimes(2);

    setup.setExisting({
      ...setup.existing!,
      status: 'applied',
      applyOutcome: { status: 'updated', completedAt: instant },
    });
    setup.scanImportedTransactions.mockResolvedValue({
      ...scan(),
      observations: [
        {
          ...scan().observations[0]!,
          alreadyLinkedReceipts: [
            {
              receiptId: receipt().receiptId,
              sourceSha256: receipt().sourceSha256,
            },
          ],
          split: true,
          currentCategoryStatus: 'split',
        },
      ],
    });
    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).resolves.toBe('applied');
    expect(setup.scanImportedTransactions).toHaveBeenCalledTimes(3);
    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledTimes(2);
  });

  it('uses the posted CAD amount and proportionally converts a foreign receipt split', async () => {
    const foreignReceipt = receipt();
    foreignReceipt.record.currency = 'USD';
    const baseScan = scan();
    const cadScan: ActualImportedTransactionScanResult = {
      ...baseScan,
      observations: [
        {
          ...baseScan.observations[0]!,
          amountMinorUnits: -2_341,
        },
      ],
    };
    const basePrepared = prepared();
    const cadPrepared: ActualPrepareCategorizationUpdateResult = {
      ...basePrepared,
      observed: captureActualTransactionObservation({
        ...rawTransaction(),
        amount: -2_341,
      }),
    };
    const setup = harness({
      receipt: foreignReceipt,
      scan: cadScan,
      prepared: cadPrepared,
    });

    await expect(
      setup.applier.applyReceiptMatch(foreignReceipt.receiptId, [link()]),
    ).resolves.toBe('pending');

    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinorUnits: -2_341 }),
    );
    expect(setup.payloads[0]).toMatchObject({
      publicProposal: {
        summary: { amountMinorUnits: -2_341 },
        categorization: {
          kind: 'split',
          splits: [
            { categoryAlias: 'groceries', amountMinorUnits: -1_561 },
            {
              categoryAlias: 'everyday-shopping',
              amountMinorUnits: -780,
            },
          ],
        },
      },
      writerRequest: {
        edit: {
          categorization: {
            kind: 'split',
            splits: [
              { categoryId: 'raw-groceries-id', amountMinorUnits: -1_561 },
              {
                categoryId: 'raw-everyday-shopping-id',
                amountMinorUnits: -780,
              },
            ],
          },
        },
      },
    });

    await expect(
      setup.applier.applyReceiptMatch(foreignReceipt.receiptId, [link()]),
    ).resolves.toBe('pending');
    expect(setup.scanImportedTransactions).toHaveBeenCalledTimes(2);
    expect(setup.prepareCategorizationUpdate).toHaveBeenCalledTimes(2);
  });

  it('applies a single foreign receipt category directly to the posted CAD charge', async () => {
    const baseForeignReceipt = receipt();
    const foreignReceipt: ReadyReceiptCategorizationRecord = {
      ...baseForeignReceipt,
      splits: [{ categoryAlias: 'groceries', amountMinorUnits: 1_725 }],
    };
    foreignReceipt.record.currency = 'USD';
    const baseScan = scan();
    const cadScan: ActualImportedTransactionScanResult = {
      ...baseScan,
      observations: [
        { ...baseScan.observations[0]!, amountMinorUnits: -2_341 },
      ],
    };
    const basePrepared = prepared();
    const cadPrepared: ActualPrepareCategorizationUpdateResult = {
      ...basePrepared,
      observed: captureActualTransactionObservation({
        ...rawTransaction(),
        amount: -2_341,
      }),
      categories: [{ alias: 'groceries', categoryId: 'raw-groceries-id' }],
    };
    const setup = harness({
      receipt: foreignReceipt,
      scan: cadScan,
      prepared: cadPrepared,
    });

    await expect(
      setup.applier.applyReceiptMatch(foreignReceipt.receiptId, [link()]),
    ).resolves.toBe('pending');
    expect(setup.payloads[0]).toMatchObject({
      publicProposal: {
        summary: { amountMinorUnits: -2_341 },
        categorization: { kind: 'single', categoryAlias: 'groceries' },
      },
      writerRequest: {
        edit: {
          categorization: {
            kind: 'single',
            categoryId: 'raw-groceries-id',
          },
        },
      },
    });
  });

  it('fails closed when the uniquely linked transaction changed amount', async () => {
    const setup = harness();
    setup.scanImportedTransactions.mockResolvedValue({
      ...scan(),
      observations: [
        {
          ...scan().observations[0]!,
          amountMinorUnits: -1_700,
        },
      ],
    });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ActualReceiptMatchUpdateError>>({
        code: 'target-changed',
      }),
    );
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toHaveLength(0);
  });

  it('fails closed when a linked foreign charge becomes wildly implausible', async () => {
    const foreignReceipt = receipt();
    foreignReceipt.record.currency = 'USD';
    const setup = harness({ receipt: foreignReceipt });
    setup.scanImportedTransactions.mockResolvedValue({
      ...scan(),
      observations: [
        {
          ...scan().observations[0]!,
          amountMinorUnits: -20_000,
        },
      ],
    });

    await expect(
      setup.applier.applyReceiptMatch(foreignReceipt.receiptId, [link()]),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ActualReceiptMatchUpdateError>>({
        code: 'target-changed',
      }),
    );
    expect(setup.prepareCategorizationUpdate).not.toHaveBeenCalled();
    expect(setup.payloads).toHaveLength(0);
  });

  it('fails closed when an existing intent has different receipt review context', async () => {
    const setup = harness();
    await setup.applier.applyReceiptMatch(receipt().receiptId, [link()]);
    setup.setExisting({
      ...setup.existing!,
      proposal: {
        ...setup.existing!.proposal,
        summary: {
          ...setup.existing!.proposal.summary!,
          payeeName: 'Different Merchant',
        },
      },
    });

    await expect(
      setup.applier.applyReceiptMatch(receipt().receiptId, [link()]),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ActualReceiptMatchUpdateError>>({
        code: 'existing-intent-conflict',
      }),
    );
    expect(setup.scanImportedTransactions).toHaveBeenCalledTimes(2);
  });
});
