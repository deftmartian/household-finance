import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ActualApiReadConfigurationError,
  ActualApiReadPort,
  type ActualReadApiAqlQuery,
  type ActualReadApiAccount,
  type ActualReadApiBudget,
  type ActualReadApiBudgetMonth,
  type ActualReadApiCategoryGroup,
  type ActualReadApiFacade,
  type ActualReadApiInitConfig,
  type ActualReadApiPayee,
  type ActualReadApiSchedule,
  type ActualReadApiTransaction,
} from '../../src/actual-read/actual-api-reader.js';
import {
  initialActualReadFreshness,
  type ActualReadFreshnessStore,
  type PersistedActualReadFreshness,
} from '../../src/actual-read/freshness-store.js';
import { actualReceiptLinkToken } from '../../src/actual-read/receipt-link-token.js';
import {
  ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
  ACTUAL_READ_CONTRACT_SCOPE,
  actualReadContractFingerprint,
  parseActualReadContract,
  type ActualReadContract,
  type ActualReadContractIdentity,
} from '../../src/actual-read/read-contract.js';
import {
  captureActualTransactionObservation,
  type ActualTransactionObservationV1,
} from '../../src/actual-update/domain.js';
import type { ActualUpdateTransactionRecord } from '../../src/actual-update/port.js';
import type { ActualPrepareCategorizationUpdateRefusedError } from '../../src/actual-read/port.js';
import {
  ACTUAL_RECEIPT_NOTE_PREFIX,
  canonicalHouseholdFinanceReceiptJson,
} from '../../src/receipt-record/domain.js';
import { matchReceiptToImportedTransactions } from '../../src/matching/receipt-transaction.js';

const linkedReceiptId = '8dfc1bd9-e07a-4c62-9d58-9529361536b9';
const linkedReceiptSourceSha256 = 'a'.repeat(64);
const linkedReceipt = {
  receiptId: linkedReceiptId,
  sourceSha256: linkedReceiptSourceSha256,
};

class MemoryFreshnessStore implements ActualReadFreshnessStore {
  state: PersistedActualReadFreshness;
  readonly saves: PersistedActualReadFreshness[] = [];

  constructor(state = initialActualReadFreshness()) {
    this.state = structuredClone(state);
  }

  async load(): Promise<PersistedActualReadFreshness> {
    return structuredClone(this.state);
  }

  async save(state: PersistedActualReadFreshness): Promise<void> {
    this.state = structuredClone(state);
    this.saves.push(structuredClone(state));
  }
}

class SyntheticAqlQuery implements ActualReadApiAqlQuery {
  fields: readonly string[] = [];

  constructor(readonly table: string) {}

  select(fields: readonly string[] = []): ActualReadApiAqlQuery {
    this.fields = fields;
    return this;
  }
}

