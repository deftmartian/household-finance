import { z } from 'zod';

import { buildReceiptMatchIntent } from '../matching/index.js';
import {
  householdFinanceActiveReceiptRecordSchema,
  householdFinanceReceiptSha256,
  MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
  receiptRecordItemDetailsComplete,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../receipt-record/index.js';
import {
  type ReadyReceiptCategorizationRecord,
  type ReceiptCategorizationJob,
  type ReceiptCategorizationSource,
  type ReceiptCategorizationStore,
  type ReceiptCategorizationTalkPayload,
} from '../storage/receipt-categorization-store.js';
import {
  ReceiptMatchStoreBusyError,
  ReceiptMatchStoreConflictError,
  ReceiptMatchIgnoredError,
  type ReceiptMatchStore,
} from '../storage/receipt-match-store.js';
import type {
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/client.js';
import { appendFinanceInteractionReference } from '../talk/interaction-reference.js';
import { XaiStructuredClientError } from '../model/xai-structured-client.js';
import {
  evaluateReceiptCategorization,
  isReceiptCategorizationDeterministicallyReevaluatable,
  type ReceiptCategorizationResult,
  type ReceiptCategoryProposal,
} from './receipt.js';
import { categoryTaxonomySchema, type CategoryTaxonomy } from './taxonomy.js';
import type { ReceiptItemCategoryClassifier } from './xai-classifiers.js';

const MAXIMUM_ATTEMPTS = 5;
const talkPayloadSchema = z.strictObject({
  roomToken: z.string().min(1).max(500),
  message: z.string().min(1).max(2_000),
  replyTo: z.string().min(1).max(500),
  referenceId: z.string().regex(/^[a-f0-9]{64}$/),
  silent: z.boolean(),
});

export interface ActiveReceiptRecordSource {
  listActiveRecords(
    limit?: number,
  ): readonly HouseholdFinanceActiveReceiptRecordV1[];
  isCurrentReceiptSource?(receiptId: string, sourceSha256: string): boolean;
}

export interface ReceiptCategorizationTaxonomySource {
  read(signal?: AbortSignal): Promise<CategoryTaxonomy>;
}

/**
 * The implementation must use record.idempotencyKey when crossing into the
 * matcher. A repeat call after an uncertain process exit must be a no-op.
 */
export interface ReadyReceiptCategorizationPublisher {
  publishMatchable(record: ReceiptCategorizationSource): void;
  publish(
    record: ReadyReceiptCategorizationRecord,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Narrow, idempotent bridge into ReceiptMatchStore. The matcher persists only
 * a deterministic receipt intent; exact category splits stay in
 * ReceiptCategorizationStore for the eventual update-existing applier.
 */
export class ReceiptMatchStoreCategorizationPublisher implements ReadyReceiptCategorizationPublisher {
  readonly #matches: Pick<ReceiptMatchStore, 'recordReceipt'>;
  readonly #now: () => Date;

  constructor(
    matches: Pick<ReceiptMatchStore, 'recordReceipt'>,
    now: () => Date = () => new Date(),
  ) {
    this.#matches = matches;
    this.#now = now;
  }

  #publishMatchable(input: {
    readonly idempotencyKey: string;
    readonly receivedAt: string;
    readonly record: HouseholdFinanceActiveReceiptRecordV1;
  }): void {
    const match = buildReceiptMatchIntent(input.record);
    if (match.disposition !== 'ready') {
      throw new TypeError(
        `Matchable receipt cannot enter matching: ${match.reason}`,
      );
    }
    try {
      this.#matches.recordReceipt({
        idempotencyKey: input.idempotencyKey,
        intent: match.intent,
        receivedAt: input.receivedAt,
        matchRequestedAt: this.#now().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof ReceiptMatchIgnoredError)) {
        throw error;
      }
    }
  }

  publishMatchable(record: ReceiptCategorizationSource): void {
    this.#publishMatchable({
      idempotencyKey: `receipt-source-sha256:${record.sourceSha256}`,
      receivedAt: record.receivedAt,
      record: record.record,
    });
  }

  publish(record: ReadyReceiptCategorizationRecord): Promise<void> {
    this.#publishMatchable({
      idempotencyKey: record.idempotencyKey,
      receivedAt: record.receivedAt,
      record: record.record,
    });
    return Promise.resolve();
  }
}

