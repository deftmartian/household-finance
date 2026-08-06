import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReceiptCategorizationWorkflow,
  ReceiptCategorizationWorker,
  ReceiptMatchStoreCategorizationPublisher,
  type ReadyReceiptCategorizationPublisher,
  type ReceiptCategorizationTalkSender,
} from '../../src/categorization/receipt-workflow.js';
import type {
  ReceiptCategoryProposal,
  ReceiptCategorySplit,
} from '../../src/categorization/receipt.js';
import type { CategoryTaxonomy } from '../../src/categorization/taxonomy.js';
import type {
  CategorizationModelRun,
  ReceiptItemCategoryClassifier,
} from '../../src/categorization/xai-classifiers.js';
import {
  canonicalizeHouseholdReceiptCurrency,
  type ReceiptModelProposalV1,
} from '../../src/model/index.js';
import type { XaiStructuredRunMetadata } from '../../src/model/xai-structured-client.js';
import {
  householdFinanceReceiptSha256,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../../src/receipt-record/index.js';
import { buildActiveReceiptRecord } from '../../src/receipts/photo-bundler.js';
import {
  ReceiptCategorizationStore,
  type ReadyReceiptCategorizationRecord,
  type ReceiptCategorizationSource,
} from '../../src/storage/receipt-categorization-store.js';
import {
  ReceiptMatchStore,
  ReceiptMatchStoreBusyError,
  ReceiptMatchStoreConflictError,
} from '../../src/storage/receipt-match-store.js';
import type { TalkReply } from '../../src/talk/client.js';

const start = '2026-07-28T01:00:00.000Z';
const documentSha256 = 'a'.repeat(64);
const eventId = '11111111-1111-4111-8111-111111111111';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'receipt-category-workflow-'));
  temporaryDirectories.push(directory);
  return join(directory, 'finance.sqlite');
}

const field = <T>(value: T) => ({
  value,
  evidence: 'explicit' as const,
  confidence: 1,
  sourcePage: 1,
});
const amount = (valueMinor: number) => ({
  valueMinor,
  evidence: 'explicit' as const,
  confidence: 1,
  sourcePage: 1,
});

function receipt(): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'single-receipt',
    merchant: field('Example Market'),
    purchaseDate: field('2026-07-28'),
    purchaseTime: field('12:00:00'),
    timezoneOffset: field('-03:00'),
    currency: field('CAD'),
    amounts: {
      subtotal: amount(1_500),
      tax: amount(225),
      discount: amount(0),
      tip: amount(0),
      total: amount(1_725),
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 1,
      sourcePage: null,
    },
    receiptReference: {
      value: null,
      evidence: 'absent',
      confidence: 1,
      sourcePage: null,
    },
    lineItems: [
      {
        description: 'Cable',
        quantity: 1,
        unitPriceMinor: 1_000,
        totalMinor: 1_000,
        confidence: 1,
        sourcePage: 1,
      },
      {
        description: 'Paper',
        quantity: 2,
        unitPriceMinor: 250,
        totalMinor: 500,
        confidence: 1,
        sourcePage: 1,
      },
    ],
    uncertainties: [],
  };
}

const taxonomy: CategoryTaxonomy = {
  schemaVersion: 'household-category-taxonomy.v1',
  currency: 'CAD',
  categories: [
    {
      alias: 'home-supplies',
      name: 'Home supplies',
      description: 'Supplies used in the household.',
      kind: 'expense',
      modelSelectable: true,
    },
    {
      alias: 'office',
      name: 'Office',
      description: 'Office supplies.',
      kind: 'expense',
      modelSelectable: true,
    },
  ],
};

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

