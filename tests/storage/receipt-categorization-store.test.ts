import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReceiptCategoryProposal } from '../../src/categorization/receipt.js';
import type { XaiStructuredRunMetadata } from '../../src/model/xai-structured-client.js';
import {
  householdFinanceReceiptSha256,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../../src/receipt-record/index.js';
import {
  ReceiptCategorizationStore,
  type ReceiptCategorizationSource,
} from '../../src/storage/receipt-categorization-store.js';

const start = '2026-07-28T01:00:00.000Z';
const expired = '2026-07-28T01:02:00.000Z';
const eventId = '11111111-1111-4111-8111-111111111111';
const documentSha256 = 'a'.repeat(64);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'receipt-category-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'finance.sqlite');
}

function receipt(
  patch: Partial<HouseholdFinanceActiveReceiptRecordV1> = {},
): HouseholdFinanceActiveReceiptRecordV1 {
  return {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId: eventId,
    revision: 1,
    createdAt: start,
    updatedAt: start,
    sources: [
      {
        nextcloudFileId: '2001',
        archivePath: `Receipts/${eventId}.jpg`,
        sha256: documentSha256,
        mediaType: 'image/jpeg',
        receivedAt: start,
        talk: {
          roomToken: 'household-finance',
          actorId: 'alex',
          messageId: '2001',
        },
      },
    ],
    status: 'active',
    merchant: 'Example Market',
    purchaseDate: '2026-07-28',
    purchaseTime: '12:00:00',
    timezoneOffset: '-03:00',
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
        description: 'Cable',
        quantity: 1,
        unitPriceMinor: 1_000,
        totalMinor: 1_000,
      },
      {
        description: 'Paper',
        quantity: 2,
        unitPriceMinor: 250,
        totalMinor: 500,
      },
    ],
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      zeroDataRetention: true,
      extractedAt: start,
      sourceSha256s: [documentSha256],
    },
    ...patch,
  };
}

function source(
  record: HouseholdFinanceActiveReceiptRecordV1 = receipt(),
): ReceiptCategorizationSource {
  const primary = record.sources[0]!;
  return {
    schemaVersion: 'receipt-categorization-source.v1',
    eventId: record.receiptId,
    sourceSha256: householdFinanceReceiptSha256(record),
    roomToken: primary.talk.roomToken,
    messageId: primary.talk.messageId,
    receivedAt: primary.receivedAt,
    record,
  };
}

const sourceSha256 = householdFinanceReceiptSha256(receipt());

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

function categoryProposal(confidence = 1): ReceiptCategoryProposal {
  return {
    schemaVersion: 'receipt-category-proposal.v1',
    items: [
      {
        itemIndex: 0,
        categoryAlias: 'home-supplies',
        confidence,
      },
      { itemIndex: 1, categoryAlias: 'office', confidence: 1 },
    ],
    uncertainties: [],
  };
}