export interface ReceiptCategorizationTalkSender {
  sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity>;
}

export interface ReceiptCategorizationWorkflowOptions {
  readonly store: ReceiptCategorizationStore;
  readonly records: ActiveReceiptRecordSource;
  readonly taxonomySource: ReceiptCategorizationTaxonomySource;
  readonly classifier: ReceiptItemCategoryClassifier;
  readonly publisher: ReadyReceiptCategorizationPublisher;
  readonly talk: ReceiptCategorizationTalkSender;
  readonly leaseDurationSeconds?: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface ReceiptCategorizationIngestResult {
  inserted: number;
  duplicates: number;
  invalid: number;
}

export interface ReceiptCategorizationRunResult extends ReceiptCategorizationIngestResult {
  processed: number;
}

class ReceiptCategorizationWorkflowError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Receipt categorization stopped safely: ${code}`);
    this.name = 'ReceiptCategorizationWorkflowError';
  }
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${name} must be a positive integer no greater than ${String(maximum)}`,
    );
  }
}

function retryAt(now: Date, attemptCount: number): string {
  return new Date(
    now.valueOf() + Math.min(60, 2 ** attemptCount) * 1_000,
  ).toISOString();
}

function modelErrorCode(error: unknown): string {
  return error instanceof XaiStructuredClientError
    ? `model-${error.code}`
    : 'model-classification-failed';
}

function workflowFailure(error: unknown): ReceiptCategorizationWorkflowError {
  if (error instanceof ReceiptCategorizationWorkflowError) {
    return error;
  }
  if (error instanceof z.ZodError || error instanceof TypeError) {
    return new ReceiptCategorizationWorkflowError(
      'invalid-receipt-categorization-context',
      false,
    );
  }
  if (error instanceof ReceiptMatchStoreConflictError) {
    return new ReceiptCategorizationWorkflowError(
      'receipt-revision-needs-review',
      false,
    );
  }
  if (error instanceof ReceiptMatchStoreBusyError) {
    return new ReceiptCategorizationWorkflowError(
      'receipt-match-still-processing',
      true,
    );
  }
  return new ReceiptCategorizationWorkflowError(
    'receipt-categorization-dependency-unavailable',
    true,
  );
}

function safeLabel(value: string | null): string {
  if (value === null) {
    return 'unnamed item';
  }
  const normalized = [...value.normalize('NFC')]
    .map((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f)
        ? ' '
        : character;
    })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return normalized.length === 0 ? 'unnamed item' : normalized.slice(0, 80);
}

function focusedClarification(
  receipt: HouseholdFinanceActiveReceiptRecordV1,
  proposal: ReceiptCategoryProposal,
  result: Extract<ReceiptCategorizationResult, { disposition: 'review' }>,
): string {
  const merchant = safeLabel(receipt.merchant);
  if (
    !result.issueCodes.includes('receipt-not-ready') &&
    !receiptRecordItemDetailsComplete(receipt)
  ) {
    return `I saved the ${merchant} receipt, but I couldn't read enough item amounts to split it exactly. Reply with one category for the whole purchase.`;
  }
  const uncertainIndexes = new Set<number>();
  for (const uncertainty of proposal.uncertainties) {
    if (uncertainty.material && uncertainty.itemIndex !== null) {
      uncertainIndexes.add(uncertainty.itemIndex);
    }
  }
  const classifiedIndexes = new Set(
    proposal.items.map((item) => item.itemIndex),
  );
  for (const [index] of receipt.items.entries()) {
    if (!classifiedIndexes.has(index)) {
      uncertainIndexes.add(index);
    }
  }
  const indexes =
    uncertainIndexes.size === 0
      ? receipt.items.map((_item, index) => index)
      : [...uncertainIndexes].sort((left, right) => left - right);
  const labels = indexes
    .slice(0, 5)
    .map((index) => safeLabel(receipt.items[index]?.description ?? null));
  const remaining = Math.max(0, indexes.length - labels.length);
  const items =
    labels.length === 0
      ? 'the receipt items'
      : `${labels.join(', ')}${remaining === 0 ? '' : `, and ${String(remaining)} more`}`;
  const reason = result.issueCodes.includes('receipt-not-ready')
    ? "I couldn't read enough of it to choose categories reliably."
    : `I'm not sure which category best fits ${items}.`;
  return `I saved the ${merchant} receipt, but ${reason} Reply with one category for the unclear items; I'll keep the other item categories as they are.`;
}

