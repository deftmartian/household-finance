import { z } from 'zod';

import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from '../context/profile.js';
import { XaiStructuredClientError } from '../model/xai-structured-client.js';
import {
  type TransactionCategorizationJob,
  type TransactionCategorizationIgnoreReason,
  type TransactionCategorizationObserverRecord,
  type TransactionCategorizationScanResult,
  type TransactionCategorizationStore,
  type TransactionCategorizationTalkPayload,
  type TransactionCategoryUpdateRequest,
} from '../storage/transaction-categorization-store.js';
import type {
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/client.js';
import { appendFinanceInteractionReference } from '../talk/interaction-reference.js';
import { categoryTaxonomySchema, type CategoryTaxonomy } from './taxonomy.js';
import {
  decideTransactionCategorization,
  type TransactionCategorizationDecision,
  type TransactionSpecialCategoryAliases,
} from './transaction.js';
import type { TransactionCategoryClassifier } from './xai-classifiers.js';

const MAXIMUM_ATTEMPTS = 5;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const updateRequestSchema = z.strictObject({
  schemaVersion: z.literal('transaction-category-update-request.v1'),
  idempotencyKey: z.string().min(1).max(200),
  importedId: z.string().min(1).max(500),
  accountAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  observationFingerprint: hashSchema,
  categoryAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});
const talkPayloadSchema = z.strictObject({
  roomToken: z.string().min(1).max(500),
  message: z.string().min(1).max(2_000),
  referenceId: hashSchema,
  silent: z.boolean(),
});

export interface TransactionCategorizationScanPage {
  readonly watermark: string;
  readonly unchanged: boolean;
  readonly observations: readonly TransactionCategorizationObserverRecord[];
}

/**
 * The adapter owns date-window configuration and must omit deleted rows,
 * starting balances, and split children before returning this strict page.
 */
export interface TransactionCategorizationObservationSource {
  scan(
    previousWatermark: string | null,
    signal?: AbortSignal,
  ): Promise<TransactionCategorizationScanPage>;
}

export interface TransactionCategorizationProfileSource {
  read(signal?: AbortSignal): Promise<HouseholdProfile | undefined>;
}

export interface TransactionCategorizationTaxonomySource {
  read(signal?: AbortSignal): Promise<CategoryTaxonomy>;
}

export type TransactionCategoryUpdateReconciliation =
  'already-applied' | 'needs-apply' | 'conflict';

/**
 * Implementations resolve importedId and aliases inside the deterministic
 * update boundary. No Actual transaction ID or category ID crosses this port.
 */
export interface TransactionCategoryUpdateSink {
  reconcile(
    request: TransactionCategoryUpdateRequest,
    signal?: AbortSignal,
  ): Promise<TransactionCategoryUpdateReconciliation>;
  apply(
    request: TransactionCategoryUpdateRequest,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface TransactionCategorizationTalkSender {
  sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity>;
}

export interface TransactionCategorizationWorkflowOptions {
  readonly store: TransactionCategorizationStore;
  readonly observationSource: TransactionCategorizationObservationSource;
  readonly profileSource: TransactionCategorizationProfileSource;
  readonly taxonomySource: TransactionCategorizationTaxonomySource;
  readonly classifier: TransactionCategoryClassifier;
  readonly updateSink: TransactionCategoryUpdateSink;
  readonly talk: TransactionCategorizationTalkSender;
  readonly talkRoomToken: string;
  readonly specialCategoryAliases: TransactionSpecialCategoryAliases;
  readonly minimumAutoApplyConfidence?: number;
  readonly timeZone?: string;
  readonly receiptReservationSource?: {
    isImportedTransactionReserved(
      accountAlias: string,
      importedId: string,
    ): boolean;
  };
  readonly leaseDurationSeconds?: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface TransactionCategorizationRunResult {
  observed: number;
  duplicates: number;
  refreshed: number;
  requeued: number;
  conflicts: number;
  processed: number;
  watermark: string;
}

class CategorizationWorkflowError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Transaction categorization stopped safely: ${code}`);
    this.name = 'CategorizationWorkflowError';
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

function workflowFailure(error: unknown): CategorizationWorkflowError {
  if (error instanceof CategorizationWorkflowError) {
    return error;
  }
  if (error instanceof z.ZodError || error instanceof TypeError) {
    return new CategorizationWorkflowError(
      'invalid-categorization-context',
      false,
    );
  }
  return new CategorizationWorkflowError(
    'categorization-dependency-unavailable',
    true,
  );
}

function focusedQuestion(
  decision: Extract<
    TransactionCategorizationDecision,
    { disposition: 'clarify' }
  >,
  observer: TransactionCategorizationObserverRecord,
): string {
  if (decision.question !== undefined) {
    return decision.question;
  }
  const observation = observer.observation;
  const merchant = observation.payeeName ?? 'an unnamed payee';
  const amount = (Math.abs(observation.amountMinorUnits) / 100).toFixed(2);
  return `Which budget category should I use for the CAD ${amount} transaction at ${merchant} on ${observation.date}?`;
}

function applyConflictQuestion(): string {
  return 'This transaction changed before I could finish categorizing it. Which category should I use now?';
}

export class TransactionCategorizationWorkflow {
  readonly #store: TransactionCategorizationStore;
  readonly #observationSource: TransactionCategorizationObservationSource;
  readonly #profileSource: TransactionCategorizationProfileSource;
  readonly #taxonomySource: TransactionCategorizationTaxonomySource;
  readonly #classifier: TransactionCategoryClassifier;
  readonly #updateSink: TransactionCategoryUpdateSink;
  readonly #talk: TransactionCategorizationTalkSender;
  readonly #talkRoomToken: string;
  readonly #specialCategoryAliases: TransactionSpecialCategoryAliases;
  readonly #minimumAutoApplyConfidence: number;
  readonly #receiptReservations:
    | TransactionCategorizationWorkflowOptions['receiptReservationSource']
    | undefined;
  readonly #leaseDurationSeconds: number;
  readonly #now: () => Date;
  readonly #timeZone: string;
  readonly #signal: AbortSignal | undefined;

  constructor(options: TransactionCategorizationWorkflowOptions) {
    const leaseDurationSeconds = options.leaseDurationSeconds ?? 300;
    positiveInteger(leaseDurationSeconds, 'leaseDurationSeconds', 3_600);
    this.#store = options.store;
    this.#observationSource = options.observationSource;
    this.#profileSource = options.profileSource;
    this.#taxonomySource = options.taxonomySource;
    this.#classifier = options.classifier;
    this.#updateSink = options.updateSink;
    this.#talk = options.talk;
    this.#talkRoomToken = z
      .string()
      .min(1)
      .max(500)
      .parse(options.talkRoomToken);
    this.#specialCategoryAliases = {
      cashback: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,63}$/)
        .parse(options.specialCategoryAliases.cashback),
    };
    this.#minimumAutoApplyConfidence = z
      .number()
      .min(0)
      .max(1)
      .parse(options.minimumAutoApplyConfidence ?? 0.8);
    this.#receiptReservations = options.receiptReservationSource;
    this.#leaseDurationSeconds = leaseDurationSeconds;
    this.#now = options.now ?? (() => new Date());
    this.#timeZone = options.timeZone ?? 'UTC';
    this.#signal = options.signal;
  }

  async scanOnce(): Promise<TransactionCategorizationScanResult> {
    if (this.#signal?.aborted === true) {
      throw new CategorizationWorkflowError('shutdown-requested', true);
    }
    const previousWatermark = this.#store.getWatermark();
    const page = await this.#observationSource.scan(
      previousWatermark,
      this.#signal,
    );
    hashSchema.parse(page.watermark);
    if (
      !Array.isArray(page.observations) ||
      page.observations.length > 500 ||
      (page.unchanged &&
        (page.observations.length !== 0 ||
          page.watermark !== previousWatermark))
    ) {
      throw new TypeError('Categorization observer returned an invalid page');
    }
    return this.#store.recordScanPage({
      previousWatermark,
      watermark: page.watermark,
      observations: page.observations,
      observedAt: this.#now().toISOString(),
    });
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

  async runOnce(
    maximumJobs = 100,
  ): Promise<TransactionCategorizationRunResult> {
    const scan = await this.scanOnce();
    const processed = await this.processAvailable(maximumJobs);
    return {
      observed: scan.inserted,
      duplicates: scan.duplicates,
      refreshed: scan.refreshed,
      requeued: scan.requeued,
      conflicts: scan.conflicts,
      processed,
      watermark: scan.watermark,
    };
  }

  async #process(job: TransactionCategorizationJob): Promise<void> {
    try {
      switch (job.kind) {
        case 'classify-transaction':
          await this.#classify(job);
          return;
        case 'apply-transaction-category':
          await this.#apply(job);
          return;
        case 'send-transaction-categorization-clarification':
          await this.#sendTalk(job);
          return;
      }
    } catch (error) {
      const item = this.#store.getItem(job.eventId);
      if (
        item?.status === 'ignored' ||
        item?.status === 'attention' ||
        item?.status === 'applied' ||
        item?.status === 'failed'
      ) {
        return;
      }
      const failure = workflowFailure(error);
      const now = this.#now();
      if (failure.retryable && job.attemptCount < MAXIMUM_ATTEMPTS) {
        this.#store.retryJob(
          job.id,
          failure.code,
          retryAt(now, job.attemptCount),
        );
        return;
      }
      this.#store.failClaimedJob(
        job.id,
        job.eventId,
        failure.code,
        now.toISOString(),
      );
    }
  }

  async #classify(job: TransactionCategorizationJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new CategorizationWorkflowError('shutdown-requested', true);
    }
    const observer = this.#store.getObservation(job.eventId);
    let item = this.#store.getItem(job.eventId);
    if (observer === undefined || item === undefined) {
      throw new CategorizationWorkflowError('observation-missing', false);
    }
    if (item.status !== 'observed' && item.status !== 'planned') {
      throw new CategorizationWorkflowError(
        'observation-not-actionable',
        false,
      );
    }

    if (
      this.#receiptReservations?.isImportedTransactionReserved(
        observer.observation.accountAlias,
        observer.importedId,
      )
    ) {
      this.#store.recordIgnored(
        job.id,
        observer.id,
        'receipt-owned',
        this.#now().toISOString(),
      );
      return;
    }

    if (item.status === 'observed') {
      const ignored = this.#eligibilityIgnoreReason(observer);
      if (ignored !== undefined) {
        this.#store.recordIgnored(
          job.id,
          observer.id,
          ignored,
          this.#now().toISOString(),
        );
        return;
      }
    }

    const taxonomy = categoryTaxonomySchema.parse(
      await this.#taxonomySource.read(this.#signal),
    );
    const profile =
      (await this.#profileSource.read(this.#signal)) ??
      createEmptyHouseholdProfile(this.#now().toISOString(), this.#timeZone);

    if (item.status === 'observed') {
      const deterministic = decideTransactionCategorization({
        observation: observer.observation,
        profile,
        taxonomy,
        specialCategoryAliases: this.#specialCategoryAliases,
        minimumAutoApplyConfidence: this.#minimumAutoApplyConfidence,
        now: this.#now().toISOString(),
      });
      if (deterministic !== undefined) {
        this.#persistDecision(job, observer, deterministic);
        return;
      }

      this.#store.startProviderCall(
        job.id,
        observer.id,
        this.#now().toISOString(),
      );
      let run;
      try {
        run = await this.#classifier.classify(
          observer.observation,
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
            observer.id,
            code,
            retryAt(now, job.attemptCount),
            now.toISOString(),
          );
          return;
        }
        this.#store.failClaimedJob(
          job.id,
          observer.id,
          code,
          now.toISOString(),
        );
        return;
      }

      try {
        this.#store.recordProposal(
          job.id,
          observer.id,
          run.proposal,
          run.metadata,
          this.#now().toISOString(),
        );
      } catch {
        if (this.#store.getItem(observer.id)?.status === 'failed') {
          return;
        }
        this.#store.failClaimedJob(
          job.id,
          observer.id,
          'invalid-model-proposal',
          this.#now().toISOString(),
        );
        return;
      }
      item = this.#store.getItem(observer.id);
    }

    if (item?.status !== 'planned' || item.proposal === undefined) {
      throw new CategorizationWorkflowError(
        'persisted-model-proposal-missing',
        false,
      );
    }
    const decision = decideTransactionCategorization({
      observation: observer.observation,
      profile,
      taxonomy,
      modelProposal: item.proposal,
      specialCategoryAliases: this.#specialCategoryAliases,
      minimumAutoApplyConfidence: this.#minimumAutoApplyConfidence,
      now: this.#now().toISOString(),
    });
    if (decision === undefined) {
      throw new CategorizationWorkflowError(
        'persisted-model-proposal-missing',
        false,
      );
    }
    this.#persistDecision(job, observer, decision);
  }

  #eligibilityIgnoreReason(
    observer: TransactionCategorizationObserverRecord,
  ): TransactionCategorizationIgnoreReason | undefined {
    if (!observer.accountOnBudget) {
      return 'excluded-account';
    }
    if (observer.split || observer.currentCategoryStatus === 'split') {
      return 'split-transaction';
    }
    if (observer.currentCategoryStatus !== 'uncategorized') {
      return 'currently-categorized';
    }
    switch (observer.observation.specialKind) {
      case 'transfer':
      case 'card-payment':
      case 'debt-payment':
        return observer.observation.specialKind;
      case 'ordinary':
      case 'cashback':
        return undefined;
    }
  }

  #persistDecision(
    job: TransactionCategorizationJob,
    observer: TransactionCategorizationObserverRecord & { id: string },
    decision: TransactionCategorizationDecision,
  ): void {
    const now = this.#now().toISOString();
    switch (decision.disposition) {
      case 'apply':
        this.#store.recordReady(
          job.id,
          observer.id,
          decision.categoryAlias,
          decision.source,
          now,
        );
        return;
      case 'ignore':
        this.#store.recordIgnored(job.id, observer.id, decision.reason, now);
        return;
      case 'clarify':
        this.#store.recordAttentionAndEnqueueClarification(
          job.id,
          observer.id,
          decision.reason,
          focusedQuestion(decision, observer),
          this.#talkRoomToken,
          now,
        );
    }
  }

  async #apply(job: TransactionCategorizationJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new CategorizationWorkflowError('shutdown-requested', true);
    }
    const request = updateRequestSchema.parse(
      job.payload,
    ) as TransactionCategoryUpdateRequest;
    if (
      this.#receiptReservations?.isImportedTransactionReserved(
        request.accountAlias,
        request.importedId,
      )
    ) {
      this.#store.recordReceiptOwned(
        job.id,
        job.eventId,
        this.#now().toISOString(),
      );
      return;
    }
    const reconciliation = await this.#updateSink.reconcile(
      request,
      this.#signal,
    );
    if (
      this.#receiptReservations?.isImportedTransactionReserved(
        request.accountAlias,
        request.importedId,
      )
    ) {
      this.#store.recordReceiptOwned(
        job.id,
        job.eventId,
        this.#now().toISOString(),
      );
      return;
    }
    switch (reconciliation) {
      case 'already-applied':
        this.#store.recordApplied(
          job.id,
          job.eventId,
          this.#now().toISOString(),
        );
        return;
      case 'conflict':
        this.#store.recordApplyConflictAndEnqueueClarification(
          job.id,
          job.eventId,
          applyConflictQuestion(),
          this.#talkRoomToken,
          this.#now().toISOString(),
        );
        return;
      case 'needs-apply':
        await this.#updateSink.apply(request, this.#signal);
        this.#store.recordApplied(
          job.id,
          job.eventId,
          this.#now().toISOString(),
        );
    }
  }

  async #sendTalk(job: TransactionCategorizationJob): Promise<void> {
    const payload = talkPayloadSchema.parse(
      job.payload,
    ) as TransactionCategorizationTalkPayload;
    try {
      const delivered = await this.#talk.sendReplyWithIdentity({
        ...payload,
        message: appendFinanceInteractionReference(payload.message, {
          kind: 'transaction-category',
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
        this.#store.deadLetterTalkJob(
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
}

export class TransactionCategorizationWorker {
  readonly #workflow: TransactionCategorizationWorkflow;
  #running: Promise<TransactionCategorizationRunResult> | undefined;

  constructor(workflow: TransactionCategorizationWorkflow) {
    this.#workflow = workflow;
  }

  kick(): Promise<TransactionCategorizationRunResult> {
    this.#running ??= this.#workflow.runOnce().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }
}
