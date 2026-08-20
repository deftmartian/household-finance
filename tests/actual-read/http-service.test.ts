import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActualDeterministicTransactionHttpClient,
  ActualReadClientError,
  ActualReadHttpClient,
} from '../../src/actual-read/http-client.js';
import {
  createActualReadHttpServer,
  type ActualReadServiceReportCode,
} from '../../src/actual-read/http-service.js';
import {
  ActualReadProtocolError,
  MAX_ACTUAL_READ_RESPONSE_BYTES,
} from '../../src/actual-read/protocol.js';
import { captureActualTransactionObservation } from '../../src/actual-update/domain.js';
import {
  ActualPrepareCategorizationUpdateRefusedError,
  ActualReadNotFoundError,
  type ActualReadCatalog,
  type ActualReadFreshness,
  type ActualReadServicePort,
} from '../../src/actual-read/port.js';

const preparedObservation = captureActualTransactionObservation({
  id: 'transaction-internal-1',
  account: 'account-daily',
  date: '2026-07-20',
  amount: -2_000,
  imported_id: 'bank-import-internal-1',
  payee: 'payee-market',
  category: 'category-groceries',
  notes: 'weekly groceries',
  cleared: true,
  reconciled: false,
  transfer_id: null,
  is_parent: false,
  is_child: false,
  parent_id: null,
  tombstone: false,
});

const freshness: ActualReadFreshness = {
  actualBudgetAsOf: '2026-07-28T12:00:00.000Z',
  bankFeedAsOf: '2026-07-28T12:00:00.000Z',
  lastAttemptAt: '2026-07-28T12:00:00.000Z',
  lastSuccessfulSyncAt: '2026-07-28T12:00:00.000Z',
  lastOutcome: 'succeeded',
  isFresh: true,
  expectedBankDelayHours: 24,
};

