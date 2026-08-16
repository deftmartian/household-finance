import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { XaiStructuredRunMetadata } from '../../src/model/xai-structured-client.js';
import {
  createTransactionCategoryUpdateRequest,
  TransactionCategorizationStore,
  type TransactionCategorizationObservedRecord,
  type TransactionCategorizationObserverRecord,
} from '../../src/storage/transaction-categorization-store.js';

const start = '2026-07-28T01:00:00.000Z';
const expired = '2026-07-28T01:02:00.000Z';
const watermarkA = 'a'.repeat(64);
const watermarkB = 'b'.repeat(64);
const watermarkC = 'c'.repeat(64);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'categorization-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'finance.sqlite');
}

function observer(
  suffix = 'one',
  patch: Partial<TransactionCategorizationObserverRecord> = {},
): TransactionCategorizationObserverRecord {
  return {
    schemaVersion: 'transaction-categorization-observer-record.v1',
    transactionId: `transaction-${suffix}`,
    importedId: `bank-import-${suffix}`,
    actualObservationFingerprint: 'd'.repeat(64),
    accountOnBudget: true,
    currentCategoryStatus: 'uncategorized',
    split: false,
    observation: {
      schemaVersion: 'transaction-categorization-observation.v1',
      date: '2026-07-28',
      accountAlias: 'spending-card',
      amountMinorUnits: -1_725,
      direction: 'expense',
      payeeName: 'Example Market',
      memo: 'weekly groceries',
      specialKind: 'ordinary',
      currentCategoryAlias: null,
      originalRefundCategoryAlias: null,
    },
    ...patch,
  };
}

function observed(
  patch: Partial<TransactionCategorizationObservedRecord> = {},
): TransactionCategorizationObservedRecord {
  return {
    id: 'event-one',
    fingerprint: 'a'.repeat(64),
    observedAt: start,
    ...observer(),
    ...patch,
  };
}

function metadata(costInUsdTicks = 5_000): XaiStructuredRunMetadata {
  return {
    provider: 'xai',
    requestedModel: 'grok-4.5',
    resolvedModel: 'grok-4.5',
    preflightAttempts: 1,
    requestAttempts: 1,
    durationMs: 10,
    zeroDataRetention: true,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costInUsdTicks,
    },
  };
}