class SyntheticActualReadApi implements ActualReadApiFacade {
  readonly initCalls: ActualReadApiInitConfig[] = [];
  readonly downloadCalls: string[] = [];
  readonly bankSyncCalls: string[] = [];
  readonly balanceCalls: Array<{ id: string; cutoff?: Date | undefined }> = [];
  readonly transactionCalls: Array<{
    accountId: string;
    startDate: string;
    endDate: string;
  }> = [];
  readonly notes: Array<{ id: string; note: string }> = [];
  readonly budgets: ActualReadApiBudget[] = [
    {
      id: 'local-budget',
      cloudFileId: 'cloud-budget',
      groupId: 'budget-sync',
      name: 'Household Budget',
    },
    {
      cloudFileId: 'cloud-budget',
      groupId: 'budget-sync',
      name: 'Household Budget',
      state: 'remote',
    },
  ];
  readonly accounts: ActualReadApiAccount[] = [
    {
      id: 'account-daily',
      name: 'Daily Spending',
      closed: false,
      offbudget: false,
    },
    {
      id: 'account-card',
      name: 'Credit Card',
      closed: false,
      offbudget: false,
    },
    {
      id: 'account-debt',
      name: 'Line of Credit',
      closed: false,
      offbudget: true,
    },
    {
      id: 'account-cashback',
      name: 'Cashback Staging',
      closed: false,
      offbudget: true,
    },
    {
      id: 'account-kid',
      name: 'Kid Savings',
      closed: true,
      offbudget: true,
    },
  ];
  readonly categoryGroups: ActualReadApiCategoryGroup[] = [
    {
      id: 'expense-group',
      name: 'Expenses',
      hidden: false,
      is_income: false,
      categories: [
        {
          id: 'category-groceries',
          group_id: 'expense-group',
          name: 'Groceries',
          hidden: false,
          is_income: false,
        },
        {
          id: 'category-general',
          group_id: 'expense-group',
          name: 'General',
          hidden: false,
          is_income: false,
        },
        {
          id: 'category-hidden',
          group_id: 'expense-group',
          name: 'Archived Expense',
          hidden: true,
          is_income: false,
        },
      ],
    },
    {
      id: 'income-group',
      name: 'Income',
      hidden: false,
      is_income: true,
      categories: [
        {
          id: 'category-income',
          group_id: 'income-group',
          name: 'Income',
          hidden: false,
          is_income: true,
        },
      ],
    },
  ];
  readonly payees: ActualReadApiPayee[] = [
    { id: 'payee-market', name: 'Example Market' },
    { id: 'payee-employer', name: 'Employer' },
    { id: 'payee-hydro', name: 'Hydro' },
    {
      id: 'payee-transfer',
      name: 'Transfer: Credit Card',
      transfer_acct: 'account-card',
    },
    {
      id: 'payee-transfer-debt',
      name: 'Transfer: Line of Credit',
      transfer_acct: 'account-debt',
    },
    {
      id: 'payee-transfer-cashback',
      name: 'Transfer: Cashback Staging',
      transfer_acct: 'account-cashback',
    },
  ];
  readonly transactions: ActualReadApiTransaction[] = [
    {
      id: 'transaction-hidden-category',
      account: 'account-daily',
      date: '2026-06-15',
      amount: -600,
      imported_id: 'bank-hidden-1',
      category: 'category-hidden',
      payee: 'payee-market',
    },
    {
      id: 'transaction-grocery',
      account: 'account-daily',
      date: '2026-07-01',
      amount: -1_000,
      imported_id: 'bank-grocery-1',
      category: 'category-groceries',
      payee: 'payee-market',
      notes: 'Order 123456 for 550e8400-e29b-41d4-a716-446655440000 groceries',
    },
    {
      id: 'transaction-refund',
      account: 'account-daily',
      date: '2026-07-02',
      amount: 200,
      imported_id: 'bank-refund-1',
      category: 'category-groceries',
      payee: 'payee-market',
      notes: 'refund',
    },
    {
      id: 'transaction-split',
      account: 'account-daily',
      date: '2026-07-03',
      amount: -1_500,
      imported_id: 'bank-split-1',
      payee: 'payee-market',
      notes: 'weekly shop',
      subtransactions: [
        {
          amount: -1_200,
          category: 'category-groceries',
          payee: 'payee-market',
          notes: 'food',
        },
        {
          amount: -300,
          category: 'category-general',
          payee: 'payee-market',
          notes: 'cleaning supplies',
        },
      ],
    },
    {
      id: 'transaction-income',
      account: 'account-daily',
      date: '2026-07-04',
      amount: 5_000,
      imported_id: 'bank-income-1',
      category: 'category-income',
      payee: 'payee-employer',
    },
    {
      id: 'transaction-uncategorized',
      account: 'account-daily',
      date: '2026-07-05',
      amount: -250,
      imported_id: 'bank-uncategorized-1',
      payee: 'payee-market',
    },
    {
      id: 'transaction-transfer',
      account: 'account-daily',
      date: '2026-07-06',
      amount: -100,
      imported_id: 'bank-card-payment-1',
      payee: 'payee-transfer',
    },
    {
      id: 'transaction-start',
      account: 'account-daily',
      date: '2026-07-06',
      amount: 99_999,
      starting_balance_flag: true,
    },
    {
      id: 'transaction-tombstone',
      account: 'account-daily',
      date: '2026-07-06',
      amount: -99_999,
      tombstone: true,
    },
    {
      id: 'transaction-child',
      account: 'account-daily',
      date: '2026-07-06',
      amount: -99_999,
      is_child: true,
    },
    {
      id: 'transaction-zero',
      account: 'account-daily',
      date: '2026-07-06',
      amount: 0,
    },
    {
      id: 'transaction-card',
      account: 'account-card',
      date: '2026-07-07',
      amount: -500,
      imported_id: 'bank-card-charge-1',
      category: 'category-groceries',
      payee: 'payee-market',
      notes: `card groceries person@example.test 4111 1111 1111 1111 ${actualReceiptLinkToken(
        linkedReceiptId,
        linkedReceiptSourceSha256,
      )}`,
      reconciled: true,
      raw_synced_data: {
        provider: 'synthetic-bank',
        sequence: 7,
      },
    },
    {
      id: 'transaction-debt-payment',
      account: 'account-daily',
      date: '2026-07-08',
      amount: -1_000,
      imported_id: 'bank-debt-payment-1',
      payee: 'payee-transfer-debt',
    },
    {
      id: 'transaction-transfer-cashback',
      account: 'account-daily',
      date: '2026-07-09',
      amount: -100,
      imported_id: 'bank-transfer-1',
      payee: 'payee-transfer-cashback',
    },
    {
      id: 'transaction-cashback',
      account: 'account-cashback',
      date: '2026-07-10',
      amount: 50,
      imported_id: 'bank-cashback-1',
      payee: 'payee-market',
    },
    {
      id: 'transaction-debt-expense',
      account: 'account-debt',
      date: '2026-07-07',
      amount: -500,
      imported_id: 'bank-debt-expense-1',
      payee: 'payee-market',
    },
  ];
  readonly schedules: ActualReadApiSchedule[] = [
    {
      id: 'schedule-hydro',
      name: 'Hydro bill',
      next_date: '2026-07-30',
      completed: false,
      account: 'account-daily',
      payee: 'payee-hydro',
      amount: -8_500,
      amountOp: 'is',
    },
    {
      id: 'schedule-variable',
      next_date: '2026-08-02',
      completed: false,
      account: 'account-card',
      payee: 'payee-market',
      amount: { num1: -10_000, num2: -12_000 },
      amountOp: 'isbetween',
    },
    {
      id: 'schedule-income',
      next_date: '2026-08-01',
      completed: false,
      account: 'account-daily',
      payee: 'payee-employer',
      amount: 20_000,
      amountOp: 'is',
    },
    {
      id: 'schedule-transfer',
      next_date: '2026-08-01',
      completed: false,
      account: 'account-daily',
      payee: 'payee-transfer',
      amount: -4_000,
      amountOp: 'is',
    },
    {
      id: 'schedule-completed',
      next_date: '2026-08-01',
      completed: true,
      account: 'account-daily',
      payee: 'payee-hydro',
      amount: -1_000,
      amountOp: 'is',
    },
    {
      id: 'schedule-outside',
      next_date: '2026-09-01',
      completed: false,
      account: 'account-daily',
      payee: 'payee-hydro',
      amount: -1_000,
      amountOp: 'is',
    },
  ];
  readonly budgetMonth: ActualReadApiBudgetMonth = {
    month: '2026-07',
    toBudget: 8_000,
    categoryGroups: [
      {
        id: 'expense-group',
        categories: [
          {
            id: 'category-groceries',
            budgeted: 2_000,
            spent: -2_700,
            balance: -700,
          },
          {
            id: 'category-general',
            budgeted: 500,
            spent: -300,
            balance: 200,
          },
        ],
      },
    ],
  };
  readonly balances = new Map([
    ['account-daily', 10_500],
    ['account-card', -2_345],
    ['account-debt', -900_000],
    ['account-cashback', 0],
  ]);
  shutdownCount = 0;
  syncCount = 0;
  activeSyncs = 0;
  maximumConcurrentSyncs = 0;
  syncDelayMs = 0;
  failBankSyncAccountId: string | undefined;
  failSync = false;

  async init(config: ActualReadApiInitConfig): Promise<void> {
    this.initCalls.push(structuredClone(config));
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
  }

  async downloadBudget(syncId: string): Promise<void> {
    this.downloadCalls.push(syncId);
  }

