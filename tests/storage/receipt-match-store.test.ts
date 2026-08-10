import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  matchReceiptToImportedTransactions,
  type ImportedTransactionCandidate,
} from '../../src/matching/receipt-transaction.js';
import {
  ReceiptMatchIgnoredError,
  ReceiptMatchStore,
  ReceiptMatchStoreBusyError,
  ReceiptMatchStoreConflictError,
  type ReceiptMatchIntakeInput,
} from '../../src/storage/receipt-match-store.js';

const receiptOne = '11111111-1111-4111-8111-111111111111';
const receiptTwo = '22222222-2222-4222-8222-222222222222';
const start = '2026-07-28T01:00:00.000Z';
const expiry = '2026-08-06T00:00:00.000Z';
const linkedSource = (receiptId: string) => ({
  receiptId,
  sourceSha256: 'a'.repeat(64),
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'receipt-match-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'finance.sqlite');
}

function intake(
  receiptId = receiptOne,
  idempotencyKey = `receipt-match:${receiptId}`,
): ReceiptMatchIntakeInput {
  return {
    idempotencyKey,
    intent: {
      schemaVersion: 'receipt-match-intent.v1',
      receiptId,
      merchantName: 'Example Market',
      purchaseDate: '2026-07-27',
      currency: 'CAD',
      totalMinorUnits: 1_725,
      paymentEvidence: { kind: 'masked-card', lastFour: '1234' },
    },
    receivedAt: start,
  };
}

function candidate(
  suffix = 'one',
  overrides: Partial<ImportedTransactionCandidate> = {},
): ImportedTransactionCandidate {
  return {
    transactionId: `actual-transaction-${suffix}`,
    importedId: `bank-import-${suffix}`,
    accountAlias: `card-${suffix}`,
    accountLastFour: '1234',
    postingDate: '2026-07-28',
    payeeName: 'Example Market',
    currency: 'CAD',
    amountMinorUnits: -1_725,
    alreadyLinkedReceipts: [],
    ...overrides,
  };
}

function claimedMatch(store: ReceiptMatchStore, receiptId = receiptOne) {
  const job = store.claimNextDueMatch(start);
  expect(job).toMatchObject({
    kind: 'match-receipt',
    receiptId,
    attemptCount: 1,
  });
  if (job === undefined) {
    throw new Error('Expected a claimed receipt match');
  }
  return job;
}

function matchReceipt(
  store: ReceiptMatchStore,
  receiptId = receiptOne,
  importedCandidate = candidate(),
) {
  const job = claimedMatch(store, receiptId);
  const result = store.recordMatchedSet(
    job.id,
    receiptId,
    [importedCandidate],
    132,
    start,
  );
  expect(result.inserted).toBe(true);
  return { job, link: result.links[0]! };
}

describe('ReceiptMatchStore intake and scheduling', () => {
  it('indexes the terminal Talk outcome anti-join', () => {
    const path = databasePath();
    const store = new ReceiptMatchStore(path);
    const observer = new Database(path, { readonly: true });
    try {
      expect(
        observer
          .prepare(
            `SELECT name
               FROM sqlite_master
              WHERE type = 'index'
                AND name = 'receipt_match_audit_receipt_action'`,
          )
          .get(),
      ).toEqual({ name: 'receipt_match_audit_receipt_action' });
    } finally {
      observer.close();
      store.close();
    }
  });

  it('records one awaiting lifecycle and one due match job idempotently', () => {
    const store = new ReceiptMatchStore(':memory:');

    const first = store.recordReceipt(intake());
    const duplicate = store.recordReceipt(intake());

    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({ receipt: first.receipt, inserted: false });
    expect(first.receipt).toMatchObject({
      receiptId: receiptOne,
      status: 'awaiting-bank-transaction',
      expiresAt: expiry,
      matchAttemptCount: 0,
      nextMatchAt: start,
    });
    expect(store.pendingReceiptSummary(start)).toEqual({
      count: 1,
      totalMinorUnits: 1_725,
    });
    expect(claimedMatch(store)).toMatchObject({ attemptCount: 1 });
    expect(store.claimNextDueMatch(start)).toBeUndefined();

    expect(() =>
      store.recordReceipt({
        ...intake(),
        intent: { ...intake().intent, merchantName: 'Different Market' },
      }),
    ).toThrowError(ReceiptMatchStoreConflictError);
    expect(() =>
      store.recordReceipt(intake(receiptOne, 'another-idempotency-key')),
    ).toThrowError(ReceiptMatchStoreBusyError);
    store.close();
  });

  it('retries a revised receipt now without extending its posting window', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    const matchRequestedAt = '2026-07-29T01:00:00.000Z';
    const revision = store.recordReceipt({
      ...intake(receiptOne, 'receipt-source-sha256:revision-two'),
      intent: {
        ...intake().intent,
        merchantName: 'Corrected Market',
        totalMinorUnits: 2_000,
      },
      matchRequestedAt,
    });

    expect(revision).toMatchObject({
      inserted: true,
      receipt: {
        idempotencyKey: 'receipt-source-sha256:revision-two',
        status: 'awaiting-bank-transaction',
        expiresAt: expiry,
        matchAttemptCount: 0,
        nextMatchAt: matchRequestedAt,
        intent: {
          merchantName: 'Corrected Market',
          totalMinorUnits: 2_000,
        },
      },
    });
    expect(store.claimNextDueMatch(matchRequestedAt)).toMatchObject({
      receiptId: receiptOne,
      attemptCount: 1,
    });
    expect(store.listAudit(receiptOne).map((event) => event.action)).toContain(
      'receipt-match.intake-revised',
    );
    store.close();
  });

  it('lets a newer canonical revision supersede a provisional match', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    matchReceipt(store);

    expect(
      store.recordReceipt({
        ...intake(receiptOne, 'receipt-source-sha256:revision-two'),
        intent: {
          ...intake().intent,
          merchantName: 'Corrected Market',
        },
        matchRequestedAt: '2026-07-29T01:00:00.000Z',
      }),
    ).toMatchObject({ inserted: true });
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'awaiting-bank-transaction',
      intent: { merchantName: 'Corrected Market' },
    });
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([]);
    store.close();
  });

  it('accepts a revision after a processing provisional apply is freshness-deferred', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    matchReceipt(store);
    const apply = store.claimNextDueApply(start)!;
    const revision = {
      ...intake(receiptOne, 'receipt-source-sha256:revision-two'),
      intent: {
        ...intake().intent,
        merchantName: 'Corrected Market',
      },
      matchRequestedAt: '2026-07-29T01:00:00.000Z',
    };
    expect(() => store.recordReceipt(revision)).toThrowError(
      ReceiptMatchStoreBusyError,
    );

    store.deferApply(
      apply.id,
      receiptOne,
      '2026-07-28T01:01:00.000Z',
      start,
      'canonical-receipt-not-ready',
    );
    expect(store.recordReceipt(revision)).toMatchObject({ inserted: true });
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'awaiting-bank-transaction',
      intent: { merchantName: 'Corrected Market' },
    });
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([]);
    store.close();
  });

  it('requires review when a revision arrives after its Actual update completed', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    matchReceipt(store);
    const apply = store.claimNextDueApply(start)!;
    store.markApplied(apply.id, receiptOne, start);

    expect(() =>
      store.recordReceipt({
        ...intake(receiptOne, 'receipt-source-sha256:revision-two'),
        intent: {
          ...intake().intent,
          merchantName: 'Corrected Market',
        },
        matchRequestedAt: '2026-07-29T01:00:00.000Z',
      }),
    ).toThrowError(ReceiptMatchStoreConflictError);
    expect(store.getReceipt(receiptOne)).toMatchObject({ status: 'applied' });
    store.close();
  });

  it('persists an ignore tombstone before intake and rejects later receipt recording', () => {
    const store = new ReceiptMatchStore(':memory:');
    const ignore = {
      receiptId: receiptOne,
      actorId: 'alex',
      inboundMessageId: 'ignore-message-1',
      ignoredAt: start,
    };

    expect(store.ignoreReceipt(ignore)).toEqual({ status: 'ignored' });
    expect(store.ignoreReceipt(ignore)).toEqual({
      status: 'already-ignored',
    });
    expect(store.isReceiptIgnored(receiptOne)).toBe(true);
    expect(() => store.recordReceipt(intake())).toThrowError(
      ReceiptMatchIgnoredError,
    );
    expect(store.getReceipt(receiptOne)).toBeUndefined();
    expect(store.pendingReceiptSummary(start)).toEqual({
      count: 0,
      totalMinorUnits: 0,
    });
    expect(store.claimNextDueMatch(start)).toBeUndefined();
    store.close();
  });

  it('filters an ignored awaiting receipt from summaries, details, and due work', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    store.recordReceipt(intake(receiptTwo));

    expect(
      store.ignoreReceipt({
        receiptId: receiptOne,
        actorId: 'alex',
        inboundMessageId: 'ignore-message-1',
        ignoredAt: start,
      }),
    ).toEqual({ status: 'ignored' });

    expect(store.pendingReceiptSummary(start)).toEqual({
      count: 1,
      totalMinorUnits: 1_725,
    });
    expect(store.listAwaitingReceiptDetails(10, start)).toEqual([
      expect.objectContaining({ receiptId: receiptTwo }),
    ]);
    expect(store.claimNextDueMatch(start)).toMatchObject({
      receiptId: receiptTwo,
    });
    expect(store.listAudit(receiptOne).map((event) => event.action)).toContain(
      'receipt-match.ignored',
    );
    store.close();
  });

  it('returns bounded deterministic pending details without payment evidence', () => {
    const store = new ReceiptMatchStore(':memory:');
    const receiptIds = Array.from(
      { length: 11 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    for (const [index, receiptId] of [...receiptIds].reverse().entries()) {
      store.recordReceipt({
        ...intake(receiptId),
        intent: {
          ...intake(receiptId).intent,
          merchantName: `Example Market ${String(11 - index)}`,
          currency: receiptId === receiptIds[0] ? 'USD' : 'CAD',
        },
      });
    }

    const details = store.listAwaitingReceiptDetails(10, start);

    expect(details).toHaveLength(10);
    expect(details[0]).toEqual({
      receiptId: receiptIds[0],
      merchantName: 'Example Market 1',
      purchaseDate: '2026-07-27',
      currency: 'USD',
      totalMinorUnits: 1_725,
    });
    expect(details.at(-1)?.receiptId).toBe(receiptIds[9]);
    for (const detail of details) {
      expect(detail).not.toHaveProperty('paymentEvidence');
      expect(detail).not.toHaveProperty('idempotencyKey');
    }
    expect(() => store.listAwaitingReceiptDetails(0)).toThrowError(RangeError);
    expect(() => store.listAwaitingReceiptDetails(101)).toThrowError(
      RangeError,
    );
    store.close();
  });

  it('reserves a conservative CAD ceiling while a foreign receipt awaits its posted charge', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt({
      ...intake(),
      intent: { ...intake().intent, currency: 'USD', totalMinorUnits: 1_725 },
    });

    expect(store.pendingReceiptSummary(start)).toEqual({
      count: 1,
      totalMinorUnits: 5_175,
    });
    const importedCandidate = candidate('foreign', {
      amountMinorUnits: -2_341,
    });
    const { link } = matchReceipt(store, receiptOne, importedCandidate);

    expect(link).toMatchObject({
      receiptId: receiptOne,
      importedId: 'bank-import-foreign',
    });
    expect(store.getReceipt(receiptOne)).toMatchObject({ status: 'matched' });
    store.close();
  });

  it('rejects non-canonical intake identifiers and impossible timestamps before persistence', () => {
    const store = new ReceiptMatchStore(':memory:');

    expect(() =>
      store.recordReceipt({
        ...intake(),
        idempotencyKey: 'receipt-match:\nunsafe',
      }),
    ).toThrowError(RangeError);
    expect(() =>
      store.recordReceipt({
        ...intake(),
        receivedAt: '2026-02-30T01:00:00.000Z',
      }),
    ).toThrowError(TypeError);
    expect(store.getReceipt(receiptOne)).toBeUndefined();
    expect(store.claimNextDueMatch(start)).toBeUndefined();
    store.close();
  });

  it('uses a bounded schedule and wakes future matches after a ledger refresh', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    const first = claimedMatch(store);

    const retry = store.rescheduleAwaitingMatch(first.id, receiptOne, start);
    expect(retry).toEqual({
      status: 'awaiting-bank-transaction',
      nextMatchAt: '2026-07-28T01:05:00.000Z',
    });
    expect(store.claimNextDueMatch(start)).toBeUndefined();

    const ledgerRefreshAt = '2026-07-28T01:01:00.000Z';
    expect(store.wakeAllPendingAfterLedgerRefresh(ledgerRefreshAt)).toBe(1);
    expect(store.wakeAllPendingAfterLedgerRefresh(ledgerRefreshAt)).toBe(0);
    expect(store.claimNextDueMatch(ledgerRefreshAt)).toMatchObject({
      receiptId: receiptOne,
      attemptCount: 1,
    });
    expect(store.getReceipt(receiptOne)).toMatchObject({
      matchAttemptCount: 1,
    });
    store.close();
  });

  it('keeps more than twenty successful no-candidate bank-sync checks open until the seven-day expiry', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    let now = new Date(start);

    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (attempt > 0) {
        store.wakeAllPendingAfterLedgerRefresh(now.toISOString());
      }
      const job = store.claimNextDueMatch(now.toISOString());
      expect(job).toMatchObject({
        receiptId: receiptOne,
        attemptCount: 1,
      });
      expect(
        store.rescheduleAwaitingMatch(
          job?.id ?? -1,
          receiptOne,
          now.toISOString(),
        ),
      ).toMatchObject({ status: 'awaiting-bank-transaction' });
      now = new Date(now.valueOf() + 4 * 60 * 60 * 1_000);
    }

    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'awaiting-bank-transaction',
      matchAttemptCount: 20,
    });
    const finalWindowCheck = store.claimNextDueMatch(expiry);
    expect(finalWindowCheck).toMatchObject({ receiptId: receiptOne });
    expect(
      store.rescheduleAwaitingMatch(
        finalWindowCheck?.id ?? -1,
        receiptOne,
        expiry,
      ),
    ).toEqual({
      status: 'attention',
      reason: 'bank-transaction-not-found',
    });
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'attention',
      attentionReason: 'bank-transaction-not-found',
    });
    store.close();
  });

  it('stays pending through two import-grace days and allows one final due match', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());

    expect(store.pendingReceiptSummary('2026-08-05T23:59:59.999Z')).toEqual({
      count: 1,
      totalMinorUnits: 1_725,
    });
    expect(store.pendingReceiptSummary(expiry)).toEqual({
      count: 0,
      totalMinorUnits: 0,
    });
    expect(store.listAwaitingReceiptDetails(10, expiry)).toEqual([]);
    const finalWindowCheck = store.claimNextDueMatch(expiry);
    expect(finalWindowCheck).toMatchObject({ receiptId: receiptOne });
    expect(
      store.rescheduleAwaitingMatch(
        finalWindowCheck?.id ?? -1,
        receiptOne,
        expiry,
      ),
    ).toEqual({
      status: 'attention',
      reason: 'bank-transaction-not-found',
    });
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'attention',
      attentionReason: 'bank-transaction-not-found',
      expiresAt: expiry,
      matchAttemptCount: 0,
    });
    expect(store.listAudit(receiptOne).map((event) => event.action)).toEqual([
      'receipt-match.intake-recorded',
      'receipt-match.attempt-claimed',
      'receipt-match.attention-required',
    ]);
    store.close();
  });

  it('gives a historical replay one immediate check without reporting it as pending', () => {
    const store = new ReceiptMatchStore(':memory:');
    const replayedAt = '2026-08-20T12:00:00.000Z';
    const recorded = store.recordReceipt({
      ...intake(),
      receivedAt: start,
      matchRequestedAt: replayedAt,
    });

    expect(recorded.receipt).toMatchObject({
      status: 'awaiting-bank-transaction',
      expiresAt: expiry,
      nextMatchAt: replayedAt,
    });
    expect(store.pendingReceiptSummary(replayedAt)).toEqual({
      count: 0,
      totalMinorUnits: 0,
    });
    expect(store.listAwaitingReceiptDetails(10, replayedAt)).toEqual([]);

    const immediateCheck = store.claimNextDueMatch(replayedAt);
    expect(immediateCheck).toMatchObject({
      receiptId: receiptOne,
      attemptCount: 1,
    });
    expect(
      store.rescheduleAwaitingMatch(
        immediateCheck?.id ?? -1,
        receiptOne,
        replayedAt,
      ),
    ).toEqual({
      status: 'attention',
      reason: 'bank-transaction-not-found',
    });
    store.close();
  });

  it('gives an implausible future purchase date one immediate check without extending the queue', () => {
    const store = new ReceiptMatchStore(':memory:');
    const recorded = store.recordReceipt({
      ...intake(),
      intent: { ...intake().intent, purchaseDate: '2029-07-28' },
    });

    expect(recorded.receipt).toMatchObject({
      status: 'awaiting-bank-transaction',
      expiresAt: start,
      nextMatchAt: start,
    });
    expect(store.pendingReceiptSummary(start)).toEqual({
      count: 0,
      totalMinorUnits: 0,
    });
    const immediateCheck = store.claimNextDueMatch(start);
    expect(immediateCheck).toMatchObject({ receiptId: receiptOne });
    expect(
      store.rescheduleAwaitingMatch(
        immediateCheck?.id ?? -1,
        receiptOne,
        start,
      ),
    ).toEqual({
      status: 'attention',
      reason: 'bank-transaction-not-found',
    });
    store.close();
  });

  it('keeps retries bounded by the posting and import-grace window', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    let now = start;
    let attempts = 0;

    while (true) {
      const job = store.claimNextDueMatch(now);
      if (job === undefined) {
        break;
      }
      attempts += 1;
      const result = store.rescheduleAwaitingMatch(job.id, receiptOne, now);
      if (result.status === 'attention') {
        break;
      }
      expect(result.nextMatchAt <= expiry).toBe(true);
      now = result.nextMatchAt;
    }

    expect(attempts).toBe(14);
    expect(now).toBe(expiry);
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'attention',
      attentionReason: 'bank-transaction-not-found',
      matchAttemptCount: 13,
    });
    expect(store.claimNextDueMatch(expiry)).toBeUndefined();
    store.close();
  });

  it('recovers an interrupted due-match claim across a process restart', () => {
    const path = databasePath();
    const firstProcess = new ReceiptMatchStore(path);
    firstProcess.recordReceipt(intake());
    claimedMatch(firstProcess);
    firstProcess.close();

    const secondProcess = new ReceiptMatchStore(path);
    expect(
      secondProcess.recoverInterruptedOutbox('2026-07-28T01:02:00.000Z'),
    ).toBe(1);
    expect(
      secondProcess.claimNextDueMatch('2026-07-28T01:02:00.000Z'),
    ).toMatchObject({
      receiptId: receiptOne,
      attemptCount: 2,
    });
    expect(secondProcess.recordReceipt(intake()).inserted).toBe(false);
    expect(
      secondProcess.listAudit(receiptOne).map((event) => event.action),
    ).toContain('receipt-match.outbox-recovered');
    secondProcess.close();
  });

  it('moves a manual cash receipt to attention without creating a link or apply job', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt({
      ...intake(),
      intent: {
        ...intake().intent,
        paymentEvidence: { kind: 'cash' },
      },
    });
    const job = claimedMatch(store);

    expect(
      store.markAttention(job.id, receiptOne, 'cash', start),
    ).toMatchObject({
      status: 'attention',
      attentionReason: 'cash',
    });
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([]);
    expect(store.claimNextDueApply(start)).toBeUndefined();
    store.close();
  });
});