describe('ReceiptCategorizationStore intake and results', () => {
  it('deduplicates content and replaces an idle event with its latest canonical revision', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    expect(store.recordCanonical(source())).toEqual({
      inserted: true,
      eventId,
    });
    expect(store.recordCanonical(source())).toEqual({
      inserted: false,
      eventId,
    });
    const revised = source(receipt({ revision: 2 }));
    expect(store.recordCanonical(revised)).toEqual({ inserted: true, eventId });
    expect(store.getSource(eventId)).toMatchObject({
      sourceSha256: revised.sourceSha256,
    });
    expect(store.getItem(eventId)).toMatchObject({ status: 'observed' });
    expect(store.claimNextJob(start)).toMatchObject({
      kind: 'classify-receipt-items',
      attemptCount: 1,
    });
    expect(store.claimNextJob(start)).toBeUndefined();
    store.close();
  });

  it('defers a canonical revision while a categorization job is processing', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    expect(store.claimNextJob(start)).toBeDefined();

    expect(store.recordCanonical(source(receipt({ revision: 2 })))).toEqual({
      inserted: false,
      eventId,
    });
    expect(store.getSource(eventId)).toMatchObject({ sourceSha256 });
    store.close();
  });

  it('persists the exact model result before creating deterministic splits', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    const job = store.claimNextJob(start);
    expect(job).toBeDefined();
    store.startProviderCall(job!.id, job!.eventId, start);
    store.recordProposal(
      job!.id,
      job!.eventId,
      categoryProposal(),
      metadata(),
      start,
    );
    expect(store.getItem(job!.eventId)).toMatchObject({
      status: 'planned',
      proposal: categoryProposal(),
      modelMetadata: metadata(),
    });

    store.recordEvaluation(
      job!.id,
      job!.eventId,
      {
        disposition: 'ready',
        splits: [
          { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
          { categoryAlias: 'office', amountMinorUnits: 575 },
        ],
        totalMinorUnits: 1_725,
      },
      'unused',
      start,
    );
    const ready = store.getReadyReceipt(job!.eventId);
    expect(ready).toMatchObject({
      schemaVersion: 'ready-receipt-categorization.v1',
      receiptId: eventId,
      idempotencyKey: `receipt-source-sha256:${sourceSha256}`,
      status: 'ready',
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
    const publish = store.claimNextJob(start);
    expect(publish).toMatchObject({ kind: 'publish-ready-receipt' });
    store.markPublished(publish!.id, publish!.eventId, start);
    expect(store.getReadyReceipt(job!.eventId)?.status).toBe('published');
    store.close();
  });

  it('durably defers a busy matcher publish without consuming attempts', () => {
    const path = databasePath();
    const first = new ReceiptCategorizationStore(path);
    first.recordCanonical(source());
    const classify = first.claimNextJob(start)!;
    first.startProviderCall(classify.id, classify.eventId, start);
    first.recordProposal(
      classify.id,
      classify.eventId,
      categoryProposal(),
      metadata(),
      start,
    );
    first.recordEvaluation(
      classify.id,
      classify.eventId,
      {
        disposition: 'ready',
        splits: [
          { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
          { categoryAlias: 'office', amountMinorUnits: 575 },
        ],
        totalMinorUnits: 1_725,
      },
      'unused',
      start,
    );
    const publish = first.claimNextJob(start)!;
    expect(publish).toMatchObject({
      kind: 'publish-ready-receipt',
      attemptCount: 1,
    });
    first.deferPublishJob(
      publish.id,
      publish.eventId,
      '2026-07-28T01:00:05.000Z',
      start,
    );
    first.close();

    const restarted = new ReceiptCategorizationStore(path);
    expect(restarted.getItem(eventId)).toMatchObject({ status: 'ready' });
    expect(restarted.claimNextJob('2026-07-28T01:00:04.000Z')).toBeUndefined();
    expect(restarted.claimNextJob('2026-07-28T01:00:05.000Z')).toMatchObject({
      kind: 'publish-ready-receipt',
      attemptCount: 1,
    });
    expect(restarted.listAudit(eventId).map((event) => event.action)).toContain(
      'receipt-categorization.publish-deferred',
    );
    restarted.close();
  });

  it('durably ignores a ready receipt and filters its pending publication idempotently', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    const job = store.claimNextJob(start)!;
    store.startProviderCall(job.id, job.eventId, start);
    store.recordProposal(
      job.id,
      job.eventId,
      categoryProposal(),
      metadata(),
      start,
    );
    store.recordEvaluation(
      job.id,
      job.eventId,
      {
        disposition: 'ready',
        splits: [
          { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
          { categoryAlias: 'office', amountMinorUnits: 575 },
        ],
        totalMinorUnits: 1_725,
      },
      'unused',
      start,
    );
    expect(store.listReadyReceipts()).toHaveLength(1);

    const ignore = {
      eventId,
      roomToken: 'household-finance',
      actorId: 'alex',
      inboundMessageId: 'ignore-message-1',
      ignoredAt: expired,
    };
    expect(store.ignoreReceipt(ignore)).toEqual({ status: 'ignored' });
    expect(store.ignoreReceipt(ignore)).toEqual({
      status: 'already-ignored',
    });

    expect(store.getReadyReceipt(eventId)).toBeUndefined();
    expect(store.listReadyReceipts()).toEqual([]);
    expect(store.claimNextJob(expired)).toBeUndefined();
    expect(store.listAudit(eventId).map((entry) => entry.action)).toContain(
      'receipt-categorization.ignored',
    );
    store.close();
  });

  it('enqueues exactly one focused clarification when evaluation needs review', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    const job = store.claimNextJob(start)!;
    store.startProviderCall(job.id, job.eventId, start);
    store.recordProposal(
      job.id,
      job.eventId,
      categoryProposal(0.7),
      metadata(),
      start,
    );
    store.recordEvaluation(
      job.id,
      job.eventId,
      {
        disposition: 'review',
        issueCodes: ['classification-uncertain'],
      },
      'Which category should I use for Cable?',
      start,
    );

    expect(store.getItem(job.eventId)?.status).toBe('attention');
    expect(store.claimNextJob(start)).toMatchObject({
      kind: 'send-receipt-categorization-clarification',
      payload: {
        roomToken: 'household-finance',
        message: 'Which category should I use for Cable?',
        replyTo: '2001',
        silent: false,
      },
    });
    expect(store.claimNextJob(start)).toBeUndefined();
    store.close();
  });

  it('defers an autonomous clarification without consuming a retry attempt', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    const job = store.claimNextJob(start)!;
    store.startProviderCall(job.id, job.eventId, start);
    store.recordProposal(
      job.id,
      job.eventId,
      categoryProposal(0.7),
      metadata(),
      start,
    );
    store.recordEvaluation(
      job.id,
      job.eventId,
      {
        disposition: 'review',
        issueCodes: ['classification-uncertain'],
      },
      'Which category should I use for Cable?',
      start,
    );
    const firstClaim = store.claimNextJob(start)!;
    expect(firstClaim.attemptCount).toBe(1);
    store.deferTalkJobWithoutAttempt(firstClaim.id, expired);
    expect(store.claimNextJob(start)).toBeUndefined();
    expect(store.claimNextJob(expired)).toMatchObject({
      kind: 'send-receipt-categorization-clarification',
      attemptCount: 1,
    });
    store.close();
  });

  it('records a non-actionable attention result without a clarification job', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    const job = store.claimNextJob(start)!;
    store.startProviderCall(job.id, job.eventId, start);
    store.recordProposal(
      job.id,
      job.eventId,
      categoryProposal(),
      metadata(),
      start,
    );
    store.recordEvaluation(
      job.id,
      job.eventId,
      {
        disposition: 'review',
        issueCodes: ['currency-not-household'],
      },
      undefined,
      start,
    );

    expect(store.getItem(job.eventId)).toMatchObject({
      status: 'attention',
      decision: {
        disposition: 'review',
        issueCodes: ['currency-not-household'],
      },
    });
    expect(store.claimNextJob(start)).toBeUndefined();
    store.close();
  });

  it('applies a reply only to unclear items and preserves a mixed receipt', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    store.recordCanonical(source());
    const job = store.claimNextJob(start)!;
    store.startProviderCall(job.id, job.eventId, start);
    const proposal = categoryProposal();
    proposal.uncertainties.push({
      itemIndex: 1,
      message: 'Paper could reasonably be groceries or office supplies.',
      material: true,
    });
    store.recordProposal(job.id, job.eventId, proposal, metadata(), start);
    store.recordEvaluation(
      job.id,
      job.eventId,
      {
        disposition: 'review',
        issueCodes: ['classification-uncertain'],
      },
      'Which category should I use?',
      start,
    );
    const talk = store.claimNextJob(start)!;
    const payload = talk.payload as { referenceId: string };
    store.completeTalkJob(
      talk.id,
      eventId,
      {
        referenceId: payload.referenceId,
        roomToken: 'household-finance',
        botActorId: `bots/bot-${'a'.repeat(40)}`,
        messageId: '2002',
      },
      start,
    );
    expect(
      store.latestOpenClarification(
        'household-finance',
        new Date(new Date(start).valueOf() - 1).toISOString(),
      ),
    ).toBeUndefined();
    expect(
      store.latestOpenClarification('household-finance', start),
    ).toMatchObject({
      referenceId: payload.referenceId,
      parentMessageId: '2002',
    });

    expect(
      store.resolveClarification({
        referenceId: payload.referenceId,
        roomToken: 'household-finance',
        categoryAlias: 'groceries',
        actorId: 'alex',
        inboundMessageId: '2003',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '2002',
        resolvedAt: expired,
      }),
    ).toMatchObject({
      status: 'ready',
      decision: {
        disposition: 'review',
        issueCodes: ['classification-uncertain'],
      },
    });
    expect(store.getReadyReceipt(eventId)).toMatchObject({
      status: 'ready',
      splits: [
        {
          categoryAlias: 'groceries',
          amountMinorUnits: 575,
        },
        {
          categoryAlias: 'home-supplies',
          amountMinorUnits: 1_150,
        },
      ],
      totalMinorUnits: 1_725,
    });
    expect(store.getClarificationResolution(payload.referenceId)).toMatchObject(
      {
        referenceId: payload.referenceId,
        eventId,
        categoryAlias: 'groceries',
        actorId: 'alex',
        result: {
          disposition: 'ready',
          splits: [
            {
              categoryAlias: 'groceries',
              amountMinorUnits: 575,
            },
            {
              categoryAlias: 'home-supplies',
              amountMinorUnits: 1_150,
            },
          ],
        },
      },
    );
    expect(store.claimNextJob(expired)).toMatchObject({
      kind: 'publish-ready-receipt',
      eventId,
    });
    expect(() =>
      store.resolveClarification({
        referenceId: payload.referenceId,
        roomToken: 'household-finance',
        categoryAlias: 'dining',
        actorId: 'alex',
        inboundMessageId: '2004',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '2002',
        resolvedAt: expired,
      }),
    ).toThrow(/already resolved differently/);
    store.close();
  });

  it('resolves a foreign receipt category clarification without changing its source currency', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const foreignReceipt = receipt();
    foreignReceipt.currency = 'USD';
    store.recordCanonical(source(foreignReceipt));
    const job = store.claimNextJob(start)!;
    store.startProviderCall(job.id, job.eventId, start);
    const proposal = categoryProposal();
    proposal.uncertainties.push({
      itemIndex: 1,
      message: 'Paper could reasonably be groceries or office supplies.',
      material: true,
    });
    store.recordProposal(job.id, job.eventId, proposal, metadata(), start);
    store.recordEvaluation(
      job.id,
      job.eventId,
      {
        disposition: 'review',
        issueCodes: ['classification-uncertain'],
      },
      'Which category should I use?',
      start,
    );
    const talk = store.claimNextJob(start)!;
    const payload = talk.payload as { referenceId: string };
    store.completeTalkJob(
      talk.id,
      eventId,
      {
        referenceId: payload.referenceId,
        roomToken: 'household-finance',
        botActorId: `bots/bot-${'a'.repeat(40)}`,
        messageId: '2002',
      },
      start,
    );

    expect(
      store.resolveClarification({
        referenceId: payload.referenceId,
        roomToken: 'household-finance',
        categoryAlias: 'groceries',
        actorId: 'alex',
        inboundMessageId: '2003',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '2002',
        resolvedAt: expired,
      }),
    ).toMatchObject({
      status: 'ready',
    });
    expect(store.getReadyReceipt(eventId)).toMatchObject({
      record: { currency: 'USD' },
      splits: [
        { categoryAlias: 'groceries', amountMinorUnits: 575 },
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
      ],
      totalMinorUnits: 1_725,
      status: 'ready',
    });
    expect(store.getClarificationResolution(payload.referenceId)).toMatchObject(
      {
        eventId,
        categoryAlias: 'groceries',
        result: {
          disposition: 'ready',
          splits: [
            { categoryAlias: 'groceries', amountMinorUnits: 575 },
            { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
          ],
          totalMinorUnits: 1_725,
        },
      },
    );
    expect(store.claimNextJob(expired)).toMatchObject({
      kind: 'publish-ready-receipt',
      eventId,
    });
    store.close();
  });
});