describe('TransactionCategorizationStore scan intake', () => {
  it('commits a watermark only after every observation is durably recorded', () => {
    const store = new TransactionCategorizationStore(':memory:');
    const first = store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer('one')],
      observedAt: start,
    });
    expect(first).toEqual({
      inserted: 1,
      duplicates: 0,
      refreshed: 0,
      requeued: 0,
      conflicts: 0,
      watermark: watermarkA,
    });
    expect(store.getWatermark()).toBe(watermarkA);

    expect(
      store.recordScanPage({
        previousWatermark: watermarkA,
        watermark: watermarkB,
        observations: [
          observer('new'),
          observer('one', {
            observation: {
              ...observer('one').observation,
              amountMinorUnits: -9_999,
            },
          }),
        ],
        observedAt: start,
      }),
    ).toEqual({
      inserted: 1,
      duplicates: 0,
      refreshed: 1,
      requeued: 0,
      conflicts: 0,
      watermark: watermarkB,
    });
    expect(store.getWatermark()).toBe(watermarkB);
    expect(store.getByImportedId('bank-import-new')).toBeDefined();
    expect(store.getByImportedId('bank-import-one')).toMatchObject({
      observation: { amountMinorUnits: -9_999 },
    });
    store.close();
  });

  it('refreshes expected category-state changes without duplicating work', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const categorized = observer('one', {
      actualObservationFingerprint: 'e'.repeat(64),
      currentCategoryStatus: 'contract-bound',
      observation: {
        ...observer().observation,
        currentCategoryAlias: 'groceries',
      },
    });

    expect(
      store.recordScanPage({
        previousWatermark: watermarkA,
        watermark: watermarkB,
        observations: [categorized],
        observedAt: start,
      }),
    ).toEqual({
      inserted: 0,
      duplicates: 0,
      refreshed: 1,
      requeued: 0,
      conflicts: 0,
      watermark: watermarkB,
    });
    expect(store.getByImportedId('bank-import-one')).toMatchObject({
      actualObservationFingerprint: 'e'.repeat(64),
      currentCategoryStatus: 'contract-bound',
      observation: { currentCategoryAlias: 'groceries' },
    });
    expect(store.claimNextJob(start)).toMatchObject({
      kind: 'classify-transaction',
      attemptCount: 1,
    });
    expect(store.claimNextJob(start)).toBeUndefined();
    store.close();
  });

  it('isolates imported-ID and transaction-ID reuse and advances the page', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });

    expect(
      store.recordScanPage({
        previousWatermark: watermarkA,
        watermark: watermarkB,
        observations: [
          observer('one', { transactionId: 'replacement-transaction' }),
        ],
        observedAt: start,
      }),
    ).toMatchObject({ conflicts: 1, watermark: watermarkB });
    expect(
      store.recordScanPage({
        previousWatermark: watermarkB,
        watermark: watermarkC,
        observations: [
          observer('replacement', { transactionId: 'transaction-one' }),
        ],
        observedAt: start,
      }),
    ).toMatchObject({ conflicts: 1, watermark: watermarkC });
    expect(store.getWatermark()).toBe(watermarkC);
    const eventId = store.getByImportedId('bank-import-one')!.id;
    expect(store.listAudit(eventId).map((entry) => entry.action)).toContain(
      'transaction-categorization.identity-conflict-isolated',
    );
    store.close();
  });

  it('requeues a terminal item when the stable transaction becomes actionable again', () => {
    const store = new TransactionCategorizationStore(':memory:');
    const categorized = observer('one', {
      currentCategoryStatus: 'contract-bound',
      observation: {
        ...observer().observation,
        currentCategoryAlias: 'groceries',
      },
    });
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [categorized],
      observedAt: start,
    });
    const eventId = store.getByImportedId('bank-import-one')!.id;
    const initial = store.claimNextJob(start)!;
    store.recordIgnored(initial.id, eventId, 'currently-categorized', start);

    expect(
      store.recordScanPage({
        previousWatermark: watermarkA,
        watermark: watermarkB,
        observations: [
          observer('one', {
            actualObservationFingerprint: 'e'.repeat(64),
          }),
        ],
        observedAt: expired,
      }),
    ).toMatchObject({ refreshed: 1, requeued: 1, conflicts: 0 });
    expect(store.getItem(eventId)).toMatchObject({ status: 'observed' });
    expect(store.getItem(eventId)).not.toHaveProperty('decision');
    const revised = store.claimNextJob(expired)!;
    expect(revised).toMatchObject({
      kind: 'classify-transaction',
      eventId,
      attemptCount: 1,
    });
    store.recordReady(revised.id, eventId, 'groceries', 'model', expired);
    expect(store.claimNextJob(expired)).toMatchObject({
      kind: 'apply-transaction-category',
      eventId,
    });
    store.close();
  });

  it('retires a stale clarification when another workflow categorizes the transaction', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const eventId = store.getByImportedId('bank-import-one')!.id;
    const classify = store.claimNextJob(start)!;
    store.recordAttentionAndEnqueueClarification(
      classify.id,
      eventId,
      'model-low-confidence',
      'Which category?',
      'private-finance-room',
      start,
    );
    const talk = store.claimNextJob(start)!;
    const payload = talk.payload as { referenceId: string };
    store.completeTalkJob(
      talk.id,
      eventId,
      {
        referenceId: payload.referenceId,
        roomToken: 'private-finance-room',
        botActorId: `bots/bot-${'a'.repeat(40)}`,
        messageId: '1799',
      },
      start,
    );
    expect(store.latestOpenClarification('private-finance-room')).toBeDefined();

    expect(
      store.recordScanPage({
        previousWatermark: watermarkA,
        watermark: watermarkB,
        observations: [
          observer('one', {
            actualObservationFingerprint: 'e'.repeat(64),
            currentCategoryStatus: 'contract-bound',
            observation: {
              ...observer().observation,
              currentCategoryAlias: 'groceries',
            },
          }),
        ],
        observedAt: expired,
      }),
    ).toMatchObject({ refreshed: 1, requeued: 1, conflicts: 0 });
    expect(store.getItem(eventId)).toMatchObject({ status: 'observed' });
    expect(
      store.latestOpenClarification('private-finance-room'),
    ).toBeUndefined();

    const refreshed = store.claimNextJob(expired)!;
    store.recordIgnored(
      refreshed.id,
      eventId,
      'currently-categorized',
      expired,
    );
    expect(store.getItem(eventId)).toMatchObject({
      status: 'ignored',
      decision: { reason: 'currently-categorized' },
    });
    store.close();
  });

  it('defers an autonomous clarification without consuming a retry attempt', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const eventId = store.getByImportedId('bank-import-one')!.id;
    const classify = store.claimNextJob(start)!;
    store.recordAttentionAndEnqueueClarification(
      classify.id,
      eventId,
      'model-low-confidence',
      'Which category?',
      'private-finance-room',
      start,
    );
    const firstClaim = store.claimNextJob(start)!;
    expect(firstClaim.attemptCount).toBe(1);
    store.deferTalkJobWithoutAttempt(firstClaim.id, expired);
    expect(store.claimNextJob(start)).toBeUndefined();
    expect(store.claimNextJob(expired)).toMatchObject({
      kind: 'send-transaction-categorization-clarification',
      attemptCount: 1,
    });
    store.close();
  });

  it('rejects deleted or split-child fields that the observer adapter must omit', () => {
    const store = new TransactionCategorizationStore(':memory:');
    const deleted = {
      ...observer(),
      tombstone: true,
    } as unknown as TransactionCategorizationObserverRecord;
    const splitChild = {
      ...observer('child'),
      parentTransactionId: 'transaction-parent',
    } as unknown as TransactionCategorizationObserverRecord;

    expect(() =>
      store.recordScanPage({
        previousWatermark: null,
        watermark: watermarkA,
        observations: [deleted],
        observedAt: start,
      }),
    ).toThrow();
    expect(() =>
      store.recordScanPage({
        previousWatermark: null,
        watermark: watermarkA,
        observations: [splitChild],
        observedAt: start,
      }),
    ).toThrow();
    expect(store.getWatermark()).toBeNull();
    expect(store.claimNextJob(start)).toBeUndefined();
    store.close();
  });
});