function canonicalSources(
  records: readonly HouseholdFinanceActiveReceiptRecordV1[],
): {
  sources: ReceiptCategorizationSource[];
  invalid: number;
} {
  const canonical = new Map<string, ReceiptCategorizationSource>();
  let invalid = 0;
  for (const candidate of records) {
    const parsedRecord =
      householdFinanceActiveReceiptRecordSchema.safeParse(candidate);
    if (
      !parsedRecord.success ||
      parsedRecord.data.extraction.automaticProcessingBlocked === true
    ) {
      invalid += 1;
      continue;
    }
    const record = parsedRecord.data;
    if (
      buildReceiptMatchIntent(record).disposition !== 'ready' ||
      record.paymentEvidence.kind === 'cash'
    ) {
      invalid += 1;
      continue;
    }
    const primarySource = record.sources[0]!;
    const source: ReceiptCategorizationSource = {
      schemaVersion: 'receipt-categorization-source.v1',
      eventId: record.receiptId,
      sourceSha256: householdFinanceReceiptSha256(record),
      roomToken: primarySource.talk.roomToken,
      messageId: primarySource.talk.messageId,
      receivedAt: primarySource.receivedAt,
      record,
    };
    const existing = canonical.get(source.sourceSha256);
    if (
      existing === undefined ||
      source.receivedAt < existing.receivedAt ||
      (source.receivedAt === existing.receivedAt &&
        source.eventId < existing.eventId)
    ) {
      canonical.set(source.sourceSha256, source);
    }
  }
  return {
    sources: [...canonical.values()].sort((left, right) =>
      left.receivedAt === right.receivedAt
        ? left.eventId.localeCompare(right.eventId)
        : left.receivedAt.localeCompare(right.receivedAt),
    ),
    invalid,
  };
}

export class ReceiptCategorizationWorkflow {
  readonly #store: ReceiptCategorizationStore;
  readonly #records: ActiveReceiptRecordSource;
  readonly #taxonomySource: ReceiptCategorizationTaxonomySource;
  readonly #classifier: ReceiptItemCategoryClassifier;
  readonly #publisher: ReadyReceiptCategorizationPublisher;
  readonly #talk: ReceiptCategorizationTalkSender;
  readonly #leaseDurationSeconds: number;
  readonly #now: () => Date;
  readonly #signal: AbortSignal | undefined;

  constructor(options: ReceiptCategorizationWorkflowOptions) {
    const leaseDurationSeconds = options.leaseDurationSeconds ?? 300;
    positiveInteger(leaseDurationSeconds, 'leaseDurationSeconds', 3_600);
    this.#store = options.store;
    this.#records = options.records;
    this.#taxonomySource = options.taxonomySource;
    this.#classifier = options.classifier;
    this.#publisher = options.publisher;
    this.#talk = options.talk;
    this.#leaseDurationSeconds = leaseDurationSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#signal = options.signal;
  }