function wholeReceiptProposal(
  categoryAlias: string | null,
): ReceiptCategoryProposal {
  return {
    schemaVersion: 'receipt-category-proposal.v1',
    wholeReceiptCategoryAlias: categoryAlias,
    items: [],
    uncertainties:
      categoryAlias === null
        ? [
            {
              itemIndex: null,
              message: 'The whole purchase purpose is unclear.',
              material: true,
            },
          ]
        : [],
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

function completedRecord(
  input: {
    readonly receiptId?: string;
    readonly receivedAt?: string;
    readonly messageId?: string;
    readonly proposal?: ReceiptModelProposalV1;
    readonly householdNote?: string;
  } = {},
): HouseholdFinanceActiveReceiptRecordV1 {
  const inputReceiptId = input.receiptId ?? eventId;
  const receivedAt = input.receivedAt ?? start;
  const messageId = input.messageId ?? '2001';
  const canonicalReceipt = canonicalizeHouseholdReceiptCurrency(
    input.proposal ?? receipt(),
  );
  const source = {
    eventId: inputReceiptId,
    roomToken: 'household-finance',
    actorId: 'alex',
    messageId,
    receivedAt,
    fileId: messageId,
    archivePath: `Receipts/${inputReceiptId}.jpg`,
    mediaType: 'image/jpeg' as const,
    sourceSha256: documentSha256,
    extractedAt: receivedAt,
    modelMetadata: {
      provider: 'xai' as const,
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      preflightAttempts: 1,
      documentAttempts: 1,
      durationMs: 10,
      zeroDataRetention: true as const,
    },
    receipt: canonicalReceipt,
  };
  return buildActiveReceiptRecord({
    receiptId: inputReceiptId,
    bundleSha256: 'b'.repeat(64),
    receivedAt,
    updatedAt: receivedAt,
    sources: [source],
    householdNoteCandidates:
      input.householdNote === undefined
        ? []
        : [
            {
              captionHint: input.householdNote,
              roomToken: source.roomToken,
              actorId: source.actorId,
              messageId: source.messageId,
              fileId: source.fileId,
              receivedAt,
              extractedAt: receivedAt,
            },
          ],
    receipt: canonicalReceipt,
  });
}

const sourceSha256 = householdFinanceReceiptSha256(completedRecord());

class RecordingClassifier implements ReceiptItemCategoryClassifier {
  readonly receipts: HouseholdFinanceActiveReceiptRecordV1[] = [];
  readonly taxonomies: CategoryTaxonomy[] = [];
  readonly householdNotes: Array<readonly string[] | undefined> = [];

  constructor(
    public proposal: ReceiptCategoryProposal,
    readonly costInUsdTicks = 5_000,
  ) {}

  async classify(
    input: HouseholdFinanceActiveReceiptRecordV1,
    inputTaxonomy: CategoryTaxonomy,
  ): Promise<CategorizationModelRun<ReceiptCategoryProposal>> {
    this.receipts.push(structuredClone(input));
    this.taxonomies.push(structuredClone(inputTaxonomy));
    this.householdNotes.push(
      input.householdNotes === undefined
        ? undefined
        : input.householdNotes.map((note) => note.text),
    );
    return {
      proposal: structuredClone(this.proposal),
      metadata: metadata(this.costInUsdTicks),
    };
  }
}

class FailingClassifier extends RecordingClassifier {
  override classify(): Promise<
    CategorizationModelRun<ReceiptCategoryProposal>
  > {
    return Promise.reject(new Error('simulated model failure'));
  }
}

class RecordingPublisher implements ReadyReceiptCategorizationPublisher {
  readonly calls: ReadyReceiptCategorizationRecord[] = [];
  readonly matchableCalls: ReceiptCategorizationSource[] = [];
  readonly publishedKeys = new Set<string>();
  throwAfterNextPublish = false;

  publishMatchable(record: ReceiptCategorizationSource): void {
    this.matchableCalls.push(structuredClone(record));
  }

  async publish(record: ReadyReceiptCategorizationRecord): Promise<void> {
    this.calls.push(structuredClone(record));
    this.publishedKeys.add(record.idempotencyKey);
    if (this.throwAfterNextPublish) {
      this.throwAfterNextPublish = false;
      throw new Error('simulated crash after matcher commit');
    }
  }
}

class BusyPublisher extends RecordingPublisher {
  attempts = 0;

  constructor(readonly busyAttempts: number) {
    super();
  }

  override async publish(
    record: ReadyReceiptCategorizationRecord,
  ): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.busyAttempts) {
      throw new ReceiptMatchStoreBusyError();
    }
    await super.publish(record);
  }
}

class BusyMatchablePublisher extends RecordingPublisher {
  attempts = 0;

  override publishMatchable(record: ReceiptCategorizationSource): void {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new ReceiptMatchStoreBusyError();
    }
    super.publishMatchable(record);
  }
}

class ConflictingMatchablePublisher extends RecordingPublisher {
  attempts = 0;

  override publishMatchable(): void {
    this.attempts += 1;
    throw new ReceiptMatchStoreConflictError(
      'simulated already-applied receipt revision',
    );
  }
}