describe('ReceiptMatchStore links and application', () => {
  it('persists an exact multi-charge match as one deterministic immutable set', () => {
    const store = new ReceiptMatchStore(':memory:');
    const candidates = [
      candidate('part-one', {
        accountAlias: 'active-mastercard',
        importedId: 'bank-import-part-one',
        transactionId: 'actual-transaction-part-one',
        amountMinorUnits: -600,
      }),
      candidate('part-two', {
        accountAlias: 'active-mastercard',
        importedId: 'bank-import-part-two',
        transactionId: 'actual-transaction-part-two',
        amountMinorUnits: -1_125,
      }),
    ];
    store.recordReceipt(intake());
    const job = claimedMatch(store);
    const deterministic = matchReceiptToImportedTransactions(
      intake().intent,
      candidates,
    );
    if (deterministic.disposition !== 'matched-set') {
      throw new Error('Expected an exact multi-charge match');
    }

    const recorded = store.recordMatchedSet(
      job.id,
      receiptOne,
      candidates,
      deterministic.score,
      start,
    );

    expect(recorded.inserted).toBe(true);
    expect(recorded.links).toHaveLength(2);
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual(
      recorded.links,
    );
    expect(
      store.recordMatchedSet(
        job.id,
        receiptOne,
        [...candidates].reverse(),
        deterministic.score,
        start,
      ),
    ).toEqual({ links: recorded.links, inserted: false });
    expect(store.getReceipt(receiptOne)).toMatchObject({ status: 'matched' });
    expect(store.claimNextDueApply(start)).toMatchObject({
      receiptId: receiptOne,
    });
    store.close();
  });

  it('can rebuild several receipt links already represented on one Actual transaction', () => {
    const store = new ReceiptMatchStore(':memory:');
    const shared = candidate('shared', {
      accountAlias: 'active-mastercard',
      alreadyLinkedReceipts: [
        linkedSource(receiptOne),
        linkedSource(receiptTwo),
      ],
    });
    store.recordReceipt(intake());
    store.recordReceipt(intake(receiptTwo));
    const firstJob = store.claimNextDueMatch(start)!;
    const secondJob = store.claimNextDueMatch(start)!;
    for (const [job, receiptId] of [
      [firstJob, receiptOne],
      [secondJob, receiptTwo],
    ] as const) {
      const deterministic = matchReceiptToImportedTransactions(
        intake(receiptId).intent,
        [shared],
      );
      if (deterministic.disposition !== 'matched') {
        throw new Error('Expected an idempotent existing receipt link');
      }
      store.recordMatchedSet(
        job.id,
        receiptId,
        [shared],
        deterministic.score,
        start,
      );
    }

    expect(store.getImportedTransactionLinks(receiptOne)).toHaveLength(1);
    expect(store.getImportedTransactionLinks(receiptTwo)).toHaveLength(1);
    store.close();
  });

  it('rejects conflicting imported identity for a shared tokened transaction', () => {
    const store = new ReceiptMatchStore(':memory:');
    const shared = candidate('shared-identity', {
      accountAlias: 'active-mastercard',
      alreadyLinkedReceipts: [
        linkedSource(receiptOne),
        linkedSource(receiptTwo),
      ],
    });
    store.recordReceipt(intake());
    store.recordReceipt(intake(receiptTwo));
    const firstJob = store.claimNextDueMatch(start)!;
    const secondJob = store.claimNextDueMatch(start)!;
    const first = matchReceiptToImportedTransactions(intake().intent, [shared]);
    if (first.disposition !== 'matched') {
      throw new Error('Expected the first existing receipt link');
    }
    store.recordMatchedSet(
      firstJob.id,
      receiptOne,
      [shared],
      first.score,
      start,
    );
    const conflicting = {
      ...shared,
      importedId: 'different-imported-identity',
    };
    const second = matchReceiptToImportedTransactions(
      intake(receiptTwo).intent,
      [conflicting],
    );
    if (second.disposition !== 'matched') {
      throw new Error('Expected a deterministic conflicting candidate');
    }

    expect(() =>
      store.recordMatchedSet(
        secondJob.id,
        receiptTwo,
        [conflicting],
        second.score,
        start,
      ),
    ).toThrowError(ReceiptMatchStoreConflictError);
    expect(store.getImportedTransactionLinks(receiptTwo)).toEqual([]);
    store.close();
  });

  it('refuses to persist a candidate that deterministic matching would reject', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    const match = claimedMatch(store);

    expect(() =>
      store.recordMatchedSet(
        match.id,
        receiptOne,
        [candidate('wrong', { postingDate: '2026-08-20' })],
        132,
        start,
      ),
    ).toThrowError(ReceiptMatchStoreConflictError);
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'awaiting-bank-transaction',
    });
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([]);
    expect(
      store.rescheduleAwaitingMatch(match.id, receiptOne, start),
    ).toMatchObject({
      status: 'awaiting-bank-transaction',
    });
    store.close();
  });

  it('atomically links an existing imported transaction, queues apply, and reaches applied', () => {
    const store = new ReceiptMatchStore(':memory:');
    const importedCandidate = candidate();
    store.recordReceipt(intake());
    const { job, link } = matchReceipt(store, receiptOne, importedCandidate);

    expect(link).toEqual({
      receiptId: receiptOne,
      transactionId: importedCandidate.transactionId,
      importedId: importedCandidate.importedId,
      accountAlias: importedCandidate.accountAlias,
      linkedAt: start,
    });
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'matched',
      matchedAt: start,
    });
    expect(store.pendingReceiptSummary(start)).toEqual({
      count: 0,
      totalMinorUnits: 0,
    });
    expect(store.listAwaitingReceiptDetails(10, start)).toEqual([]);
    expect(
      store.recordMatchedSet(
        job.id,
        receiptOne,
        [importedCandidate],
        132,
        start,
      ),
    ).toEqual({ links: [link], inserted: false });

    const apply = store.claimNextDueApply(start);
    expect(apply).toMatchObject({
      kind: 'apply-receipt-match',
      receiptId: receiptOne,
      attemptCount: 1,
    });
    expect(store.markApplied(apply?.id ?? -1, receiptOne, start)).toMatchObject(
      {
        status: 'applied',
        appliedAt: start,
      },
    );
    expect(store.markApplied(apply?.id ?? -1, receiptOne, start)).toMatchObject(
      {
        status: 'applied',
      },
    );
    const outcome = store.listUnnotifiedTalkOutcomes()[0];
    expect(outcome).toMatchObject({
      receipt: { receiptId: receiptOne, status: 'applied' },
    });
    expect(
      store.recordTalkOutcomeDelivered({
        receiptId: receiptOne,
        status: 'applied',
        referenceId: outcome?.referenceId ?? '',
        deliveredAt: start,
      }),
    ).toBe(true);
    expect(
      store.recordTalkOutcomeDelivered({
        receiptId: receiptOne,
        status: 'applied',
        referenceId: outcome?.referenceId ?? '',
        deliveredAt: start,
      }),
    ).toBe(false);
    expect(store.listUnnotifiedTalkOutcomes()).toEqual([]);
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([link]);
    expect(store.claimNextDueApply(start)).toBeUndefined();
    store.close();
  });

  it('refuses to promise cancellation once a matched receipt may have queued an Actual update', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    const { link } = matchReceipt(store);
    const apply = store.claimNextDueApply(start);
    store.deferApply(
      apply?.id ?? -1,
      receiptOne,
      '2026-07-28T01:01:00.000Z',
      start,
    );
    expect(
      store.isImportedTransactionReserved('card-one', 'bank-import-one'),
    ).toBe(true);

    expect(
      store.ignoreReceipt({
        receiptId: receiptOne,
        actorId: 'alex',
        inboundMessageId: 'ignore-message-1',
        ignoredAt: start,
      }),
    ).toEqual({ status: 'still-processing' });
    expect(store.isReceiptIgnored(receiptOne)).toBe(false);
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([link]);
    expect(store.claimNextDueApply('2026-07-28T01:01:00.000Z')).toBeDefined();
    expect(
      store.isImportedTransactionReserved('card-one', 'bank-import-one'),
    ).toBe(true);
    store.close();
  });

  it('refuses to ignore a receipt after it updated Actual', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    matchReceipt(store);
    const apply = store.claimNextDueApply(start);
    store.markApplied(apply?.id ?? -1, receiptOne, start);

    expect(
      store.ignoreReceipt({
        receiptId: receiptOne,
        actorId: 'alex',
        inboundMessageId: 'ignore-message-applied',
        ignoredAt: start,
      }),
    ).toEqual({ status: 'already-applied' });
    expect(store.isReceiptIgnored(receiptOne)).toBe(false);
    store.close();
  });

  it('rolls back a conflicting second link and preserves the first immutable owner', () => {
    const store = new ReceiptMatchStore(':memory:');
    const importedCandidate = candidate();
    store.recordReceipt(intake());
    store.recordReceipt(intake(receiptTwo));
    const firstJob = store.claimNextDueMatch(start);
    const secondJob = store.claimNextDueMatch(start);
    expect(firstJob?.receiptId).toBe(receiptOne);
    expect(secondJob?.receiptId).toBe(receiptTwo);
    store.recordMatchedSet(
      firstJob?.id ?? -1,
      receiptOne,
      [importedCandidate],
      132,
      start,
    );

    expect(() =>
      store.recordMatchedSet(
        secondJob?.id ?? -1,
        receiptTwo,
        [importedCandidate],
        132,
        start,
      ),
    ).toThrowError(ReceiptMatchStoreConflictError);
    expect(store.getReceipt(receiptTwo)).toMatchObject({
      status: 'awaiting-bank-transaction',
    });
    expect(store.getImportedTransactionLinks(receiptTwo)).toEqual([]);
    expect(
      store.markAttention(
        secondJob?.id ?? -1,
        receiptTwo,
        'match-conflict',
        start,
      ),
    ).toMatchObject({
      status: 'attention',
      attentionReason: 'match-conflict',
    });
    expect(store.getImportedTransactionLinks(receiptOne)).toEqual([
      expect.objectContaining({
        transactionId: importedCandidate.transactionId,
      }),
    ]);
    store.close();
  });

  it('keeps imported-transaction link identities and audit rows immutable in SQLite', () => {
    const path = databasePath();
    const store = new ReceiptMatchStore(path);
    store.recordReceipt(intake());
    matchReceipt(store);
    expect(
      store.isImportedTransactionReserved('card-one', 'bank-import-one'),
    ).toBe(true);

    const database = new Database(path);
    expect(() =>
      database
        .prepare(
          `UPDATE receipt_imported_transaction_links
              SET transaction_id = 'replacement'
            WHERE receipt_id = ?`,
        )
        .run(receiptOne),
    ).toThrow(/immutable/);
    expect(() =>
      database
        .prepare(
          `UPDATE receipt_match_audit_events
              SET action = 'replacement'
            WHERE receipt_id = ?`,
        )
        .run(receiptOne),
    ).toThrow(/append-only/);
    expect(() =>
      database
        .prepare('DELETE FROM receipt_match_audit_events WHERE receipt_id = ?')
        .run(receiptOne),
    ).toThrow(/append-only/);
    database.close();
    store.close();
  });

  it('bounds apply retries and preserves a matched link when attention is required', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    matchReceipt(store);

    let now = start;
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const job = store.claimNextDueApply(now);
      expect(job?.attemptCount).toBe(attempt);
      const result = store.retryApply(
        job?.id ?? -1,
        receiptOne,
        'actual-temporarily-unavailable',
        now,
      );
      if (result.status === 'attention') {
        expect(attempt).toBe(7);
        expect(result.reason).toBe('apply-retry-exhausted');
        break;
      }
      now = result.nextAttemptAt;
    }

    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'attention',
      attentionReason: 'apply-retry-exhausted',
    });
    expect(store.getImportedTransactionLinks(receiptOne)).toHaveLength(1);
    expect(
      store.isImportedTransactionReserved('card-one', 'bank-import-one'),
    ).toBe(true);
    expect(store.claimNextDueApply(now)).toBeUndefined();
    store.close();
  });

  it('recovers an interrupted apply of an existing transaction after restart', () => {
    const path = databasePath();
    const firstProcess = new ReceiptMatchStore(path);
    firstProcess.recordReceipt(intake());
    matchReceipt(firstProcess);
    expect(firstProcess.claimNextDueApply(start)).toMatchObject({
      attemptCount: 1,
    });
    firstProcess.close();

    const secondProcess = new ReceiptMatchStore(path);
    const recoveredAt = '2026-07-28T01:02:00.000Z';
    expect(secondProcess.recoverInterruptedOutbox(recoveredAt)).toBe(1);
    const apply = secondProcess.claimNextDueApply(recoveredAt);
    expect(apply).toMatchObject({
      kind: 'apply-receipt-match',
      receiptId: receiptOne,
      attemptCount: 2,
    });
    expect(
      secondProcess.markApplied(apply?.id ?? -1, receiptOne, recoveredAt),
    ).toMatchObject({
      status: 'applied',
    });
    secondProcess.close();
  });
});