  ingestActiveRecords(): ReceiptCategorizationIngestResult {
    const { sources, invalid } = canonicalSources(
      this.#records.listActiveRecords(MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS),
    );
    let inserted = 0;
    let duplicates = 0;
    for (const source of sources) {
      if (this.#store.getBySourceSha256(source.sourceSha256) === undefined) {
        try {
          this.#publisher.publishMatchable(source);
        } catch (error) {
          if (error instanceof ReceiptMatchStoreBusyError) {
            continue;
          }
          if (!(error instanceof ReceiptMatchStoreConflictError)) {
            throw error;
          }
        }
      }
      const result = this.#store.recordCanonical(
        source,
        this.#now().toISOString(),
      );
      if (result.inserted) {
        inserted += 1;
      } else {
        duplicates += 1;
      }
    }
    return { inserted, duplicates, invalid };
  }

  async processAvailable(maximumJobs = 100): Promise<number> {
    positiveInteger(maximumJobs, 'maximumJobs', 1_000);
    this.#store.recoverExpiredJobs(this.#now().toISOString());
    let processed = 0;
    while (processed < maximumJobs) {
      const job = this.#store.claimNextJob(
        this.#now().toISOString(),
        this.#leaseDurationSeconds,
      );
      if (job === undefined) {
        break;
      }
      await this.#process(job);
      processed += 1;
    }
    return processed;
  }

  async runOnce(maximumJobs = 100): Promise<ReceiptCategorizationRunResult> {
    const intake = this.ingestActiveRecords();
    await this.#reconcileDeterministicAttention();
    const processed = await this.processAvailable(maximumJobs);
    return { ...intake, processed };
  }

  async #reconcileDeterministicAttention(): Promise<void> {
    const candidates = canonicalSources(
      this.#records.listActiveRecords(MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS),
    ).sources.flatMap((candidate) => {
      const source = this.#store.getBySourceSha256(candidate.sourceSha256);
      if (source === undefined) {
        return [];
      }
      const item = this.#store.getItem(source.eventId);
      if (
        item?.status !== 'attention' ||
        item.proposal === undefined ||
        item.decision === undefined ||
        !isReceiptCategorizationDeterministicallyReevaluatable(item.decision)
      ) {
        return [];
      }
      return [{ source, proposal: item.proposal }];
    });
    if (candidates.length === 0) {
      return;
    }
    const taxonomy = categoryTaxonomySchema.parse(
      await this.#taxonomySource.read(this.#signal),
    );
    const now = this.#now().toISOString();
    for (const candidate of candidates) {
      const result = evaluateReceiptCategorization(
        candidate.source.record,
        candidate.proposal,
        taxonomy,
      );
      if (result.disposition === 'ready') {
        this.#store.recordDeterministicReevaluation(
          candidate.source.eventId,
          result,
          now,
        );
      }
    }
  }

  async #process(job: ReceiptCategorizationJob): Promise<void> {
    try {
      switch (job.kind) {
        case 'classify-receipt-items':
          await this.#classify(job);
          return;
        case 'publish-ready-receipt':
          await this.#publish(job);
          return;
        case 'send-receipt-categorization-clarification':
          await this.#sendTalk(job);
          return;
      }
    } catch (error) {
      const item = this.#store.getItem(job.eventId);
      if (
        item?.status === 'attention' ||
        item?.status === 'published' ||
        item?.status === 'failed'
      ) {
        return;
      }
      const failure = workflowFailure(error);
      const now = this.#now();
      if (
        job.kind === 'publish-ready-receipt' &&
        failure.code === 'receipt-match-still-processing'
      ) {
        this.#store.deferPublishJob(
          job.id,
          job.eventId,
          new Date(now.valueOf() + 5_000).toISOString(),
          now.toISOString(),
        );
        return;
      }
      if (failure.retryable && job.attemptCount < MAXIMUM_ATTEMPTS) {
        this.#store.retryJob(
          job.id,
          failure.code,
          retryAt(now, job.attemptCount),
        );
        return;
      }
      this.#store.deadLetterJob(
        job.id,
        job.eventId,
        failure.code,
        now.toISOString(),
      );
      this.#queueFailureNotice(job.eventId);
    }
  }

  async #classify(job: ReceiptCategorizationJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new ReceiptCategorizationWorkflowError('shutdown-requested', true);
    }
    const source = this.#store.getSource(job.eventId);
    let item = this.#store.getItem(job.eventId);
    if (source === undefined || item === undefined) {
      throw new ReceiptCategorizationWorkflowError(
        'receipt-source-missing',
        false,
      );
    }
    if (item.status !== 'observed' && item.status !== 'planned') {
      throw new ReceiptCategorizationWorkflowError(
        'receipt-not-actionable',
        false,
      );
    }
    const taxonomy = categoryTaxonomySchema.parse(
      await this.#taxonomySource.read(this.#signal),
    );

    if (item.status === 'observed') {
      this.#store.startProviderCall(
        job.id,
        job.eventId,
        this.#now().toISOString(),
      );
      let run;
      try {
        run = await this.#classifier.classify(
          source.record,
          taxonomy,
          this.#signal,
        );
      } catch (error) {
        const code = modelErrorCode(error);
        const now = this.#now();
        if (
          error instanceof XaiStructuredClientError &&
          error.code === 'request-aborted-before-send' &&
          job.attemptCount < MAXIMUM_ATTEMPTS
        ) {
          this.#store.clearProviderCallAndRetry(
            job.id,
            job.eventId,
            code,
            retryAt(now, job.attemptCount),
            now.toISOString(),
          );
          return;
        }
        this.#store.deadLetterJob(job.id, job.eventId, code, now.toISOString());
        this.#queueFailureNotice(job.eventId);
        return;
      }

      try {
        this.#store.recordProposal(
          job.id,
          job.eventId,
          run.proposal,
          run.metadata,
          this.#now().toISOString(),
        );
      } catch {
        if (this.#store.getItem(job.eventId)?.status === 'failed') {
          this.#queueFailureNotice(job.eventId);
          return;
        }
        this.#store.deadLetterJob(
          job.id,
          job.eventId,
          'invalid-model-proposal',
          this.#now().toISOString(),
        );
        this.#queueFailureNotice(job.eventId);
        return;
      }
      item = this.#store.getItem(job.eventId);
    }

    if (item?.status !== 'planned' || item.proposal === undefined) {
      throw new ReceiptCategorizationWorkflowError(
        'persisted-model-proposal-missing',
        false,
      );
    }
    const result = evaluateReceiptCategorization(
      source.record,
      item.proposal,
      taxonomy,
    );
    this.#store.recordEvaluation(
      job.id,
      job.eventId,
      result,
      result.disposition === 'review'
        ? focusedClarification(source.record, item.proposal, result)
        : 'Receipt categorization is ready.',
      this.#now().toISOString(),
    );
  }

  async #publish(job: ReceiptCategorizationJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new ReceiptCategorizationWorkflowError('shutdown-requested', true);
    }
    const ready = this.#store.getReadyReceipt(job.eventId);
    if (ready === undefined || ready.status !== 'ready') {
      throw new ReceiptCategorizationWorkflowError(
        'ready-receipt-missing',
        false,
      );
    }
    if (
      this.#records.isCurrentReceiptSource?.(
        ready.receiptId,
        ready.sourceSha256,
      ) === false
    ) {
      this.#store.deadLetterJob(
        job.id,
        job.eventId,
        'superseded-by-canonical-revision',
        this.#now().toISOString(),
      );
      return;
    }
    await this.#publisher.publish(ready, this.#signal);
    this.#store.markPublished(job.id, job.eventId, this.#now().toISOString());
  }

  async #sendTalk(job: ReceiptCategorizationJob): Promise<void> {
    const payload = talkPayloadSchema.parse(
      job.payload,
    ) as ReceiptCategorizationTalkPayload;
    try {
      const item = this.#store.getItem(job.eventId);
      const delivered = await this.#talk.sendReplyWithIdentity({
        ...payload,
        message:
          item?.status === 'failed'
            ? payload.message
            : appendFinanceInteractionReference(payload.message, {
                kind: 'receipt-category',
                referenceId: payload.referenceId,
              }),
      });
      this.#store.completeTalkJob(
        job.id,
        job.eventId,
        delivered,
        this.#now().toISOString(),
      );
    } catch {
      const now = this.#now();
      if (job.attemptCount >= MAXIMUM_ATTEMPTS) {
        this.#store.deadLetterJob(
          job.id,
          job.eventId,
          'talk-reply-failed',
          now.toISOString(),
        );
      } else {
        this.#store.retryJob(
          job.id,
          'talk-reply-failed',
          retryAt(now, job.attemptCount),
        );
      }
    }
  }

  #queueFailureNotice(eventId: string): void {
    this.#store.enqueueFailureNotice(eventId, this.#now().toISOString());
  }
}

export class ReceiptCategorizationWorker {
  readonly #workflow: ReceiptCategorizationWorkflow;
  #running: Promise<ReceiptCategorizationRunResult> | undefined;
  #rerunRequested = false;

  constructor(workflow: ReceiptCategorizationWorkflow) {
    this.#workflow = workflow;
  }

  kick(): Promise<ReceiptCategorizationRunResult> {
    this.#rerunRequested = true;
    this.#running ??= this.#runUntilQuiet();
    return this.#running;
  }

  async #runUntilQuiet(): Promise<ReceiptCategorizationRunResult> {
    try {
      let result: ReceiptCategorizationRunResult;
      do {
        this.#rerunRequested = false;
        result = await this.#workflow.runOnce();
      } while (this.#rerunRequested);
      return result;
    } finally {
      this.#running = undefined;
    }
  }
}