class RecordingTalk implements ReceiptCategorizationTalkSender {
  readonly replies: TalkReply[] = [];
  failNext = false;

  async sendReplyWithIdentity(reply: TalkReply) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated Talk outage');
    }
    this.replies.push(structuredClone(reply));
    return {
      roomToken: reply.roomToken,
      botActorId: `bots/bot-${'a'.repeat(40)}`,
      messageId: '3001',
      referenceId: reply.referenceId,
      ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    };
  }
}

class TestClock {
  #value = new Date(start);

  readonly now = (): Date => new Date(this.#value);

  advanceSeconds(seconds: number): void {
    this.#value = new Date(this.#value.valueOf() + seconds * 1_000);
  }
}

function workflow(options: {
  store: ReceiptCategorizationStore;
  records?: HouseholdFinanceActiveReceiptRecordV1[];
  classifier?: RecordingClassifier;
  publisher?: RecordingPublisher;
  talk?: RecordingTalk;
  clock?: TestClock;
  isCurrentReceiptSource?: (receiptId: string, sourceSha256: string) => boolean;
}): {
  workflow: ReceiptCategorizationWorkflow;
  classifier: RecordingClassifier;
  publisher: RecordingPublisher;
  talk: RecordingTalk;
} {
  const classifier =
    options.classifier ?? new RecordingClassifier(categoryProposal());
  const publisher = options.publisher ?? new RecordingPublisher();
  const talk = options.talk ?? new RecordingTalk();
  return {
    workflow: new ReceiptCategorizationWorkflow({
      store: options.store,
      records: {
        listActiveRecords: () => options.records ?? [],
        ...(options.isCurrentReceiptSource === undefined
          ? {}
          : {
              isCurrentReceiptSource: options.isCurrentReceiptSource,
            }),
      },
      taxonomySource: {
        read: async () => structuredClone(taxonomy),
      },
      classifier,
      publisher,
      talk,
      leaseDurationSeconds: 60,
      now: options.clock?.now ?? (() => new Date(start)),
    }),
    classifier,
    publisher,
    talk,
  };
}

describe('ReceiptCategorizationWorkflow', () => {
  it('deduplicates a canonical record and publishes matching intake only once', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const canonical = completedRecord({
      householdNote: "Elia's birthday present.",
    });
    const canonicalSha256 = householdFinanceReceiptSha256(canonical);
    const lane = workflow({
      store,
      records: [structuredClone(canonical), canonical],
    });

    await expect(lane.workflow.runOnce()).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
      invalid: 0,
      processed: 2,
    });
    expect(lane.classifier.receipts).toHaveLength(1);
    expect(lane.classifier.taxonomies).toEqual([taxonomy]);
    expect(lane.classifier.householdNotes).toEqual([
      ["Elia's birthday present."],
    ]);
    expect(lane.publisher.matchableCalls).toHaveLength(1);
    expect(lane.publisher.calls).toHaveLength(1);
    expect(lane.publisher.calls[0]).toMatchObject({
      receiptId: eventId,
      sourceSha256: canonicalSha256,
      idempotencyKey: `receipt-source-sha256:${canonicalSha256}`,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ] satisfies ReceiptCategorySplit[],
    });
    expect(store.getItem(eventId)?.status).toBe('published');