describe('transaction category update request identity', () => {
  it('is stable across attempt identities and changes with source state or target category', () => {
    const first = createTransactionCategoryUpdateRequest(
      observed({ id: 'first-attempt' }),
      'groceries',
    );
    const replay = createTransactionCategoryUpdateRequest(
      observed({
        id: 'replay-attempt',
        fingerprint: 'b'.repeat(64),
        observedAt: expired,
      }),
      'groceries',
    );
    const changedGuard = createTransactionCategoryUpdateRequest(
      observed({ actualObservationFingerprint: 'e'.repeat(64) }),
      'groceries',
    );
    const changedCategory = createTransactionCategoryUpdateRequest(
      observed(),
      'dining',
    );

    expect(replay).toEqual(first);
    expect(changedGuard.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changedCategory.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});

describe('TransactionCategorizationStore model and lease recovery', () => {
  it('recovers an exact persisted ZDR proposal without another provider call', () => {
    const path = databasePath();
    const first = new TransactionCategorizationStore(path);
    first.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const event = first.getByImportedId('bank-import-one');
    const job = first.claimNextJob(start, 60);
    first.startProviderCall(job?.id ?? -1, event?.id ?? '', start);
    first.recordProposal(
      job?.id ?? -1,
      event?.id ?? '',
      {
        schemaVersion: 'transaction-category-proposal.v1',
        disposition: 'category',
        categoryAlias: 'groceries',
        confidence: 0.95,
        reason: 'The merchant is a grocery store.',
      },
      metadata(),
      start,
    );
    first.close();

    const restarted = new TransactionCategorizationStore(path);
    expect(restarted.recoverExpiredJobs(expired)).toBe(1);
    expect(restarted.getItem(event?.id ?? '')).toMatchObject({
      status: 'planned',
      proposal: {
        disposition: 'category',
        categoryAlias: 'groceries',
      },
      modelMetadata: { zeroDataRetention: true },
    });
    expect(restarted.claimNextJob(expired)).toMatchObject({
      id: job?.id,
      kind: 'classify-transaction',
      attemptCount: 2,
    });
    restarted.close();
  });

  it('fails an expired in-flight provider call without retransmitting it', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const event = store.getByImportedId('bank-import-one');
    const job = store.claimNextJob(start, 60);
    store.startProviderCall(job?.id ?? -1, event?.id ?? '', start);

    expect(store.recoverExpiredJobs(expired)).toBe(1);
    expect(store.recoverExpiredJobs(expired)).toBe(0);
    expect(store.getItem(event?.id ?? '')).toMatchObject({
      status: 'failed',
      errorCode: 'provider-outcome-unknown',
    });
    expect(
      store.listAudit(event?.id ?? '').map((entry) => entry.action),
    ).toContain('transaction-categorization.provider-outcome-unknown');
    expect(store.claimNextJob(expired)).toBeUndefined();
    store.close();
  });

  it('keeps source observations and audit rows immutable in SQLite', () => {
    const path = databasePath();
    const store = new TransactionCategorizationStore(path);
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const event = store.getByImportedId('bank-import-one');
    const database = new Database(path);

    expect(() =>
      database
        .prepare(
          `UPDATE transaction_categorization_observations
              SET imported_id = 'replacement'
            WHERE id = ?`,
        )
        .run(event?.id),
    ).toThrow(/immutable/);
    expect(() =>
      database
        .prepare(
          `UPDATE transaction_categorization_audit_events
              SET action = 'replacement'
            WHERE event_id = ?`,
        )
        .run(event?.id),
    ).toThrow(/append-only/);
    database.close();
    store.close();
  });
});

describe('TransactionCategorizationStore clarification resolution', () => {
  it('durably turns one delivered clarification reply into an apply job', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const eventId = store.getByImportedId('bank-import-one')!.id;
    const classify = store.claimNextJob(start)!;
    store.recordAttentionAndEnqueueClarification(
      classify.id,
      eventId,
      'model-low-confidence',
      'Which category?',
      'private-finance-room',
      start,
    );
    const talk = store.claimNextJob(start)!;
    const payload = talk.payload as { referenceId: string };
    store.completeTalkJob(
      talk.id,
      eventId,
      {
        referenceId: payload.referenceId,
        roomToken: 'private-finance-room',
        botActorId: `bots/bot-${'a'.repeat(40)}`,
        messageId: '1799',
      },
      start,
    );
    expect(
      store.latestOpenClarification(
        'private-finance-room',
        new Date(new Date(start).valueOf() - 1).toISOString(),
      ),
    ).toBeUndefined();
    expect(
      store.latestOpenClarification('private-finance-room', start),
    ).toMatchObject({
      referenceId: payload.referenceId,
      parentMessageId: '1799',
    });
    expect(store.getClarificationDirection(payload.referenceId)).toBe(
      'expense',
    );
    expect(store.getClarificationDirection('e'.repeat(64))).toBeUndefined();

    expect(
      store.resolveClarification({
        referenceId: payload.referenceId,
        roomToken: 'private-finance-room',
        categoryAlias: 'groceries',
        actorId: 'alex',
        inboundMessageId: '1800',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '1799',
        resolvedAt: expired,
      }),
    ).toMatchObject({ status: 'ready' });
    expect(store.getClarificationResolution(payload.referenceId)).toEqual({
      referenceId: payload.referenceId,
      eventId,
      roomToken: 'private-finance-room',
      categoryAlias: 'groceries',
      actorId: 'alex',
      inboundMessageId: '1800',
      parentBotId: `bots/bot-${'a'.repeat(40)}`,
      parentMessageId: '1799',
      resolvedAt: expired,
    });
    expect(store.claimNextJob(expired)).toMatchObject({
      kind: 'apply-transaction-category',
      eventId,
      payload: {
        schemaVersion: 'transaction-category-update-request.v1',
        importedId: 'bank-import-one',
        accountAlias: 'spending-card',
        observationFingerprint: 'd'.repeat(64),
        categoryAlias: 'groceries',
      },
    });
    expect(store.listAudit(eventId).map((event) => event.action)).toContain(
      'transaction-categorization.clarification-resolved',
    );
    store.close();
  });

  it('is idempotent only for the exact reply and rejects apply-conflict reclassification', () => {
    const store = new TransactionCategorizationStore(':memory:');
    store.recordScanPage({
      previousWatermark: null,
      watermark: watermarkA,
      observations: [observer()],
      observedAt: start,
    });
    const eventId = store.getByImportedId('bank-import-one')!.id;
    const classify = store.claimNextJob(start)!;
    store.recordReady(classify.id, eventId, 'groceries', 'model', start);
    const apply = store.claimNextJob(start)!;
    store.recordApplyConflictAndEnqueueClarification(
      apply.id,
      eventId,
      'The transaction changed.',
      'private-finance-room',
      start,
    );
    const talk = store.claimNextJob(start)!;
    const payload = talk.payload as { referenceId: string };
    store.completeTalkJob(
      talk.id,
      eventId,
      {
        referenceId: payload.referenceId,
        roomToken: 'private-finance-room',
        botActorId: `bots/bot-${'a'.repeat(40)}`,
        messageId: '1799',
      },
      start,
    );

    expect(() =>
      store.resolveClarification({
        referenceId: payload.referenceId,
        roomToken: 'private-finance-room',
        categoryAlias: 'groceries',
        actorId: 'alex',
        inboundMessageId: '1800',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '1799',
        resolvedAt: expired,
      }),
    ).toThrow(/Apply conflicts cannot be resolved/);
    expect(store.getItem(eventId)).toMatchObject({ status: 'attention' });
    store.close();
  });
});