describe('ReceiptCategorizationStore crash recovery', () => {
  it('never repeats a possibly-sent model request after its lease expires', () => {
    const path = databasePath();
    const first = new ReceiptCategorizationStore(path);
    first.recordCanonical(source());
    const job = first.claimNextJob(start, 60)!;
    first.startProviderCall(job.id, job.eventId, start);
    first.close();

    const restarted = new ReceiptCategorizationStore(path);
    expect(restarted.recoverExpiredJobs(expired)).toBe(1);
    expect(restarted.getItem(job.eventId)).toMatchObject({
      status: 'failed',
      errorCode: 'provider-outcome-unknown',
    });
    expect(restarted.recoverExpiredJobs(expired)).toBe(0);
    const notice = restarted.claimNextJob(expired)!;
    expect(notice).toMatchObject({
      kind: 'send-receipt-categorization-clarification',
      eventId: job.eventId,
      attemptCount: 1,
      payload: {
        roomToken: 'household-finance',
        message:
          "I saved the receipt, but I couldn't safely finish categorizing it. I didn't change any transaction. You can send a clearer photo or tell me how you'd like it categorized.",
        replyTo: '2001',
        silent: false,
      },
    });
    expect(restarted.claimNextJob(expired)).toBeUndefined();
    restarted.retryJob(
      notice.id,
      'talk-reply-failed',
      '2026-07-28T01:03:00.000Z',
    );
    expect(restarted.claimNextJob('2026-07-28T01:03:00.000Z')).toMatchObject({
      id: notice.id,
      kind: 'send-receipt-categorization-clarification',
      attemptCount: 2,
    });
    expect(
      restarted
        .listAudit(job.eventId)
        .map((event) => event.action)
        .filter(
          (action) => action === 'receipt-categorization.failure-notice-queued',
        ),
    ).toHaveLength(1);
    expect(
      restarted.listAudit(job.eventId).map((event) => event.action),
    ).toContain('receipt-categorization.provider-outcome-unknown');
    restarted.close();
  });

  it('resumes evaluation from a persisted proposal without another provider call', () => {
    const path = databasePath();
    const first = new ReceiptCategorizationStore(path);
    first.recordCanonical(source());
    const job = first.claimNextJob(start, 60)!;
    first.startProviderCall(job.id, job.eventId, start);
    first.recordProposal(
      job.id,
      job.eventId,
      categoryProposal(),
      metadata(),
      start,
    );
    first.close();

    const restarted = new ReceiptCategorizationStore(path);
    expect(restarted.recoverExpiredJobs(expired)).toBe(1);
    expect(restarted.getItem(job.eventId)?.status).toBe('planned');
    expect(restarted.claimNextJob(expired)).toMatchObject({
      id: job.id,
      kind: 'classify-receipt-items',
      attemptCount: 2,
    });
    restarted.close();
  });
});