    await expect(lane.workflow.runOnce()).resolves.toMatchObject({
      inserted: 0,
      duplicates: 1,
      processed: 0,
    });
    expect(lane.publisher.matchableCalls).toHaveLength(1);
    expect(lane.classifier.receipts).toHaveLength(1);
    store.close();
  });

  it('retries matching after a crash-window database busy result', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const publisher = new BusyMatchablePublisher();
    const lane = workflow({
      store,
      records: [completedRecord()],
      publisher,
    });

    expect(lane.workflow.ingestActiveRecords()).toEqual({
      inserted: 0,
      duplicates: 0,
      invalid: 0,
    });
    expect(publisher.matchableCalls).toEqual([]);
    expect(store.getBySourceSha256(sourceSha256)).toBeUndefined();

    expect(lane.workflow.ingestActiveRecords()).toEqual({
      inserted: 1,
      duplicates: 0,
      invalid: 0,
    });
    expect(publisher.matchableCalls).toHaveLength(1);
    expect(publisher.attempts).toBe(2);
    expect(store.getBySourceSha256(sourceSha256)).toBeDefined();

    expect(lane.workflow.ingestActiveRecords()).toEqual({
      inserted: 0,
      duplicates: 1,
      invalid: 0,
    });
    expect(publisher.attempts).toBe(2);
    store.close();
  });

  it('records a new categorization source after an existing safe matcher conflict', () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const publisher = new ConflictingMatchablePublisher();
    const lane = workflow({
      store,
      records: [completedRecord()],
      publisher,
    });

    expect(lane.workflow.ingestActiveRecords()).toEqual({
      inserted: 1,
      duplicates: 0,
      invalid: 0,
    });
    expect(publisher.attempts).toBe(1);
    expect(store.getBySourceSha256(sourceSha256)).toBeDefined();

    expect(lane.workflow.ingestActiveRecords()).toEqual({
      inserted: 0,
      duplicates: 1,
      invalid: 0,
    });
    expect(publisher.attempts).toBe(1);
    store.close();
  });

  it('publishes the model best fit without interrupting on confidence alone', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const lane = workflow({
      store,
      records: [completedRecord()],
      classifier: new RecordingClassifier(categoryProposal(0.7)),
    });

    await lane.workflow.runOnce();
    expect(lane.publisher.calls).toHaveLength(1);
    expect(lane.talk.replies).toEqual([]);
    expect(store.getItem(eventId)).toMatchObject({
      status: 'published',
      decision: {
        disposition: 'ready',
      },
    });
    store.close();
  });

  it('starts matching and applies a clear whole-purchase note when item rows are unreadable', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const unreadableItems = receipt();
    unreadableItems.lineItems = [];
    unreadableItems.uncertainties = [
      {
        code: 'line-items-unclear',
        message: 'The item rows are unreadable.',
        material: true,
        sourcePage: 1,
      },
    ];
    const attachment = completedRecord({
      proposal: unreadableItems,
      householdNote: 'This whole purchase was home supplies.',
    });
    const lane = workflow({
      store,
      records: [attachment],
      classifier: new RecordingClassifier(
        wholeReceiptProposal('home-supplies'),
      ),
    });

    await expect(lane.workflow.runOnce()).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
      invalid: 0,
      processed: 2,
    });
    expect(lane.publisher.matchableCalls).toHaveLength(1);
    expect(lane.publisher.calls).toEqual([
      expect.objectContaining({
        splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
      }),
    ]);
    expect(lane.classifier.householdNotes).toEqual([
      ['This whole purchase was home supplies.'],
    ]);
    expect(lane.talk.replies).toEqual([]);
    expect(store.getItem(eventId)?.status).toBe('published');
    store.close();
  });

  it('publishes one whole-purchase category when partial item amounts cannot support an exact split', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const partialItems = receipt();
    partialItems.lineItems[1] = {
      ...partialItems.lineItems[1]!,
      totalMinor: null,
    };
    partialItems.uncertainties = [
      {
        code: 'line-items-unclear',
        message: 'The second item amount is unreadable.',
        material: true,
        sourcePage: 1,
      },
    ];
    const attachment = completedRecord({ proposal: partialItems });
    const lane = workflow({
      store,
      records: [attachment],
      classifier: new RecordingClassifier(
        wholeReceiptProposal('home-supplies'),
      ),
    });

    await expect(lane.workflow.runOnce()).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
      invalid: 0,
      processed: 2,
    });
    expect(lane.publisher.matchableCalls).toHaveLength(1);
    expect(lane.publisher.calls).toEqual([
      expect.objectContaining({
        splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
      }),
    ]);
    expect(lane.talk.replies).toEqual([]);
    expect(store.getItem(eventId)?.status).toBe('published');
    store.close();
  });

  it('asks for one whole-purchase category when partial item amounts are ambiguous', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const partialItems = receipt();
    partialItems.lineItems[1] = {
      ...partialItems.lineItems[1]!,
      totalMinor: null,
    };
    const attachment = completedRecord({ proposal: partialItems });
    const lane = workflow({
      store,
      records: [attachment],
      classifier: new RecordingClassifier(wholeReceiptProposal(null)),
    });

    await lane.workflow.runOnce();

    expect(lane.publisher.matchableCalls).toHaveLength(1);
    expect(lane.publisher.calls).toEqual([]);
    expect(lane.talk.replies).toHaveLength(1);
    expect(lane.talk.replies[0]?.message).toContain(
      "I couldn't read enough item amounts to split it exactly",
    );
    expect(lane.talk.replies[0]?.message).toContain(
      'Reply with one category for the whole purchase',
    );
    expect(store.getItem(eventId)).toMatchObject({
      status: 'attention',
      decision: {
        disposition: 'review',
        issueCodes: ['classification-incomplete', 'classification-uncertain'],
      },
    });
    store.close();
  });

  it('starts matching before categorization when a zero-item receipt still needs purpose clarification', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const unreadableItems = receipt();
    unreadableItems.lineItems = [];
    const attachment = completedRecord({ proposal: unreadableItems });
    const lane = workflow({
      store,
      records: [attachment],
      classifier: new RecordingClassifier(wholeReceiptProposal(null)),
    });

    await lane.workflow.runOnce();

    expect(lane.publisher.matchableCalls).toHaveLength(1);
    expect(lane.publisher.calls).toEqual([]);
    expect(store.getItem(eventId)).toMatchObject({
      status: 'attention',
      decision: {
        disposition: 'review',
        issueCodes: ['classification-incomplete', 'classification-uncertain'],
      },
    });
    store.close();
  });

  it('durably ingests an abbreviated merchant and canonical CAD currency', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const raw = receipt();
    raw.merchant = {
      value: 'ABRV',
      evidence: 'explicit',
      confidence: 0.72,
      sourcePage: 1,
    };
    raw.currency = {
      value: 'USD',
      evidence: 'derived',
      confidence: 0.8,
      sourcePage: 1,
    };
    raw.uncertainties = [
      {
        code: 'merchant-unclear',
        message: 'The seller name is abbreviated.',
        material: true,
        sourcePage: 1,
      },
    ];
    const record = completedRecord({ proposal: raw });
    const lane = workflow({
      store,
      records: [record],
    });

    await expect(lane.workflow.runOnce()).resolves.toMatchObject({
      inserted: 1,
      invalid: 0,
      processed: 2,
    });
    expect(lane.classifier.receipts[0]).toMatchObject({
      merchant: 'ABRV',
      currency: 'CAD',
    });
    expect(lane.publisher.calls[0]).toMatchObject({
      record: {
        merchant: 'ABRV',
        currency: 'CAD',
      },
    });
    expect(store.getItem(eventId)?.status).toBe('published');
    store.close();
  });

  it('explains a terminal categorization failure in plain language', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const clock = new TestClock();
    const talk = new RecordingTalk();
    talk.failNext = true;
    const lane = workflow({
      store,
      records: [completedRecord()],
      classifier: new FailingClassifier(categoryProposal()),
      talk,
      clock,
    });

    await lane.workflow.runOnce();

    expect(store.getItem(eventId)?.status).toBe('failed');
    expect(lane.talk.replies).toEqual([]);
    clock.advanceSeconds(3);
    await lane.workflow.processAvailable();
    expect(lane.talk.replies).toEqual([
      expect.objectContaining({
        roomToken: 'household-finance',
        replyTo: '2001',
        message:
          "I saved the receipt, but I couldn't safely finish categorizing it. I didn't change any transaction. You can send a clearer photo or tell me how you'd like it categorized.",
      }),
    ]);
    store.close();
  });

  it('asks one focused reply-to clarification for material ambiguity', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const uncertain = categoryProposal();
    uncertain.uncertainties.push({
      itemIndex: 0,
      message: 'Two categories would materially change the purchase meaning.',
      material: true,
    });
    const lane = workflow({
      store,
      records: [completedRecord()],
      classifier: new RecordingClassifier(uncertain),
    });

    await lane.workflow.runOnce();
    expect(lane.publisher.calls).toEqual([]);
    expect(lane.talk.replies).toHaveLength(1);
    expect(lane.talk.replies[0]).toMatchObject({
      roomToken: 'household-finance',
      replyTo: '2001',
      silent: false,
    });
    expect(lane.talk.replies[0]?.message).toContain('Cable');
    expect(lane.talk.replies[0]?.message).toContain(
      "Reply with one category for the unclear items; I'll keep the other item categories as they are",
    );
    expect(lane.talk.replies[0]?.message).not.toContain('safely');
    expect(lane.talk.replies[0]?.message).not.toContain(eventId);
    expect(store.getItem(eventId)).toMatchObject({
      status: 'attention',
      decision: {
        disposition: 'review',
        issueCodes: ['classification-uncertain'],
      },
    });
    store.close();
  });

  it('categorizes and publishes a foreign-currency receipt for bank matching', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const attachment = completedRecord({
      proposal: { ...receipt(), currency: field('USD') },
    });
    const lane = workflow({
      store,
      records: [attachment],
    });

    await expect(lane.workflow.runOnce()).resolves.toMatchObject({
      inserted: 1,
      invalid: 0,
      processed: 2,
    });
    expect(lane.classifier.receipts).toHaveLength(1);
    expect(lane.publisher.calls).toHaveLength(1);
    expect(lane.publisher.calls[0]).toMatchObject({
      record: { currency: 'USD' },
      totalMinorUnits: 1_725,
    });
    expect(lane.talk.replies).toEqual([]);
    expect(store.getItem(eventId)).toMatchObject({ status: 'published' });
    store.close();
  });

  it('backfills an extracted receipt when missing payment is its only uncertainty', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const previouslyBlocked = receipt();
    previouslyBlocked.uncertainties.push({
      code: 'payment-unclear',
      message: 'No payment method is visible on the receipt',
      material: true,
      sourcePage: 1,
    });
    const attachment = completedRecord({ proposal: previouslyBlocked });
    const lane = workflow({
      store,
      records: [attachment],
    });

    await expect(lane.workflow.runOnce()).resolves.toMatchObject({
      inserted: 1,
      invalid: 0,
      processed: 2,
    });
    expect(lane.publisher.calls).toHaveLength(1);
    expect(lane.publisher.calls[0]).toMatchObject({
      record: {
        paymentEvidence: { kind: 'unknown' },
      },
    });
    expect(store.getItem(eventId)).toMatchObject({ status: 'published' });
    store.close();
  });

  it('re-evaluates a deterministic attention result after matching policy improves', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const attachment = completedRecord();
    store.recordCanonical(
      {
        schemaVersion: 'receipt-categorization-source.v1',
        eventId,
        sourceSha256,
        roomToken: 'household-finance',
        messageId: '2001',
        receivedAt: start,
        record: attachment,
      },
      start,
    );
    const classificationJob = store.claimNextJob(start, 60)!;
    store.startProviderCall(
      classificationJob.id,
      classificationJob.eventId,
      start,
    );
    store.recordProposal(
      classificationJob.id,
      classificationJob.eventId,
      categoryProposal(),
      metadata(),
      start,
    );
    store.recordEvaluation(
      classificationJob.id,
      classificationJob.eventId,
      {
        disposition: 'review',
        issueCodes: ['split-allocation-failed'],
      },
      'This old deterministic result should be cancelled after reevaluation.',
      start,
    );
    expect(store.getItem(eventId)?.status).toBe('attention');
    const clarificationJob = store.claimNextJob(start, 60)!;
    const clarificationPayload = clarificationJob.payload as {
      referenceId: string;
    };
    expect(
      store.recordDeterministicReevaluation(
        eventId,
        {
          disposition: 'ready',
          totalMinorUnits: 1_725,
          splits: [
            {
              categoryAlias: 'home-supplies',
              amountMinorUnits: 1_150,
            },
            { categoryAlias: 'office', amountMinorUnits: 575 },
          ],
        },
        start,
      ),
    ).toBe(false);
    store.completeTalkJob(
      clarificationJob.id,
      eventId,
      {
        referenceId: clarificationPayload.referenceId,
        roomToken: 'household-finance',
        botActorId: `bots/bot-${'a'.repeat(40)}`,
        messageId: '2002',
      },
      start,
    );
    expect(
      store.latestOpenClarification('household-finance', start),
    ).toBeDefined();

    const lane = workflow({
      store,
      records: [attachment],
    });
    await expect(lane.workflow.runOnce()).resolves.toMatchObject({
      duplicates: 1,
      processed: 1,
    });
    expect(lane.publisher.calls).toHaveLength(1);
    expect(lane.talk.replies).toEqual([]);
    expect(
      store.latestOpenClarification('household-finance', start),
    ).toBeUndefined();
    expect(store.getItem(eventId)).toMatchObject({
      status: 'published',
      decision: { disposition: 'ready' },
    });
    expect(store.listAudit(eventId).map((event) => event.action)).toContain(
      'receipt-categorization.deterministically-reevaluated',
    );
    store.close();
  });

  it('keeps a multi-receipt upload out of publishing and leaves the focused guidance to extraction', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const attachment = completedRecord({
      proposal: { ...receipt(), documentDisposition: 'multiple-receipts' },
    });
    const lane = workflow({
      store,
      records: [attachment],
    });

    await expect(lane.workflow.runOnce()).resolves.toMatchObject({
      inserted: 0,
      invalid: 1,
      processed: 0,
    });
    expect(lane.classifier.receipts).toEqual([]);
    expect(lane.publisher.calls).toEqual([]);
    expect(lane.talk.replies).toEqual([]);
    expect(store.getItem(eventId)).toBeUndefined();
    store.close();
  });

  it.each([
    'split-tender' as const,
    'combined-charge' as const,
    'reimbursement' as const,
  ])(
    'keeps a model-identified %s receipt out of publishing and bank matching',
    async (code) => {
      const store = new ReceiptCategorizationStore(':memory:');
      const exceptional = receipt();
      exceptional.uncertainties.push({
        code,
        message: 'Synthetic manual-review condition',
        material: true,
        sourcePage: 1,
      });
      const attachment = completedRecord({ proposal: exceptional });
      const lane = workflow({
        store,
        records: [attachment],
      });

      await expect(lane.workflow.runOnce()).resolves.toMatchObject({
        inserted: 0,
        invalid: 1,
        processed: 0,
      });
      expect(lane.classifier.receipts).toEqual([]);
      expect(lane.publisher.calls).toEqual([]);
      expect(lane.talk.replies).toEqual([]);
      expect(store.getItem(eventId)).toBeUndefined();
      store.close();
    },
  );

  it('reconciles an idempotent matcher publish after a crash without reclassification', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const clock = new TestClock();
    const publisher = new RecordingPublisher();
    publisher.throwAfterNextPublish = true;
    const lane = workflow({
      store,
      records: [completedRecord()],
      publisher,
      clock,
    });

    await lane.workflow.runOnce();
    expect(publisher.calls).toHaveLength(1);
    expect(store.getItem(eventId)?.status).toBe('ready');
    clock.advanceSeconds(3);
    await lane.workflow.processAvailable();

    expect(publisher.calls).toHaveLength(2);
    expect(publisher.publishedKeys).toEqual(
      new Set([`receipt-source-sha256:${sourceSha256}`]),
    );
    expect(lane.classifier.receipts).toHaveLength(1);
    expect(store.getItem(eventId)?.status).toBe('published');
    store.close();
  });

  it('keeps a matcher-busy publish pending beyond the normal retry limit', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const clock = new TestClock();
    const publisher = new BusyPublisher(6);
    const lane = workflow({
      store,
      records: [completedRecord()],
      publisher,
      clock,
    });

    await lane.workflow.runOnce();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(store.getItem(eventId)).toMatchObject({ status: 'ready' });
      clock.advanceSeconds(5);
      await lane.workflow.processAvailable();
    }

    expect(publisher.attempts).toBe(7);
    expect(publisher.calls).toHaveLength(1);
    expect(store.getItem(eventId)).toMatchObject({ status: 'published' });
    expect(lane.talk.replies).toEqual([]);
    store.close();
  });

  it('evaluates a recovered persisted proposal without calling xAI again', async () => {
    const path = databasePath();
    const first = new ReceiptCategorizationStore(path);
    const source: ReceiptCategorizationSource = {
      schemaVersion: 'receipt-categorization-source.v1',
      eventId,
      sourceSha256,
      roomToken: 'household-finance',
      messageId: '2001',
      receivedAt: start,
      record: completedRecord(),
    };
    first.recordCanonical(source);
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
    const clock = new TestClock();
    clock.advanceSeconds(120);
    const lane = workflow({ store: restarted, clock });
    await lane.workflow.processAvailable();

    expect(lane.classifier.receipts).toEqual([]);
    expect(lane.publisher.calls).toHaveLength(1);
    expect(restarted.getItem(source.eventId)?.status).toBe('published');
    restarted.close();
  });

  it('does not publish a categorization superseded by a pending canonical revision', async () => {
    const store = new ReceiptCategorizationStore(':memory:');
    const lane = workflow({
      store,
      records: [completedRecord()],
      isCurrentReceiptSource: () => false,
    });

    await lane.workflow.runOnce();

    expect(lane.classifier.receipts).toHaveLength(1);
    expect(lane.publisher.calls).toEqual([]);
    expect(store.getItem(eventId)).toMatchObject({
      status: 'failed',
      errorCode: 'superseded-by-canonical-revision',
    });
    expect(lane.talk.replies).toEqual([]);
    store.close();
  });

  it('bridges a ready receipt into ReceiptMatchStore idempotently', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const replayedAt = '2026-08-20T12:00:00.000Z';
    const publisher = new ReceiptMatchStoreCategorizationPublisher(
      matches,
      () => new Date(replayedAt),
    );
    const record: ReadyReceiptCategorizationRecord = {
      schemaVersion: 'ready-receipt-categorization.v1',
      receiptId: eventId,
      idempotencyKey: `receipt-source-sha256:${sourceSha256}`,
      sourceSha256,
      roomToken: 'household-finance',
      messageId: '2001',
      receivedAt: start,
      record: completedRecord(),
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
      totalMinorUnits: 1_725,
      status: 'ready',
    };

    await publisher.publish(record);
    await publisher.publish(record);

    expect(matches.getReceipt(eventId)).toMatchObject({
      receiptId: eventId,
      status: 'awaiting-bank-transaction',
      expiresAt: '2026-08-07T00:00:00.000Z',
      nextMatchAt: replayedAt,
      intent: {
        merchantName: 'Example Market',
        totalMinorUnits: 1_725,
      },
    });
    expect(matches.pendingReceiptSummary(replayedAt)).toEqual({
      count: 0,
      totalMinorUnits: 0,
    });
    expect(matches.claimNextDueMatch(replayedAt)).toMatchObject({
      receiptId: eventId,
      attemptCount: 1,
    });
    matches.close();
  });

  it('bridges a matchable zero-item receipt into ReceiptMatchStore before categorization is ready', () => {
    const matches = new ReceiptMatchStore(':memory:');
    const publisher = new ReceiptMatchStoreCategorizationPublisher(matches);
    const zeroItemReceipt = receipt();
    zeroItemReceipt.lineItems = [];
    zeroItemReceipt.uncertainties = [
      {
        code: 'line-items-unclear',
        message: 'The item rows are unreadable.',
        material: true,
        sourcePage: 1,
      },
    ];
    const canonical = completedRecord({
      proposal: zeroItemReceipt,
      householdNote: 'This whole purchase was home supplies.',
    });
    const source: ReceiptCategorizationSource = {
      schemaVersion: 'receipt-categorization-source.v1',
      eventId,
      sourceSha256: householdFinanceReceiptSha256(canonical),
      roomToken: 'household-finance',
      messageId: '2001',
      receivedAt: start,
      record: canonical,
    };

    publisher.publishMatchable(source);
    publisher.publishMatchable(source);

    expect(matches.getReceipt(eventId)).toMatchObject({
      receiptId: eventId,
      status: 'awaiting-bank-transaction',
      intent: {
        merchantName: 'Example Market',
        totalMinorUnits: 1_725,
      },
    });
    matches.close();
  });

  it('does not re-create an ignored receipt while publishing categorization', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const publisher = new ReceiptMatchStoreCategorizationPublisher(matches);
    matches.ignoreReceipt({
      receiptId: eventId,
      actorId: 'alex',
      inboundMessageId: 'ignore-before-publish',
      ignoredAt: start,
    });
    const record: ReadyReceiptCategorizationRecord = {
      schemaVersion: 'ready-receipt-categorization.v1',
      receiptId: eventId,
      idempotencyKey: `receipt-source-sha256:${sourceSha256}`,
      sourceSha256,
      roomToken: 'household-finance',
      messageId: '2001',
      receivedAt: start,
      record: completedRecord(),
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
      totalMinorUnits: 1_725,
      status: 'ready',
    };

    await expect(publisher.publish(record)).resolves.toBeUndefined();
    expect(matches.getReceipt(eventId)).toBeUndefined();
    matches.close();
  });

  it('coalesces an overlapping kick into a second full pass before callers continue', async () => {
    const result = {
      inserted: 0,
      duplicates: 0,
      invalid: 0,
      processed: 0,
    };
    let releaseFirst: (() => void) | undefined;
    const firstPass = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runOnce = vi
      .fn<ReceiptCategorizationWorkflow['runOnce']>()
      .mockImplementationOnce(async () => {
        await firstPass;
        return result;
      })
      .mockResolvedValue(result);
    const worker = new ReceiptCategorizationWorker({
      runOnce,
    } as unknown as ReceiptCategorizationWorkflow);

    const first = worker.kick();
    await Promise.resolve();
    const overlapping = worker.kick();
    expect(runOnce).toHaveBeenCalledOnce();
    releaseFirst?.();
    await Promise.all([first, overlapping]);

    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