function syntheticReader(
  overrides: Partial<ActualReadServicePort> = {},
): ActualReadServicePort {
  const reader: ActualReadServicePort = {
    catalog: async () => ({
      currency: 'CAD',
      accountNames: ['Daily Spending'],
      categoryNames: ['Groceries'],
      merchantNames: ['Example Market'],
      freshness,
    }),
    accountBalances: async (query) => ({
      ...query,
      accounts: [
        {
          name: 'Daily Spending',
          role: 'spending',
          onBudget: true,
          balanceMinorUnits: 10_000,
        },
      ],
      totalBalanceMinorUnits: 10_000,
      freshness,
    }),
    availableFunds: async (query) => ({
      ...query,
      onBudgetCashMinorUnits: 10_000,
      availableToBudgetMinorUnits: 5_000,
      fundedCategoryBalanceMinorUnits: 5_000,
      upcomingObligationsMinorUnits: 1_000,
      availableFundsMinorUnits: 4_000,
      method: 'actual-envelope-summary',
      freshness,
    }),
    categorySpend: async (query) => ({
      ...query,
      expenseMinorUnits: 2_000,
      refundMinorUnits: 100,
      netSpentMinorUnits: 1_900,
      transactionCount: 2,
      uncategorizedExpenseMinorUnits: 0,
      uncategorizedTransactionCount: 0,
      freshness,
    }),
    merchantSpend: async (query) => ({
      ...query,
      expenseMinorUnits: 2_000,
      refundMinorUnits: 100,
      netSpentMinorUnits: 1_900,
      transactionCount: 2,
      uncategorizedExpenseMinorUnits: 0,
      uncategorizedTransactionCount: 0,
      freshness,
    }),
    income: async (query) => ({
      ...query,
      incomeMinorUnits: 20_000,
      transactionCount: 1,
      freshness,
    }),
    cashFlow: async (query) => ({
      ...query,
      incomeMinorUnits: 20_100,
      spendingMinorUnits: 2_000,
      netCashFlowMinorUnits: 18_100,
      incomeTransactionCount: 2,
      spendingTransactionCount: 2,
      freshness,
    }),
    upcomingBills: async (query) => ({
      ...query,
      bills: [
        {
          name: 'Power',
          dueDate: '2026-08-01',
          amountMinorUnits: 1_000,
          amountCertain: true,
        },
      ],
      freshness,
    }),
    budgetCapacity: async (query) => ({
      ...query,
      toBudgetMinorUnits: 5_000,
      ceilingMinorUnits: 5_000,
      method: 'actual-to-budget-ceiling-only',
      targetCategory: {
        name: query.targetCategoryName,
        budgetedMinorUnits: 2_000,
        spentMinorUnits: 1_000,
        balanceMinorUnits: 1_000,
      },
      freshness,
    }),
    budgetProgress: async (query) => ({
      ...query,
      categories: [
        {
          name: 'Groceries',
          budgetedMinorUnits: 2_000,
          spentMinorUnits: 1_000,
          balanceMinorUnits: 1_000,
          overspentMinorUnits: 0,
        },
      ],
      totalBudgetedMinorUnits: 2_000,
      totalSpentMinorUnits: 1_000,
      totalBalanceMinorUnits: 1_000,
      freshness,
    }),
    overspending: async (query) => ({
      ...query,
      categories: [],
      totalOverspentMinorUnits: 0,
      freshness,
    }),
    transactionExplanation: async (query) => ({
      startDate: query.startDate,
      endDate: query.endDate,
      merchantName: query.merchantName,
      transactions: [
        {
          date: '2026-07-20',
          merchantName: query.merchantName,
          accountName: 'Daily Spending',
          amountMinorUnits: -2_000,
          categoryNames: ['Groceries'],
          split: false,
          cleared: true,
          categorizationEvidence: 'actual-ledger',
        },
      ],
      truncated: false,
      freshness,
    }),
    transactionSearch: async (query) => ({
      ...query,
      transactions: [
        {
          date: '2026-07-20',
          merchantName: 'Example Market',
          accountName: 'Daily Spending',
          amountMinorUnits: -2_000,
          categoryNames: ['Groceries'],
          split: false,
          cleared: true,
          categorizationEvidence: 'actual-ledger',
          kind: 'ordinary',
          memo: 'weekly groceries',
        },
      ],
      matchedTransactionCount: 1,
      expenseMinorUnits: 2_000,
      incomeMinorUnits: 0,
      netCashFlowMinorUnits: -2_000,
      truncated: false,
      freshness,
    }),
    needsCategorization: async (query) => ({
      ...query,
      transactions: [
        {
          date: '2026-07-20',
          merchantName: 'Example Market',
          accountName: 'Daily Spending',
          amountMinorUnits: -2_000,
          cleared: true,
          kind: 'ordinary',
          memo: 'weekly groceries',
        },
      ],
      matchedTransactionCount: 1,
      truncated: false,
      freshness,
    }),
    categoryExplanation: async (query) => ({
      startDate: query.startDate,
      endDate: query.endDate,
      categoryName: query.categoryName,
      netSpentMinorUnits: 1_900,
      transactionCount: 2,
      topContributions: [
        {
          merchantName: 'Example Market',
          netSpentMinorUnits: 1_900,
          transactionCount: 2,
        },
      ],
      categorizationEvidence: [
        { evidence: 'actual-ledger', transactionCount: 2 },
      ],
      truncated: false,
      freshness,
    }),
    searchReceipts: async (query) => ({
      ...query,
      receipts: [],
      matchedReceiptCount: 0,
      truncated: false,
      freshness,
    }),
    scanImportedTransactions: async (query) => ({
      schemaVersion: 'actual-imported-transaction-scan.v1',
      startDate: query.startDate,
      endDate: query.endDate,
      observations: [
        {
          schemaVersion: 'actual-imported-transaction-observation.v1',
          transactionId: 'transaction-internal-1',
          importedId: 'bank-import-internal-1',
          accountAlias: 'daily',
          accountRole: 'spending',
          accountOnBudget: true,
          accountLastFour: '4242',
          date: '2026-07-20',
          amountMinorUnits: -2_000,
          direction: 'expense',
          payeeName: 'Example Market',
          memo: 'weekly groceries',
          currentCategoryAlias: 'groceries',
          currentCategoryName: 'Groceries',
          currentCategoryStatus: 'contract-bound',
          split: false,
          cleared: true,
          specialKind: 'ordinary',
          alreadyLinkedReceipts: [],
          observationFingerprint: 'c'.repeat(64),
        },
      ],
      watermark: 'a'.repeat(64),
      importFreshnessToken: 'b'.repeat(64),
      unchanged: false,
      freshness,
    }),
    candidatesForReceipt: async () => [
      {
        transactionId: 'transaction-internal-1',
        importedId: 'bank-import-internal-1',
        accountAlias: 'daily',
        accountLastFour: '4242',
        postingDate: '2026-07-20',
        payeeName: 'Example Market',
        currency: 'CAD',
        amountMinorUnits: -2_000,
        alreadyLinkedReceipts: [],
      },
    ],
    prepareCategorizationUpdate: async () => ({
      schemaVersion: 'actual-categorization-update-preparation.v1',
      observed: preparedObservation,
      categories: [
        {
          alias: 'groceries',
          categoryId: 'category-groceries',
        },
      ],
      freshness,
    }),
    receiptRecords: async () => ({
      records: [],
      nextAfterNoteId: null,
      truncated: false,
    }),
    syncNow: async () => ({ outcome: 'succeeded', freshness }),
  };
  return Object.assign(reader, overrides);
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function start(
  reader: ActualReadServicePort,
  reportError?: (code: ActualReadServiceReportCode) => void,
): Promise<string> {
  const server = createActualReadHttpServer(reader, {
    ...(reportError === undefined ? {} : { reportError }),
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

async function startRaw(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('Actual read HTTP boundary', () => {
  it('interoperates with the strict typed client across every read operation', async () => {
    const baseUrl = await start(syntheticReader());
    const client = new ActualReadHttpClient({ endpoint: baseUrl });
    const range = { startDate: '2026-07-01', endDate: '2026-07-28' };

    const results = [
      await client.catalog(),
      await client.accountBalances({
        accountName: null,
        asOfDate: '2026-07-28',
      }),
      await client.availableFunds({ asOfDate: '2026-07-28' }),
      await client.categorySpend({
        categoryName: 'Groceries',
        ...range,
      }),
      await client.merchantSpend({
        merchantName: 'Example Market',
        ...range,
      }),
      await client.income(range),
      await client.cashFlow(range),
      await client.upcomingBills({
        fromDate: '2026-07-28',
        throughDate: '2026-08-27',
      }),
      await client.budgetCapacity({
        month: '2026-07',
        targetCategoryName: 'Groceries',
      }),
      await client.budgetProgress({
        month: '2026-07',
        categoryName: null,
      }),
      await client.overspending({ month: '2026-07' }),
      await client.transactionExplanation({
        merchantName: 'Example Market',
        ...range,
        limit: 20,
      }),
      await client.transactionSearch({
        ...range,
        accountName: null,
        merchantName: null,
        categoryName: null,
        absoluteAmountMinorUnits: null,
        kind: 'ordinary',
        direction: 'expense',
        categorization: 'any',
        sort: 'amount-desc',
        limit: 20,
      }),
      await client.needsCategorization({
        ...range,
        sort: 'amount-desc',
        limit: 20,
      }),
      await client.categoryExplanation({
        categoryName: 'Groceries',
        ...range,
        limit: 20,
      }),
      await client.searchReceipts({
        ...range,
        textQuery: 'coffee',
        merchantQuery: null,
        limit: 20,
      }),
      await client.syncNow(),
    ];

    expect(results).toHaveLength(17);
    expect(results.every((result) => 'freshness' in result)).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(
      /(?:account|category|payee|transaction)-id|actualId/u,
    );
  });

  it('negotiates partial-sync freshness without breaking a rolling v1 client', async () => {
    const partialFreshness: ActualReadFreshness = {
      ...freshness,
      lastOutcome: 'partial',
      lastAttemptSummary: {
        attemptedAccountCount: 3,
        succeededAccountCount: 2,
        failedAccountCount: 1,
        budgetRefreshSucceeded: true,
      },
    };
    const baseUrl = await start(
      syntheticReader({
        syncNow: async () => ({
          outcome: 'partial',
          freshness: partialFreshness,
        }),
      }),
    );

    await expect(
      new ActualReadHttpClient({ endpoint: baseUrl }).syncNow(),
    ).resolves.toMatchObject({
      outcome: 'partial',
      freshness: {
        lastOutcome: 'partial',
        lastAttemptSummary: { succeededAccountCount: 2, failedAccountCount: 1 },
      },
    });

    const legacyResponse = await fetch(`${baseUrl}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const legacy = (await legacyResponse.json()) as Record<string, unknown>;
    expect(legacy).toMatchObject({
      outcome: 'failed',
      freshness: { lastOutcome: 'failed' },
    });
    expect(JSON.stringify(legacy)).not.toContain('lastAttemptSummary');
  });

  it('isolates strict identifier-bearing endpoints behind the deterministic client', async () => {
    const baseUrl = await start(syntheticReader());
    const safeClient = new ActualReadHttpClient({ endpoint: baseUrl });
    const deterministicClient = new ActualDeterministicTransactionHttpClient({
      endpoint: baseUrl,
    });

    expect('scanImportedTransactions' in safeClient).toBe(false);
    expect('prepareCategorizationUpdate' in safeClient).toBe(false);
    await expect(
      deterministicClient.scanImportedTransactions({
        startDate: '2026-07-01',
        endDate: '2026-07-28',
        previousWatermark: null,
      }),
    ).resolves.toMatchObject({
      observations: [
        {
          transactionId: 'transaction-internal-1',
          importedId: 'bank-import-internal-1',
          accountAlias: 'daily',
        },
      ],
      unchanged: false,
    });
    await expect(
      deterministicClient.candidatesForReceipt({
        schemaVersion: 'receipt-match-intent.v1',
        receiptId: '8dfc1bd9-e07a-4c62-9d58-9529361536b9',
        merchantName: 'Example Market',
        purchaseDate: '2026-07-20',
        currency: 'CAD',
        totalMinorUnits: 2_000,
        paymentEvidence: { kind: 'masked-card', lastFour: '4242' },
      }),
    ).resolves.toEqual([
      {
        transactionId: 'transaction-internal-1',
        importedId: 'bank-import-internal-1',
        accountAlias: 'daily',
        accountLastFour: '4242',
        postingDate: '2026-07-20',
        payeeName: 'Example Market',
        currency: 'CAD',
        amountMinorUnits: -2_000,
        alreadyLinkedReceipts: [],
      },
    ]);
    await expect(
      deterministicClient.prepareCategorizationUpdate({
        accountAlias: 'daily',
        transactionId: 'transaction-internal-1',
        importedId: 'bank-import-internal-1',
        date: '2026-07-20',
        amountMinorUnits: -2_000,
        expectedObservationFingerprint: 'c'.repeat(64),
        categoryAliases: ['groceries'],
      }),
    ).resolves.toEqual({
      schemaVersion: 'actual-categorization-update-preparation.v1',
      observed: preparedObservation,
      categories: [
        {
          alias: 'groceries',
          categoryId: 'category-groceries',
        },
      ],
      freshness,
    });
    await expect(
      deterministicClient.receiptRecords({
        afterNoteId: null,
        limit: 20,
      }),
    ).resolves.toEqual({
      records: [],
      nextAfterNoteId: null,
      truncated: false,
    });
  });

  it('returns only a fixed refusal code when update preparation conflicts', async () => {
    const reports: ActualReadServiceReportCode[] = [];
    const baseUrl = await start(
      syntheticReader({
        prepareCategorizationUpdate: async () => {
          throw new ActualPrepareCategorizationUpdateRefusedError(
            'target-changed',
          );
        },
      }),
      (code) => reports.push(code),
    );

    const response = await fetch(
      `${baseUrl}/v1/internal/prepare-categorization-update`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountAlias: 'daily',
          transactionId: 'transaction-internal-1',
          importedId: 'bank-import-internal-1',
          date: '2026-07-20',
          amountMinorUnits: -2_000,
          expectedObservationFingerprint: 'c'.repeat(64),
          categoryAliases: ['groceries'],
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'preparation_refused',
      code: 'target-changed',
    });
    expect(reports).toEqual(['preparation_refused']);

    const deterministicClient = new ActualDeterministicTransactionHttpClient({
      endpoint: baseUrl,
    });
    await expect(
      deterministicClient.prepareCategorizationUpdate({
        accountAlias: 'daily',
        transactionId: 'transaction-internal-1',
        importedId: 'bank-import-internal-1',
        date: '2026-07-20',
        amountMinorUnits: -2_000,
        expectedObservationFingerprint: 'c'.repeat(64),
        categoryAliases: ['groceries'],
      }),
    ).rejects.toMatchObject({
      name: 'ActualPrepareCategorizationUpdateRefusedError',
      code: 'target-changed',
    });
  });

  it('rejects expanded requests before invoking the reader', async () => {
    const categorySpend = vi.fn(syntheticReader().categorySpend);
    const reports: ActualReadServiceReportCode[] = [];
    const baseUrl = await start(syntheticReader({ categorySpend }), (code) =>
      reports.push(code),
    );

    const response = await fetch(`${baseUrl}/v1/category-spend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        categoryName: 'Groceries',
        startDate: '2026-07-01',
        endDate: '2026-07-28',
        actualAccountId: 'must-not-cross',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(categorySpend).not.toHaveBeenCalled();
    expect(reports).toEqual(['invalid_request']);
  });

  it('preserves invalid query responses for an in-turn model retry', async () => {
    const reports: ActualReadServiceReportCode[] = [];
    const baseUrl = await start(
      syntheticReader({
        transactionSearch: async () => {
          throw new ActualReadProtocolError();
        },
      }),
      (code) => reports.push(code),
    );
    const client = new ActualReadHttpClient({ endpoint: baseUrl });

    await expect(
      client.transactionSearch({
        startDate: '2025-07-30',
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
    ).rejects.toBeInstanceOf(ActualReadProtocolError);
    expect(reports).toEqual(['invalid_request']);
  });

  it('preserves safe not-found responses for an in-turn model correction', async () => {
    const reports: ActualReadServiceReportCode[] = [];
    const baseUrl = await start(
      syntheticReader({
        merchantSpend: async () => {
          throw new ActualReadNotFoundError('merchant');
        },
      }),
      (code) => reports.push(code),
    );
    const client = new ActualReadHttpClient({ endpoint: baseUrl });

    await expect(
      client.merchantSpend({
        merchantName: 'Missing Merchant',
        startDate: '2026-07-01',
        endDate: '2026-07-30',
      }),
    ).rejects.toMatchObject({
      name: 'ActualReadNotFoundError',
      kind: 'merchant',
    });
    expect(reports).toEqual(['not_found']);
  });

  it('fails closed when an adapter attempts to expand an output with an ID', async () => {
    const reports: ActualReadServiceReportCode[] = [];
    const catalog = vi.fn(async () => {
      const expanded = {
        ...(await syntheticReader().catalog()),
        actualBudgetId: 'must-not-cross',
      };
      return expanded as ActualReadCatalog;
    });
    const baseUrl = await start(syntheticReader({ catalog }), (code) =>
      reports.push(code),
    );

    const response = await fetch(`${baseUrl}/v1/catalog`);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe('{"error":"data_contract_failed"}');
    expect(body).not.toContain('must-not-cross');
    expect(reports).toEqual(['data_contract_failed']);
  });

  it('rejects remote-looking or credential-bearing client endpoints', () => {
    expect(
      () =>
        new ActualReadHttpClient({
          endpoint: 'https://actual-reader.example.test',
        }),
    ).toThrow(ActualReadClientError);
    expect(
      () =>
        new ActualReadHttpClient({
          endpoint: 'http://user:secret@actual-reader:4370',
        }),
    ).toThrow(ActualReadClientError);
  });

  it('refuses redirects in both Actual read clients', async () => {
    const followedPaths: string[] = [];
    const baseUrl = await startRaw((request, response) => {
      if (request.url === '/followed') {
        followedPaths.push(request.url);
        response.statusCode = 200;
        response.end('{}');
        return;
      }
      response.statusCode = 302;
      response.setHeader('location', '/followed');
      response.end();
    });
    const safeClient = new ActualReadHttpClient({ endpoint: baseUrl });
    const deterministicClient = new ActualDeterministicTransactionHttpClient({
      endpoint: baseUrl,
    });

    await expect(safeClient.catalog()).rejects.toMatchObject({
      code: 'request-failed',
    });
    await expect(
      deterministicClient.receiptRecords({
        afterNoteId: null,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'request-failed' });
    expect(followedPaths).toEqual([]);
  });

  it('keeps each client timeout active while the response body is delayed', async () => {
    const catalogBody = JSON.stringify(await syntheticReader().catalog());
    const receiptRecordsBody = JSON.stringify({
      records: [],
      nextAfterNoteId: null,
      truncated: false,
    });
    const baseUrl = await startRaw((request, response) => {
      const body =
        request.url === '/v1/catalog' ? catalogBody : receiptRecordsBody;
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.flushHeaders();
      setTimeout(() => response.end(body), 250);
    });
    const safeClient = new ActualReadHttpClient({
      endpoint: baseUrl,
      timeoutMs: 100,
    });
    const deterministicClient = new ActualDeterministicTransactionHttpClient({
      endpoint: baseUrl,
      timeoutMs: 100,
    });

    const results = await Promise.allSettled([
      safeClient.catalog(),
      deterministicClient.receiptRecords({
        afterNoteId: null,
        limit: 20,
      }),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'request-failed' });
      }
    }
  });

  it('cancels unread response bodies when validation fails', async () => {
    const cancellations: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancellations.push(path);
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': '2',
          },
        },
      );
    });
    const safeClient = new ActualReadHttpClient({
      endpoint: 'http://actual-reader:4370',
      fetchImplementation,
    });
    const deterministicClient = new ActualDeterministicTransactionHttpClient({
      endpoint: 'http://actual-reader:4370',
      fetchImplementation,
    });

    await expect(safeClient.catalog()).rejects.toMatchObject({
      code: 'response-invalid',
    });
    await expect(
      deterministicClient.receiptRecords({
        afterNoteId: null,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'response-invalid' });
    expect(cancellations).toEqual([
      '/v1/catalog',
      '/v1/internal/receipt-records',
    ]);
    expect(
      fetchImplementation.mock.calls.every(
        ([, init]) =>
          init?.redirect === 'error' &&
          new Headers(init.headers).get('x-household-finance-read-version') ===
            '2',
      ),
    ).toBe(true);
  });

  it('bounds the streamed body even when its declared length is small', async () => {
    const cancel = vi.fn();
    const oversizedChunk = new Uint8Array(MAX_ACTUAL_READ_RESPONSE_BYTES + 1);
    const client = new ActualReadHttpClient({
      endpoint: 'http://actual-reader:4370',
      fetchImplementation: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(oversizedChunk),
            cancel,
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-length': '2',
            },
          },
        ),
    });

    await expect(client.catalog()).rejects.toMatchObject({
      code: 'response-invalid',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