  async sync(): Promise<void> {
    this.syncCount += 1;
    this.activeSyncs += 1;
    this.maximumConcurrentSyncs = Math.max(
      this.maximumConcurrentSyncs,
      this.activeSyncs,
    );
    try {
      if (this.syncDelayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.syncDelayMs),
        );
      }
      if (this.failSync) throw new Error('synthetic sync failure');
    } finally {
      this.activeSyncs -= 1;
    }
  }

  async runBankSync(args: { readonly accountId: string }): Promise<void> {
    this.bankSyncCalls.push(args.accountId);
    if (args.accountId === this.failBankSyncAccountId) {
      throw new Error('synthetic bank failure');
    }
  }

  async getBudgets(): Promise<readonly ActualReadApiBudget[]> {
    return structuredClone(this.budgets);
  }

  async getAccounts(): Promise<readonly ActualReadApiAccount[]> {
    return structuredClone(this.accounts);
  }

  async getAccountBalance(id: string, cutoff?: Date): Promise<number> {
    this.balanceCalls.push({ id, ...(cutoff === undefined ? {} : { cutoff }) });
    return this.balances.get(id) ?? 0;
  }

  async getCategoryGroups(): Promise<readonly ActualReadApiCategoryGroup[]> {
    return structuredClone(this.categoryGroups);
  }

  async getPayees(): Promise<readonly ActualReadApiPayee[]> {
    return structuredClone(this.payees);
  }

  async getTransactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<readonly ActualReadApiTransaction[]> {
    this.transactionCalls.push({ accountId, startDate, endDate });
    return structuredClone(
      this.transactions.filter(
        (transaction) =>
          transaction.account === accountId &&
          transaction.date >= startDate &&
          transaction.date <= endDate,
      ),
    );
  }

  async getSchedules(): Promise<readonly ActualReadApiSchedule[]> {
    return structuredClone(this.schedules);
  }

  async getBudgetMonth(month: string): Promise<ActualReadApiBudgetMonth> {
    return { ...structuredClone(this.budgetMonth), month };
  }

  q(table: string): ActualReadApiAqlQuery {
    return new SyntheticAqlQuery(table);
  }

  async aqlQuery(query: ActualReadApiAqlQuery): Promise<unknown> {
    if (
      !(query instanceof SyntheticAqlQuery) ||
      query.table !== 'notes' ||
      query.fields.join('\u0000') !== 'id\u0000note'
    ) {
      throw new Error('unexpected synthetic AQL query');
    }
    return { data: structuredClone(this.notes) };
  }
}

function readContract(): ActualReadContract {
  const identity: ActualReadContractIdentity = {
    schemaVersion: ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
    scope: ACTUAL_READ_CONTRACT_SCOPE,
    nonce: 'a'.repeat(64),
    budget: { syncId: 'budget-sync', name: 'Household Budget' },
    accounts: {
      daily: {
        id: 'account-daily',
        name: 'Daily Spending',
        role: 'spending',
        onBudget: true,
        bankSyncEnabled: true,
      },
      card: {
        id: 'account-card',
        name: 'Credit Card',
        role: 'credit-card',
        onBudget: true,
        bankSyncEnabled: true,
        lastFour: '4242',
      },
      debt: {
        id: 'account-debt',
        name: 'Line of Credit',
        role: 'debt',
        onBudget: false,
        bankSyncEnabled: true,
      },
      cashback: {
        id: 'account-cashback',
        name: 'Cashback Staging',
        role: 'cashback-staging',
        onBudget: false,
        bankSyncEnabled: true,
      },
    },
    categories: {
      groceries: { name: 'Groceries' },
      general: { name: 'General' },
      income: { name: 'Income' },
    },
    expectedCurrency: 'CAD',
    maximumAggregateRangeDays: 366,
    maximumExplanationRangeDays: 366,
    maximumExplanationRows: 20,
    maximumObservationRangeDays: 45,
    maximumObservationRows: 500,
    freshnessMaximumAgeSeconds: 900,
    expectedBankDelayHours: 24,
    bankSyncMinimumIntervalSeconds: 300,
  };
  return parseActualReadContract({
    ...identity,
    fingerprint: actualReadContractFingerprint(identity),
  });
}

function privateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'actual-api-read-'));
  chmodSync(directory, 0o700);
  return directory;
}

function harness(
  options: {
    readonly api?: SyntheticActualReadApi;
    readonly store?: MemoryFreshnessStore;
    readonly now?: () => Date;
    readonly startOperationWatchdog?: () => () => void;
  } = {},
) {
  const api = options.api ?? new SyntheticActualReadApi();
  const store = options.store ?? new MemoryFreshnessStore();
  const reader = new ActualApiReadPort(
    {
      dataDir: privateDirectory(),
      serverURL: 'http://actual-server:5006',
      serverPassword: 'synthetic-password',
      readContract: readContract(),
    },
    {
      api,
      freshnessStore: store,
      now: options.now ?? (() => new Date('2026-07-28T12:00:00.000Z')),
      ...(options.startOperationWatchdog === undefined
        ? {}
        : { startOperationWatchdog: options.startOperationWatchdog }),
    },
  );
  return { api, store, reader };
}

async function initializedHarness(options: Parameters<typeof harness>[0] = {}) {
  const result = harness(options);
  await result.reader.initialize();
  return result;
}

function syntheticReceiptRecord(
  receiptId: string,
  options: {
    readonly merchant?: string;
    readonly purchaseDate?: string | null;
    readonly itemDescription?: string;
    readonly sourceHash?: string;
    readonly householdNotes?: readonly string[];
  } = {},
): unknown {
  const sourceHash = options.sourceHash ?? 'a'.repeat(64);
  return {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId,
    revision: 1,
    createdAt: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:01:00.000Z',
    sources: [
      {
        nextcloudFileId: `file-${receiptId}`,
        archivePath: `Household Finance/2026/07/${receiptId}.jpg`,
        sha256: sourceHash,
        mediaType: 'image/jpeg',
        receivedAt: '2026-07-28T10:00:00.000Z',
        talk: {
          roomToken: 'household-finance',
          actorId: 'alex',
          messageId: `message-${receiptId}`,
        },
      },
    ],
    status: 'active',
    ...(options.householdNotes === undefined
      ? {}
      : {
          householdNotes: options.householdNotes.map((text, index) => ({
            text,
            receivedAt: `2026-07-28T10:00:0${String(index)}.000Z`,
            talk: {
              roomToken: 'household-finance',
              actorId: 'alex',
              messageId: `note-${String(index)}`,
            },
          })),
        }),
    merchant: options.merchant ?? 'Example Market',
    purchaseDate: options.purchaseDate ?? '2026-07-27',
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
    paymentEvidence: { kind: 'unknown', lastFour: null },
    receiptReference: 'SYNTHETIC-001',
    items: [
      {
        description: options.itemDescription ?? 'Synthetic cable',
        quantity: 1,
        unitPriceMinor: 1_500,
        totalMinor: 1_500,
      },
    ],
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      zeroDataRetention: true,
      extractedAt: '2026-07-28T10:01:00.000Z',
      sourceSha256s: [sourceHash],
    },
  };
}