describe('ReceiptMatchStore ambiguity handling', () => {
  it('persists and resolves a one-choice foreign-currency confirmation', () => {
    const store = new ReceiptMatchStore(':memory:');
    const foreignIntake: ReceiptMatchIntakeInput = {
      ...intake(),
      intent: {
        ...intake().intent,
        currency: 'USD',
        paymentEvidence: { kind: 'unknown' },
      },
    };
    const importedCandidate = candidate('foreign-confirmation', {
      amountMinorUnits: -2_341,
    });
    store.recordReceipt(foreignIntake);
    const match = claimedMatch(store);
    const result = matchReceiptToImportedTransactions(foreignIntake.intent, [
      importedCandidate,
    ]);
    if (result.disposition !== 'ambiguous') {
      throw new Error('Expected a foreign receipt confirmation');
    }
    const choices = store.recordAmbiguous(
      match.id,
      receiptOne,
      result.candidates,
      start,
    );
    expect(choices).toHaveLength(1);

    const candidatePrompt = store.listUnpromptedAmbiguities()[0]!;
    const delivered = store.recordAmbiguityPromptDelivered({
      referenceId: candidatePrompt.referenceId,
      receiptId: receiptOne,
      roomToken: 'household-finance',
      botActorId: `bots/bot-${'a'.repeat(40)}`,
      messageId: '3001',
      choiceTokens: [choices[0]!.choiceToken],
      deliveredAt: start,
    });
    expect(delivered.choiceTokens).toHaveLength(1);
    expect(
      store.resolveAmbiguityFromTalk({
        referenceId: candidatePrompt.referenceId,
        roomToken: 'household-finance',
        actorId: 'alex',
        inboundMessageId: '3002',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '3001',
        selection: 1,
        resolvedAt: '2026-07-28T01:10:00.000Z',
      }),
    ).toMatchObject({
      link: { importedId: importedCandidate.importedId },
    });
    store.close();
  });

  it('persists opaque choices without exposing Actual IDs and resolves one idempotently', () => {
    const path = databasePath();
    const firstProcess = new ReceiptMatchStore(path);
    firstProcess.recordReceipt(intake());
    const match = claimedMatch(firstProcess);
    const firstCandidate = candidate('one');
    const secondCandidate = candidate('two');
    const choices = firstProcess.recordAmbiguous(
      match.id,
      receiptOne,
      [
        { candidate: firstCandidate, score: 132 },
        { candidate: secondCandidate, score: 132 },
      ],
      start,
    );
    expect(
      firstProcess.recordAmbiguous(
        match.id,
        receiptOne,
        [
          { candidate: firstCandidate, score: 132 },
          { candidate: secondCandidate, score: 132 },
        ],
        start,
      ),
    ).toEqual(choices);

    expect(choices).toHaveLength(2);
    expect(choices[0]?.choiceToken).toMatch(/^match_[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(choices)).not.toContain(firstCandidate.transactionId);
    expect(JSON.stringify(choices)).not.toContain(firstCandidate.importedId);
    expect(JSON.stringify(choices)).not.toContain(
      secondCandidate.transactionId,
    );
    expect(JSON.stringify(choices)).not.toContain(secondCandidate.importedId);
    expect(firstProcess.getReceipt(receiptOne)).toMatchObject({
      status: 'ambiguous',
    });
    expect(
      firstProcess.isImportedTransactionReserved(
        firstCandidate.accountAlias,
        firstCandidate.importedId,
      ),
    ).toBe(false);
    expect(
      firstProcess.isImportedTransactionReserved(
        secondCandidate.accountAlias,
        secondCandidate.importedId,
      ),
    ).toBe(false);
    firstProcess.close();

    const database = new Database(path);
    expect(() =>
      database
        .prepare(
          `UPDATE receipt_match_ambiguity_choices
              SET transaction_id = 'replacement'
            WHERE receipt_id = ?`,
        )
        .run(receiptOne),
    ).toThrow(/immutable/);
    database.close();

    const secondProcess = new ReceiptMatchStore(path);
    expect(secondProcess.listAmbiguityChoices(receiptOne)).toEqual(choices);
    const selected = choices.find(
      (choice) => choice.accountAlias === firstCandidate.accountAlias,
    );
    if (selected === undefined) {
      throw new Error('Expected first ambiguity choice');
    }
    const resolved = secondProcess.resolveAmbiguity(
      receiptOne,
      selected.choiceToken,
      '2026-07-28T01:10:00.000Z',
    );
    expect(resolved).toMatchObject({
      inserted: true,
      link: {
        receiptId: receiptOne,
        transactionId: firstCandidate.transactionId,
        importedId: firstCandidate.importedId,
      },
    });
    expect(
      secondProcess.resolveAmbiguity(
        receiptOne,
        selected.choiceToken,
        '2026-07-28T01:10:00.000Z',
      ),
    ).toEqual({ link: resolved.link, inserted: false });
    expect(
      secondProcess
        .listAmbiguityChoices(receiptOne)
        .filter((choice) => choice.selected),
    ).toHaveLength(1);
    expect(
      secondProcess.claimNextDueApply('2026-07-28T01:10:00.000Z'),
    ).toMatchObject({
      kind: 'apply-receipt-match',
      receiptId: receiptOne,
    });

    const auditText = JSON.stringify(secondProcess.listAudit(receiptOne));
    expect(auditText).not.toContain(firstCandidate.transactionId);
    expect(auditText).not.toContain(firstCandidate.importedId);
    expect(auditText).not.toContain(secondCandidate.transactionId);
    expect(auditText).not.toContain(secondCandidate.importedId);
    secondProcess.close();
  });

  it('rejects unknown choice tokens and non-distinct candidates without partial state', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    const match = claimedMatch(store);
    const duplicate = candidate();

    expect(() =>
      store.recordAmbiguous(
        match.id,
        receiptOne,
        [
          { candidate: duplicate, score: 132 },
          { candidate: duplicate, score: 120 },
        ],
        start,
      ),
    ).toThrowError(ReceiptMatchStoreConflictError);
    expect(store.getReceipt(receiptOne)).toMatchObject({
      status: 'awaiting-bank-transaction',
    });
    expect(store.listAmbiguityChoices(receiptOne)).toEqual([]);
    expect(() =>
      store.resolveAmbiguity(
        receiptOne,
        'match_00000000000000000000000000000000',
        start,
      ),
    ).toThrow(/Unknown receipt ambiguity choice/);
    store.close();
  });

  it('persists exact prompt identity and resolves a numbered direct reply once', () => {
    const store = new ReceiptMatchStore(':memory:');
    store.recordReceipt(intake());
    const match = claimedMatch(store);
    store.recordAmbiguous(
      match.id,
      receiptOne,
      [
        { candidate: candidate('one'), score: 132 },
        { candidate: candidate('two'), score: 132 },
      ],
      start,
    );
    const candidatePrompt = store.listUnpromptedAmbiguities()[0]!;
    expect(candidatePrompt.choices).toHaveLength(2);
    const delivered = store.recordAmbiguityPromptDelivered({
      referenceId: candidatePrompt.referenceId,
      receiptId: receiptOne,
      roomToken: 'household-finance',
      botActorId: `bots/bot-${'a'.repeat(40)}`,
      messageId: '3001',
      choiceTokens: candidatePrompt.choices.map((choice) => choice.choiceToken),
      deliveredAt: start,
    });
    expect(store.listUnpromptedAmbiguities()).toEqual([]);
    expect(store.getAmbiguityPrompt(candidatePrompt.referenceId)).toEqual(
      delivered,
    );

    expect(() =>
      store.resolveAmbiguityFromTalk({
        referenceId: candidatePrompt.referenceId,
        roomToken: 'household-finance',
        actorId: 'alex',
        inboundMessageId: '3002',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: 'wrong-parent',
        selection: 1,
        resolvedAt: '2026-07-28T01:10:00.000Z',
      }),
    ).toThrow(/parent does not match/);

    const resolved = store.resolveAmbiguityFromTalk({
      referenceId: candidatePrompt.referenceId,
      roomToken: 'household-finance',
      actorId: 'alex',
      inboundMessageId: '3002',
      parentBotId: `bots/bot-${'a'.repeat(40)}`,
      parentMessageId: '3001',
      selection: 2,
      resolvedAt: '2026-07-28T01:10:00.000Z',
    });
    expect(resolved.inserted).toBe(true);
    expect(store.getAmbiguityResolution(candidatePrompt.referenceId)).toEqual({
      referenceId: candidatePrompt.referenceId,
      receiptId: receiptOne,
      roomToken: 'household-finance',
      actorId: 'alex',
      inboundMessageId: '3002',
      parentBotId: `bots/bot-${'a'.repeat(40)}`,
      parentMessageId: '3001',
      selection: 2,
      choiceToken: candidatePrompt.choices[1]!.choiceToken,
      resolvedAt: '2026-07-28T01:10:00.000Z',
    });
    expect(
      store.resolveAmbiguityFromTalk({
        referenceId: candidatePrompt.referenceId,
        roomToken: 'household-finance',
        actorId: 'alex',
        inboundMessageId: '3002',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '3001',
        selection: 2,
        resolvedAt: '2026-07-28T01:11:00.000Z',
      }),
    ).toEqual({ link: resolved.link, inserted: false });
    store.close();
  });
});