describe('Actual API read port', () => {
  it('binds the exact budget and active on-budget accounts and exposes only safe catalog names', async () => {
    const { api, reader } = await initializedHarness();

    expect(api.downloadCalls).toEqual(['budget-sync']);
    expect(await reader.catalog()).toEqual({
      currency: 'CAD',
      accountNames: [
        'Cashback Staging',
        'Credit Card',
        'Daily Spending',
        'Line of Credit',
      ],
      categoryNames: ['General', 'Groceries'],
      merchantNames: ['Employer', 'Example Market', 'Hydro'],
      freshness: {
        actualBudgetAsOf: '2026-07-28T12:00:00.000Z',
        bankFeedAsOf: null,
        lastAttemptAt: null,
        lastSuccessfulSyncAt: null,
        lastOutcome: 'never',
        isFresh: false,
        expectedBankDelayHours: 24,
      },
    });
    expect(JSON.stringify(await reader.catalog())).not.toContain('account-');
  });

  it('lists namespaced notes through AQL and exposes bounded receipt facts', async () => {
    const api = new SyntheticActualReadApi();
    const firstId = '8dfc1bd9-e07a-4c62-9d58-9529361536b9';
    const secondId = 'a8a3eab6-fb10-47d8-930b-3e28ffdaf845';
    const first = syntheticReceiptRecord(firstId, {
      householdNotes: [
        'Initial purpose.',
        'Maybe office.',
        'Household supplies.',
        "Correction: Elia's birthday present.",
      ],
    });
    const second = syntheticReceiptRecord(secondId, {
      merchant: 'Other Store',
      itemDescription: 'Garden soil',
      sourceHash: 'b'.repeat(64),
    });
    api.notes.push(
      { id: 'budget-note', note: 'unrelated non-JSON is ignored' },
      {
        id: `${ACTUAL_RECEIPT_NOTE_PREFIX}${secondId}`,
        note: canonicalHouseholdFinanceReceiptJson(second),
      },
      {
        id: `${ACTUAL_RECEIPT_NOTE_PREFIX}${firstId}`,
        note: canonicalHouseholdFinanceReceiptJson(first),
      },
    );
    const { reader } = await initializedHarness({ api });

    const result = await reader.searchReceipts({
      startDate: '2025-08-01',
      endDate: '2026-07-31',
      textQuery: 'synthetic birthday',
      merchantQuery: 'market',
      limit: 20,
    });

    expect(result.matchedReceiptCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.receipts).toEqual([
      {
        merchant: 'Example Market',
        purchaseDate: '2026-07-27',
        purchaseTime: null,
        timezoneOffset: null,
        currency: 'CAD',
        amounts: {
          subtotalMinorUnits: 1_500,
          taxMinorUnits: 225,
          discountMinorUnits: 0,
          tipMinorUnits: 0,
          totalMinorUnits: 1_725,
        },
        paymentEvidence: { kind: 'unknown', lastFour: null },
        receiptReference: 'SYNTHETIC-001',
        householdNotes: [
          'Maybe office.',
          'Household supplies.',
          "Correction: Elia's birthday present.",
        ],
        items: [
          {
            description: 'Synthetic cable',
            quantity: 1,
            unitPriceMinorUnits: 1_500,
            totalMinorUnits: 1_500,
          },
        ],
        automaticProcessingBlocked: false,
        itemDetailsComplete: true,
        sourceCount: 1,
        extractedAt: '2026-07-28T10:01:00.000Z',
      },
    ]);
    expect(result.receipts[0]).not.toHaveProperty('receiptId');
    expect(result.receipts[0]).not.toHaveProperty('sources');

    const firstPage = await reader.receiptRecords({
      afterNoteId: null,
      limit: 1,
    });
    expect(firstPage.records).toHaveLength(1);
    expect(firstPage.records[0]!.noteId).toBe(
      `${ACTUAL_RECEIPT_NOTE_PREFIX}${firstId}`,
    );
    expect(firstPage.nextAfterNoteId).toBe(firstPage.records[0]!.noteId);
    expect(firstPage.truncated).toBe(true);
    await expect(
      reader.receiptRecords({
        afterNoteId: firstPage.nextAfterNoteId,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      records: [{ noteId: `${ACTUAL_RECEIPT_NOTE_PREFIX}${secondId}` }],
      nextAfterNoteId: null,
      truncated: false,
    });
  });

  it('fails closed on malformed namespaced receipt notes', async () => {
    const api = new SyntheticActualReadApi();
    api.notes.push({
      id: `${ACTUAL_RECEIPT_NOTE_PREFIX}8dfc1bd9-e07a-4c62-9d58-9529361536b9`,
      note: '{"not":"a receipt"}',
    });
    const { reader } = await initializedHarness({ api });

    await expect(
      reader.searchReceipts({
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        textQuery: null,
        merchantQuery: null,
        limit: 20,
      }),
    ).rejects.toMatchObject({ name: 'ActualReadDataError' });
  });

  it('accounts for splits, refunds, uncategorized expenses, income, and exclusions', async () => {
    const { reader } = await initializedHarness();

    await expect(
      reader.categorySpend({
        categoryName: 'groceries',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      }),
    ).resolves.toMatchObject({
      categoryName: 'Groceries',
      expenseMinorUnits: 2_700,
      refundMinorUnits: 200,
      netSpentMinorUnits: 2_500,
      transactionCount: 4,
      uncategorizedExpenseMinorUnits: 250,
      uncategorizedTransactionCount: 1,
    });
    await expect(
      reader.merchantSpend({
        merchantName: 'example market',
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      }),
    ).resolves.toMatchObject({
      merchantName: 'Example Market',
      expenseMinorUnits: 3_250,
      refundMinorUnits: 200,
      netSpentMinorUnits: 3_050,
      transactionCount: 5,
      uncategorizedExpenseMinorUnits: 250,
      uncategorizedTransactionCount: 1,
    });
    await expect(
      reader.income({
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      }),
    ).resolves.toMatchObject({
      incomeMinorUnits: 5_000,
      transactionCount: 1,
    });
    await expect(
      reader.cashFlow({
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      }),
    ).resolves.toMatchObject({
      incomeMinorUnits: 5_200,
      spendingMinorUnits: 3_250,
      netCashFlowMinorUnits: 1_950,
      incomeTransactionCount: 2,
      spendingTransactionCount: 4,
    });
    await expect(
      reader.cashFlow({
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      }),
    ).resolves.toMatchObject({
      incomeMinorUnits: 0,
      spendingMinorUnits: 600,
      netCashFlowMinorUnits: -600,
      spendingTransactionCount: 1,
    });
  });

  it('scans live-shaped uncategorized imports whose optional Actual fields are null', async () => {
    const api = new SyntheticActualReadApi();
    api.transactions.push({
      id: 'transaction-live-null-import',
      account: 'account-daily',
      date: '2026-07-11',
      amount: -725,
      imported_id: 'bank-live-null-import-1',
      category: null,
      transfer_id: null,
      payee: 'payee-market',
    });
    const { reader } = await initializedHarness({ api });

    const scan = await reader.scanImportedTransactions({
      startDate: '2026-07-11',
      endDate: '2026-07-11',
      previousWatermark: null,
    });

    expect(scan.observations).toHaveLength(1);
    expect(scan.observations[0]).toMatchObject({
      transactionId: 'transaction-live-null-import',
      currentCategoryAlias: null,
      currentCategoryName: null,
      currentCategoryStatus: 'uncategorized',
      specialKind: 'ordinary',
    });
  });

  it('includes live-shaped null transfer and category fields in public read queries', async () => {
    const api = new SyntheticActualReadApi();
    api.transactions.push({
      id: 'transaction-live-null-query',
      account: 'account-daily',
      date: '2026-07-11',
      amount: -725,
      imported_id: 'bank-live-null-query-1',
      category: null,
      transfer_id: null,
      payee: 'payee-market',
    });
    const { reader } = await initializedHarness({ api });

    await expect(
      reader.categorySpend({
        categoryName: 'Groceries',
        startDate: '2026-07-11',
        endDate: '2026-07-11',
      }),
    ).resolves.toMatchObject({
      expenseMinorUnits: 0,
      transactionCount: 0,
      uncategorizedExpenseMinorUnits: 725,
      uncategorizedTransactionCount: 1,
    });
    await expect(
      reader.cashFlow({
        startDate: '2026-07-11',
        endDate: '2026-07-11',
      }),
    ).resolves.toMatchObject({
      spendingMinorUnits: 725,
      spendingTransactionCount: 1,
    });
  });

  it('answers balances, bills, budget capacity, and progress with bounded derived values', async () => {
    const { api, reader } = await initializedHarness();

    await expect(
      reader.accountBalances({
        accountName: 'Daily Spending',
        asOfDate: '2026-07-31',
      }),
    ).resolves.toMatchObject({
      accountName: 'Daily Spending',
      asOfDate: '2026-07-31',
      accounts: [
        {
          name: 'Daily Spending',
          role: 'spending',
          onBudget: true,
          balanceMinorUnits: 10_500,
        },
      ],
      totalBalanceMinorUnits: 10_500,
    });
    expect(api.balanceCalls).toEqual([
      {
        id: 'account-daily',
        cutoff: new Date(2026, 6, 31, 12, 0, 0, 0),
      },
    ]);
    await expect(
      reader.accountBalances({
        accountName: 'Line of Credit',
        asOfDate: '2026-07-31',
      }),
    ).resolves.toMatchObject({
      accounts: [
        {
          name: 'Line of Credit',
          role: 'debt',
          onBudget: false,
          balanceMinorUnits: -900_000,
        },
      ],
      totalBalanceMinorUnits: -900_000,
    });
    await expect(
      reader.upcomingBills({
        fromDate: '2026-07-28',
        throughDate: '2026-08-15',
      }),
    ).resolves.toMatchObject({
      bills: [
        {
          name: 'Hydro bill',
          dueDate: '2026-07-30',
          amountMinorUnits: 8_500,
          amountCertain: true,
        },
        {
          name: 'Example Market',
          dueDate: '2026-08-02',
          amountMinorUnits: 12_000,
          amountCertain: false,
        },
      ],
    });
    await expect(
      reader.budgetCapacity({
        month: '2026-07',
        targetCategoryName: 'Groceries',
      }),
    ).resolves.toMatchObject({
      toBudgetMinorUnits: 8_000,
      ceilingMinorUnits: 8_000,
      method: 'actual-to-budget-ceiling-only',
      targetCategory: {
        name: 'Groceries',
        budgetedMinorUnits: 2_000,
        spentMinorUnits: 2_700,
        balanceMinorUnits: -700,
      },
    });
    await expect(
      reader.budgetProgress({
        month: '2026-07',
        categoryName: null,
      }),
    ).resolves.toMatchObject({
      categoryName: null,
      categories: [
        {
          name: 'General',
          budgetedMinorUnits: 500,
          spentMinorUnits: 300,
          balanceMinorUnits: 200,
          overspentMinorUnits: 0,
        },
        {
          name: 'Groceries',
          budgetedMinorUnits: 2_000,
          spentMinorUnits: 2_700,
          balanceMinorUnits: -700,
          overspentMinorUnits: 700,
        },
      ],
      totalBudgetedMinorUnits: 2_500,
      totalSpentMinorUnits: 3_000,
      totalBalanceMinorUnits: -500,
    });
    await expect(
      reader.overspending({ month: '2026-07' }),
    ).resolves.toMatchObject({
      categories: [{ name: 'Groceries', overspentMinorUnits: 700 }],
      totalOverspentMinorUnits: 700,
    });
    await expect(
      reader.availableFunds({ asOfDate: '2026-07-28' }),
    ).resolves.toMatchObject({
      onBudgetCashMinorUnits: 10_500,
      availableToBudgetMinorUnits: 8_000,
      fundedCategoryBalanceMinorUnits: 200,
      upcomingObligationsMinorUnits: 20_500,
      availableFundsMinorUnits: -12_500,
      method: 'actual-envelope-summary',
    });
  });

  it('returns bounded aggregate explanations with display names, never raw IDs', async () => {
    const { reader } = await initializedHarness();

    const result = await reader.transactionExplanation({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      merchantName: 'Example Market',
      limit: 2,
    });

    expect(result.truncated).toBe(true);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      date: '2026-07-07',
      merchantName: 'Example Market',
      accountName: 'Credit Card',
      amountMinorUnits: -500,
      categoryNames: ['Groceries'],
      split: false,
      cleared: false,
      categorizationEvidence: 'actual-ledger',
    });
    const all = await reader.transactionExplanation({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      merchantName: 'Example Market',
      limit: 10,
    });
    expect(JSON.stringify(all)).not.toMatch(
      /account-(?:daily|card)|category-groceries|payee-market|transaction-/u,
    );
    await expect(
      reader.categoryExplanation({
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        categoryName: 'Groceries',
        limit: 10,
      }),
    ).resolves.toMatchObject({
      categoryName: 'Groceries',
      netSpentMinorUnits: 2_500,
      transactionCount: 4,
      topContributions: [
        {
          merchantName: 'Example Market',
          netSpentMinorUnits: 2_500,
          transactionCount: 4,
        },
      ],
      categorizationEvidence: [
        { evidence: 'actual-ledger', transactionCount: 4 },
      ],
      truncated: false,
    });
  });

  it('searches the full bound ledger with useful filters and no raw identifiers', async () => {
    const { reader } = await initializedHarness();

    const uncategorized = await reader.transactionSearch({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      accountName: null,
      merchantName: null,
      categoryName: null,
      absoluteAmountMinorUnits: null,
      kind: 'ordinary',
      direction: 'expense',
      categorization: 'uncategorized',
      sort: 'amount-desc',
      limit: 20,
    });

    expect(uncategorized).toMatchObject({
      matchedTransactionCount: 2,
      truncated: false,
      transactions: [
        {
          date: '2026-07-07',
          merchantName: 'Example Market',
          accountName: 'Line of Credit',
          amountMinorUnits: -500,
          categoryNames: [],
          categorizationEvidence: 'uncategorized',
        },
        {
          date: '2026-07-05',
          merchantName: 'Example Market',
          accountName: 'Daily Spending',
          amountMinorUnits: -250,
          categoryNames: [],
          categorizationEvidence: 'uncategorized',
        },
      ],
    });

    const groceries = await reader.transactionSearch({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      accountName: 'Daily Spending',
      merchantName: 'Example Market',
      categoryName: 'Groceries',
      absoluteAmountMinorUnits: null,
      kind: 'ordinary',
      direction: 'expense',
      categorization: 'categorized',
      sort: 'amount-desc',
      limit: 20,
    });
    expect(groceries.transactions[0]).toMatchObject({
      amountMinorUnits: -1_500,
      categoryNames: ['General', 'Groceries'],
      split: true,
      memo: 'food | cleaning supplies',
    });

    const exactSplit = await reader.transactionSearch({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      accountName: null,
      merchantName: null,
      categoryName: null,
      absoluteAmountMinorUnits: 1_500,
      kind: 'ordinary',
      direction: 'expense',
      categorization: 'any',
      sort: 'date-desc',
      limit: 20,
    });
    expect(exactSplit).toMatchObject({
      matchedTransactionCount: 1,
      transactions: [
        {
          amountMinorUnits: -1_500,
          categoryNames: ['General', 'Groceries'],
          split: true,
        },
      ],
    });

    const exactAmount = await reader.transactionSearch({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      accountName: null,
      merchantName: null,
      categoryName: null,
      absoluteAmountMinorUnits: 500,
      kind: 'ordinary',
      direction: 'expense',
      categorization: 'any',
      sort: 'date-desc',
      limit: 20,
    });
    expect(exactAmount).toMatchObject({
      absoluteAmountMinorUnits: 500,
      matchedTransactionCount: 2,
      expenseMinorUnits: 1_000,
      incomeMinorUnits: 0,
      netCashFlowMinorUnits: -1_000,
      truncated: false,
      transactions: [
        { accountName: 'Credit Card', amountMinorUnits: -500 },
        { accountName: 'Line of Credit', amountMinorUnits: -500 },
      ],
    });
    expect(JSON.stringify([uncategorized, groceries, exactAmount])).not.toMatch(
      /account-(?:daily|card|debt)|category-groceries|payee-market|transaction-|bank-/u,
    );
  });

  it('reports an over-broad transaction search as invalid input', async () => {
    const { reader } = await initializedHarness();

    await expect(
      reader.transactionSearch({
        startDate: '2025-07-29',
        endDate: '2026-07-30',
        accountName: null,
        merchantName: null,
        categoryName: null,
        absoluteAmountMinorUnits: null,
        kind: 'ordinary',
        direction: 'expense',
        categorization: 'any',
        sort: 'date-desc',
        limit: 20,
      }),
    ).rejects.toMatchObject({ name: 'ActualReadProtocolError' });
  });

  it('returns the exact bounded set eligible for categorization', async () => {
    const api = new SyntheticActualReadApi();
    api.transactions.push(
      {
        id: 'transaction-second-uncategorized',
        account: 'account-card',
        date: '2026-07-11',
        amount: -725,
        imported_id: 'bank-second-uncategorized-1',
        payee: 'payee-market',
        notes: 'Order 123456 for person@example.test',
      },
      {
        id: 'transaction-receipt-owned',
        account: 'account-card',
        date: '2026-07-12',
        amount: -925,
        imported_id: 'bank-receipt-owned-1',
        payee: 'payee-market',
        notes: actualReceiptLinkToken(
          linkedReceiptId,
          linkedReceiptSourceSha256,
        ),
      },
    );
    const { reader } = await initializedHarness({ api });

    const result = await reader.needsCategorization({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      sort: 'amount-desc',
      limit: 1,
    });

    expect(result).toMatchObject({
      matchedTransactionCount: 2,
      truncated: true,
      transactions: [
        {
          date: '2026-07-11',
          merchantName: 'Example Market',
          accountName: 'Credit Card',
          amountMinorUnits: -725,
          cleared: false,
          kind: 'ordinary',
          memo: 'Order [redacted-number] for [redacted-email]',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /transaction-|bank-|account-card|person@example/u,
    );
  });

  it('returns deterministic imported observations and exact bounded receipt candidates', async () => {
    const { api, reader } = await initializedHarness();
    const scan = await reader.scanImportedTransactions({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      previousWatermark: null,
    });

    expect(scan.observations).toHaveLength(11);
    expect(scan.watermark).toMatch(/^[a-f0-9]{64}$/u);
    expect(scan.importFreshnessToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      new Set(scan.observations.map(({ specialKind }) => specialKind)),
    ).toEqual(
      new Set([
        'ordinary',
        'refund',
        'card-payment',
        'debt-payment',
        'transfer',
        'cashback',
      ]),
    );
    expect(
      scan.observations.find(
        ({ transactionId }) => transactionId === 'transaction-card',
      ),
    ).toEqual({
      schemaVersion: 'actual-imported-transaction-observation.v1',
      transactionId: 'transaction-card',
      importedId: 'bank-card-charge-1',
      accountAlias: 'card',
      accountRole: 'credit-card',
      accountOnBudget: true,
      accountLastFour: '4242',
      date: '2026-07-07',
      amountMinorUnits: -500,
      direction: 'expense',
      payeeName: 'Example Market',
      memo: 'card groceries [redacted-email] [redacted-number]',
      currentCategoryAlias: 'groceries',
      currentCategoryName: 'Groceries',
      currentCategoryStatus: 'contract-bound',
      split: false,
      cleared: false,
      specialKind: 'ordinary',
      alreadyLinkedReceipts: [linkedReceipt],
      observationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      scan.observations.find(
        ({ transactionId }) => transactionId === 'transaction-split',
      ),
    ).toMatchObject({
      currentCategoryAlias: null,
      currentCategoryName: null,
      currentCategoryStatus: 'split',
      split: true,
    });
    expect(
      await reader.scanImportedTransactions({
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        previousWatermark: scan.watermark,
      }),
    ).toMatchObject({
      observations: [],
      watermark: scan.watermark,
      unchanged: true,
    });

    await expect(
      reader.candidatesForReceipt({
        schemaVersion: 'receipt-match-intent.v1',
        receiptId: '8dfc1bd9-e07a-4c62-9d58-9529361536b9',
        merchantName: 'Example Market',
        purchaseDate: '2026-07-07',
        currency: 'CAD',
        totalMinorUnits: 500,
        paymentEvidence: { kind: 'masked-card', lastFour: '4242' },
      }),
    ).resolves.toEqual([
      {
        transactionId: 'transaction-card',
        importedId: 'bank-card-charge-1',
        accountAlias: 'card',
        accountLastFour: '4242',
        postingDate: '2026-07-07',
        payeeName: 'Example Market',
        statementDescription:
          'card groceries [redacted-email] [redacted-number]',
        currency: 'CAD',
        amountMinorUnits: -500,
        alreadyLinkedReceipts: [linkedReceipt],
      },
    ]);
    await expect(
      reader.candidatesForReceipt({
        schemaVersion: 'receipt-match-intent.v1',
        receiptId: linkedReceiptId,
        merchantName: 'Example Market',
        purchaseDate: '2026-07-07',
        currency: 'CAD',
        totalMinorUnits: 500,
        paymentEvidence: { kind: 'masked-card', lastFour: '9999' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        transactionId: 'transaction-card',
        alreadyLinkedReceipts: [linkedReceipt],
      }),
    ]);
    await expect(
      reader.candidatesForReceipt({
        schemaVersion: 'receipt-match-intent.v1',
        receiptId: '8dfc1bd9-e07a-4c62-9d58-9529361536b9',
        merchantName: 'Example Market',
        purchaseDate: '2026-07-07',
        currency: 'USD',
        totalMinorUnits: 171,
        paymentEvidence: { kind: 'masked-card', lastFour: '4242' },
      }),
    ).resolves.toEqual([
      {
        transactionId: 'transaction-card',
        importedId: 'bank-card-charge-1',
        accountAlias: 'card',
        accountLastFour: '4242',
        postingDate: '2026-07-07',
        payeeName: 'Example Market',
        statementDescription:
          'card groceries [redacted-email] [redacted-number]',
        currency: 'CAD',
        amountMinorUnits: -500,
        alreadyLinkedReceipts: [linkedReceipt],
      },
    ]);
    api.transactions.push(
      {
        id: 'transaction-card-part-one',
        account: 'account-card',
        date: '2026-07-08',
        amount: -200,
        imported_id: 'bank-card-part-one',
        payee: 'payee-market',
      },
      {
        id: 'transaction-card-part-two',
        account: 'account-card',
        date: '2026-07-09',
        amount: -300,
        imported_id: 'bank-card-part-two',
        payee: 'payee-market',
      },
    );
    const pluralIntent = {
      schemaVersion: 'receipt-match-intent.v1' as const,
      receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      merchantName: 'Example Market',
      purchaseDate: '2026-07-07',
      currency: 'CAD',
      totalMinorUnits: 500,
      paymentEvidence: { kind: 'masked-card' as const, lastFour: '4242' },
    };
    const pluralCandidates = await reader.candidatesForReceipt(pluralIntent);
    expect(pluralCandidates).toEqual([
      expect.objectContaining({
        transactionId: 'transaction-card',
        amountMinorUnits: -500,
      }),
      expect.objectContaining({
        transactionId: 'transaction-card-part-one',
        amountMinorUnits: -200,
      }),
      expect.objectContaining({
        transactionId: 'transaction-card-part-two',
        amountMinorUnits: -300,
      }),
    ]);
    expect(
      matchReceiptToImportedTransactions(pluralIntent, pluralCandidates),
    ).toMatchObject({
      disposition: 'matched-set',
      candidates: [
        { transactionId: 'transaction-card-part-one' },
        { transactionId: 'transaction-card-part-two' },
      ],
    });
    await expect(
      reader.scanImportedTransactions({
        startDate: '2026-05-01',
        endDate: '2026-07-31',
        previousWatermark: null,
      }),
    ).rejects.toBeInstanceOf(Error);
    const hidden = await reader.scanImportedTransactions({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      previousWatermark: null,
    });
    expect(hidden.observations[0]).toMatchObject({
      currentCategoryAlias: null,
      currentCategoryName: null,
      currentCategoryStatus: 'unbound',
    });
  });

  it('prepares an exact raw transaction snapshot and resolves only bound category aliases', async () => {
    const { api, reader } = await initializedHarness();
    const scan = await reader.scanImportedTransactions({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      previousWatermark: null,
    });
    const target = scan.observations.find(
      ({ transactionId }) => transactionId === 'transaction-card',
    );
    if (target === undefined) throw new Error('Synthetic target is missing');

    const prepared = await reader.prepareCategorizationUpdate({
      accountAlias: target.accountAlias,
      transactionId: target.transactionId,
      importedId: target.importedId,
      date: target.date,
      amountMinorUnits: target.amountMinorUnits,
      expectedObservationFingerprint: target.observationFingerprint,
      categoryAliases: ['groceries', 'general'],
    });
    const raw = api.transactions.find(({ id }) => id === target.transactionId);
    if (raw === undefined) throw new Error('Synthetic raw target is missing');
    const expectedObservation: ActualTransactionObservationV1 =
      captureActualTransactionObservation(raw as ActualUpdateTransactionRecord);

    expect(prepared).toEqual({
      schemaVersion: 'actual-categorization-update-preparation.v1',
      observed: expectedObservation,
      categories: [
        { alias: 'general', categoryId: 'category-general' },
        { alias: 'groceries', categoryId: 'category-groceries' },
      ],
      freshness: scan.freshness,
    });
    expect(prepared.observed.reconciled).toBe(true);
    expect(prepared.observed.fullFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.observed.preservedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('refuses stale, unsupported, and unbound categorization preparations', async () => {
    const { reader } = await initializedHarness();
    const scan = await reader.scanImportedTransactions({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      previousWatermark: null,
    });
    const card = scan.observations.find(
      ({ transactionId }) => transactionId === 'transaction-card',
    );
    const payment = scan.observations.find(
      ({ transactionId }) => transactionId === 'transaction-transfer',
    );
    if (card === undefined || payment === undefined) {
      throw new Error('Synthetic preparation targets are missing');
    }

    await expect(
      reader.prepareCategorizationUpdate({
        accountAlias: card.accountAlias,
        transactionId: card.transactionId,
        importedId: card.importedId,
        date: card.date,
        amountMinorUnits: card.amountMinorUnits,
        expectedObservationFingerprint: 'd'.repeat(64),
        categoryAliases: ['groceries'],
      }),
    ).rejects.toMatchObject({
      name: 'ActualPrepareCategorizationUpdateRefusedError',
      code: 'target-changed',
    } satisfies Partial<ActualPrepareCategorizationUpdateRefusedError>);

    await expect(
      reader.prepareCategorizationUpdate({
        accountAlias: card.accountAlias,
        transactionId: card.transactionId,
        importedId: card.importedId,
        date: card.date,
        amountMinorUnits: card.amountMinorUnits,
        expectedObservationFingerprint: card.observationFingerprint,
        categoryAliases: ['not-bound'],
      }),
    ).rejects.toMatchObject({
      name: 'ActualPrepareCategorizationUpdateRefusedError',
      code: 'category-not-allowed',
    } satisfies Partial<ActualPrepareCategorizationUpdateRefusedError>);

    await expect(
      reader.prepareCategorizationUpdate({
        accountAlias: payment.accountAlias,
        transactionId: payment.transactionId,
        importedId: payment.importedId,
        date: payment.date,
        amountMinorUnits: payment.amountMinorUnits,
        expectedObservationFingerprint: payment.observationFingerprint,
        categoryAliases: ['groceries'],
      }),
    ).rejects.toMatchObject({
      name: 'ActualPrepareCategorizationUpdateRefusedError',
      code: 'target-unsupported',
    } satisfies Partial<ActualPrepareCategorizationUpdateRefusedError>);
  });

  it('serializes reads and syncs, persists fixed outcomes, and rate-limits bank sync', async () => {
    let now = new Date('2026-07-28T12:00:00.000Z');
    const api = new SyntheticActualReadApi();
    const store = new MemoryFreshnessStore();
    const { reader } = await initializedHarness({
      api,
      store,
      now: () => now,
    });
    api.syncDelayMs = 5;

    await Promise.all([
      reader.catalog(),
      reader.accountBalances({
        accountName: 'Daily Spending',
        asOfDate: '2026-07-28',
      }),
      reader.cashFlow({
        startDate: '2026-07-01',
        endDate: '2026-07-31',
      }),
    ]);
    expect(api.maximumConcurrentSyncs).toBe(1);

    const first = await reader.syncNow();
    expect(first).toMatchObject({
      outcome: 'succeeded',
      freshness: {
        lastAttemptAt: '2026-07-28T12:00:00.000Z',
        lastSuccessfulSyncAt: '2026-07-28T12:00:00.000Z',
        lastOutcome: 'succeeded',
        isFresh: true,
      },
    });
    expect(api.bankSyncCalls).toEqual([
      'account-card',
      'account-cashback',
      'account-daily',
      'account-debt',
    ]);
    expect(store.saves.at(-1)).toMatchObject({
      generation: 1,
      state: 'succeeded',
    });

    expect(await reader.syncNow()).toMatchObject({
      outcome: 'skipped-recent',
      freshness: { lastOutcome: 'skipped-recent' },
    });
    expect(api.bankSyncCalls).toHaveLength(4);

    now = new Date('2026-07-28T12:05:00.000Z');
    api.failBankSyncAccountId = 'account-daily';
    expect(await reader.syncNow()).toMatchObject({
      outcome: 'partial',
      freshness: {
        lastAttemptAt: '2026-07-28T12:05:00.000Z',
        lastSuccessfulSyncAt: '2026-07-28T12:00:00.000Z',
        bankFeedAsOf: '2026-07-28T12:05:00.000Z',
        lastOutcome: 'partial',
        isFresh: true,
        lastAttemptSummary: {
          attemptedAccountCount: 4,
          succeededAccountCount: 3,
          failedAccountCount: 1,
          budgetRefreshSucceeded: true,
        },
      },
    });
    expect(store.saves.at(-1)).toMatchObject({
      generation: 2,
      state: 'partial',
    });
    expect(JSON.stringify(store.state)).not.toContain('account-daily');

    now = new Date('2026-07-28T12:10:00.000Z');
    api.failSync = true;
    expect(await reader.syncNow()).toMatchObject({
      outcome: 'failed',
      freshness: {
        lastOutcome: 'failed',
        bankFeedAsOf: '2026-07-28T12:05:00.000Z',
        lastSuccessfulSyncAt: '2026-07-28T12:00:00.000Z',
        lastAttemptSummary: { budgetRefreshSucceeded: false },
      },
    });
  });

  it('keeps an operation watchdog armed while a serialized Actual call is hung', async () => {
    let releaseSync: (() => void) | undefined;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const api = new SyntheticActualReadApi();
    const originalSync = api.sync.bind(api);
    let hang = false;
    api.sync = async (): Promise<void> => {
      if (hang) {
        await syncGate;
        return;
      }
      await originalSync();
    };
    const clears: Array<ReturnType<typeof vi.fn>> = [];
    const startOperationWatchdog = vi.fn(() => {
      const clear = vi.fn();
      clears.push(clear);
      return clear;
    });
    const { reader } = await initializedHarness({
      api,
      startOperationWatchdog,
    });
    expect(clears.at(-1)).toHaveBeenCalledOnce();

    hang = true;
    const first = reader.catalog();
    await vi.waitFor(() => {
      expect(startOperationWatchdog).toHaveBeenCalledTimes(2);
    });
    expect(clears.at(-1)).not.toHaveBeenCalled();

    const second = reader.catalog();
    await Promise.resolve();
    expect(startOperationWatchdog).toHaveBeenCalledTimes(2);

    releaseSync?.();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect(startOperationWatchdog).toHaveBeenCalledTimes(3);
    expect(clears.at(-1)).toHaveBeenCalledOnce();
  });

  it('recovers an interrupted persisted sync as failed on restart', async () => {
    const store = new MemoryFreshnessStore({
      schemaVersion: 'actual-read-freshness.v2',
      generation: 4,
      state: 'syncing',
      lastAttemptAt: '2026-07-28T11:00:00.000Z',
      lastSuccessfulSyncAt: '2026-07-28T10:00:00.000Z',
      lastAnySuccessfulSyncAt: '2026-07-28T10:00:00.000Z',
      lastAttemptSummary: null,
    });
    const { reader } = await initializedHarness({ store });

    expect(store.state).toMatchObject({ generation: 4, state: 'failed' });
    expect(await reader.catalog()).toMatchObject({
      freshness: {
        lastOutcome: 'failed',
        lastSuccessfulSyncAt: '2026-07-28T10:00:00.000Z',
      },
    });
  });

  it('fails closed when the live active account set drifts from the contract', async () => {
    const api = new SyntheticActualReadApi();
    api.accounts.push({
      id: 'account-unexpected',
      name: 'Unexpected',
      closed: false,
      offbudget: false,
    });
    const { reader } = harness({ api });

    await expect(reader.initialize()).rejects.toBeInstanceOf(
      ActualApiReadConfigurationError,
    );
    expect(api.shutdownCount).toBe(1);
    expect(reader.lifecycleState).toBe('failed');
  });

  it('fails closed when an allowed category no longer has its exact live name', async () => {
    const api = new SyntheticActualReadApi();
    api.categoryGroups[0] = {
      ...api.categoryGroups[0]!,
      categories: api.categoryGroups[0]!.categories!.map((category, index) =>
        index === 0 ? { ...category, name: 'Renamed Groceries' } : category,
      ),
    };
    const { reader } = harness({ api });

    await expect(reader.initialize()).rejects.toBeInstanceOf(
      ActualApiReadConfigurationError,
    );
    expect(reader.lifecycleState).toBe('failed');
  });
});
