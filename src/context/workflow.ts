import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  HouseholdContextRecordNotFoundError,
  HouseholdContextRevisionConflictError,
} from './mutation.js';
import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from './profile.js';
import type { HouseholdProfileSnapshot } from '../nextcloud/webdav-household-profile.js';
import {
  HouseholdContextSnapshotConflictError,
  type HouseholdContextMutationRecord,
  type HouseholdContextOutboxJob,
  type HouseholdContextStore,
} from '../storage/household-context-store.js';
import type {
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/client.js';

const MAXIMUM_ATTEMPTS = 5;

const talkReplyPayloadSchema = z.strictObject({
  roomToken: z.string().min(1).max(500),
  message: z.string().min(1).max(2_000),
  replyTo: z.string().min(1).max(500),
  referenceId: z.string().regex(/^[a-f0-9]{64}$/),
  silent: z.boolean(),
});

export interface HouseholdProfileRepositoryPort {
  read(signal?: AbortSignal): Promise<HouseholdProfileSnapshot | undefined>;
  create(
    profile: HouseholdProfile,
    signal?: AbortSignal,
  ): Promise<HouseholdProfileSnapshot>;
  replace(
    expectedEtag: string,
    profile: HouseholdProfile,
    signal?: AbortSignal,
  ): Promise<HouseholdProfileSnapshot>;
}

export interface HouseholdContextTalkSender {
  sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity>;
}

export interface HouseholdContextWorkflowOptions {
  readonly store: HouseholdContextStore;
  readonly profileRepository: HouseholdProfileRepositoryPort;
  readonly talk: HouseholdContextTalkSender;
  readonly timeZone?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

class ContextWorkflowError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Household context workflow stopped safely: ${code}`);
    this.name = 'ContextWorkflowError';
  }
}

class ContextApplyConflictError extends Error {
  constructor(readonly observedRevision: number) {
    super('Household context profile changed before its CAS write');
    this.name = 'ContextApplyConflictError';
  }
}

function sha256(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function createHouseholdContextWorkflowReplyReferenceId(
  idempotencyKey: string,
  purpose: string,
): string {
  return sha256(
    'household-context-workflow-talk-reply-v1',
    idempotencyKey,
    purpose,
  );
}

function retryAt(now: Date, attemptCount: number): string {
  const delaySeconds = Math.min(60, 2 ** attemptCount);
  return new Date(now.valueOf() + delaySeconds * 1_000).toISOString();
}

function validateMaximumJobs(maximumJobs: number): void {
  if (
    !Number.isSafeInteger(maximumJobs) ||
    maximumJobs <= 0 ||
    maximumJobs > 1_000
  ) {
    throw new RangeError('maximumJobs must be between 1 and 1000');
  }
}

function errorCodeValue(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

function profileFailure(
  error: unknown,
  operation: 'read' | 'write',
): ContextWorkflowError {
  if (error instanceof ContextWorkflowError) {
    return error;
  }
  const code = errorCodeValue(error);
  if (code === 'conflict') {
    return new ContextWorkflowError('profile-conflict', true);
  }
  if (code === 'read-failed') {
    return new ContextWorkflowError('profile-read-failed', true);
  }
  if (code === 'write-failed') {
    return new ContextWorkflowError('profile-write-failed', true);
  }
  if (
    code === 'invalid-configuration' ||
    code === 'invalid-etag' ||
    code === 'invalid-profile' ||
    code === 'profile-too-large'
  ) {
    return new ContextWorkflowError(`profile-${code}`, false);
  }
  return new ContextWorkflowError(`profile-${operation}-failed`, true);
}

async function readProfile(
  repository: HouseholdProfileRepositoryPort,
  signal: AbortSignal | undefined,
): Promise<HouseholdProfileSnapshot | undefined> {
  try {
    return await repository.read(signal);
  } catch (error) {
    throw profileFailure(error, 'read');
  }
}

async function readOrCreateProfile(
  repository: HouseholdProfileRepositoryPort,
  createdAt: string,
  timeZone: string,
  signal: AbortSignal | undefined,
): Promise<HouseholdProfileSnapshot> {
  const existing = await readProfile(repository, signal);
  if (existing !== undefined) {
    return existing;
  }
  const empty = createEmptyHouseholdProfile(createdAt, timeZone);
  try {
    return await repository.create(empty, signal);
  } catch (error) {
    if (errorCodeValue(error) !== 'conflict') {
      throw profileFailure(error, 'write');
    }
    const concurrentlyCreated = await readProfile(repository, signal);
    if (concurrentlyCreated === undefined) {
      throw new ContextWorkflowError('profile-create-conflict', true);
    }
    return concurrentlyCreated;
  }
}

function mutationReply(
  record: HouseholdContextMutationRecord,
  status: 'applied' | 'conflict' | 'failed',
  errorCode?: string,
): TalkReply & { replyTo: string; silent: false } {
  const purpose = `mutation-${status}${errorCode === undefined ? '' : `:${errorCode}`}`;
  const message =
    status === 'applied'
      ? 'Done — I updated what I remember about your household. Say “undo that” if anything looks wrong.'
      : status === 'conflict'
        ? 'I didn’t save that update because your household details changed while I was working. Nothing was overwritten. Please send the update again.'
        : 'I couldn’t save that household detail. Nothing was changed. Please try again in a moment.';
  return {
    roomToken: record.roomToken,
    message,
    replyTo: record.mutation.messageId,
    referenceId: createHouseholdContextWorkflowReplyReferenceId(
      record.idempotencyKey,
      purpose,
    ),
    silent: false,
  };
}

function undoReply(
  original: HouseholdContextMutationRecord,
  undoIdempotencyKey: string,
  messageId: string,
  status: 'applied' | 'conflict' | 'failed',
  errorCode?: string,
): TalkReply & { replyTo: string; silent: false } {
  const purpose = `undo-${status}${errorCode === undefined ? '' : `:${errorCode}`}`;
  const message =
    status === 'applied'
      ? 'Done — I undid the most recent household detail. Everything else was left alone.'
      : status === 'conflict'
        ? 'I couldn’t undo that because your household details changed afterward. Nothing was changed. Tell me which detail you want me to change instead.'
        : 'I couldn’t undo that household update. Nothing was changed. Please try again in a moment.';
  return {
    roomToken: original.roomToken,
    message,
    replyTo: messageId,
    referenceId: createHouseholdContextWorkflowReplyReferenceId(
      undoIdempotencyKey,
      purpose,
    ),
    silent: false,
  };
}

export class HouseholdContextWorkflow {
  readonly #store: HouseholdContextStore;
  readonly #profileRepository: HouseholdProfileRepositoryPort;
  readonly #talk: HouseholdContextTalkSender;
  readonly #timeZone: string;
  readonly #now: () => Date;
  readonly #signal: AbortSignal | undefined;

  constructor(options: HouseholdContextWorkflowOptions) {
    this.#store = options.store;
    this.#profileRepository = options.profileRepository;
    this.#talk = options.talk;
    this.#timeZone = options.timeZone ?? 'UTC';
    this.#now = options.now ?? (() => new Date());
    this.#signal = options.signal;
  }

  async processAvailable(maximumJobs = 25): Promise<number> {
    validateMaximumJobs(maximumJobs);
    let processed = 0;
    while (processed < maximumJobs) {
      const job = this.#store.claimNextOutbox(this.#now().toISOString());
      if (job === undefined) {
        break;
      }
      await this.#process(job);
      processed += 1;
    }
    return processed;
  }

  async #process(job: HouseholdContextOutboxJob): Promise<void> {
    try {
      switch (job.kind) {
        case 'send-context-mutation-acknowledgement':
        case 'send-context-mutation-result':
        case 'send-context-undo-acknowledgement':
        case 'send-context-undo-result':
          await this.#sendTalk(job);
          return;
        case 'apply-context-mutation':
          await this.#applyMutation(job);
          return;
        case 'apply-context-undo':
          await this.#applyUndo(job);
          return;
      }
    } catch (error) {
      await this.#handleFailure(job, error);
    }
  }

  async #sendTalk(job: HouseholdContextOutboxJob): Promise<void> {
    const payload = talkReplyPayloadSchema.parse(job.payload);
    try {
      await this.#talk.sendReplyWithIdentity(payload);
      this.#store.completeTalkReplyOutbox(
        job.id,
        payload.referenceId,
        this.#now().toISOString(),
      );
    } catch {
      const now = this.#now();
      if (job.attemptCount >= MAXIMUM_ATTEMPTS) {
        this.#store.deadLetterTalkReplyOutbox(
          job.id,
          'talk-reply-failed',
          now.toISOString(),
        );
      } else {
        this.#store.retryOutbox(
          job.id,
          'talk-reply-failed',
          retryAt(now, job.attemptCount),
        );
      }
    }
  }

  async #applyMutation(job: HouseholdContextOutboxJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new ContextWorkflowError('shutdown-requested', true);
    }
    const record = this.#store.getMutation(job.eventId);
    if (record === undefined) {
      throw new ContextWorkflowError('context-mutation-missing', false);
    }
    const snapshot = await readOrCreateProfile(
      this.#profileRepository,
      record.mutation.requestedAt,
      this.#timeZone,
      this.#signal,
    );
    const prepared = this.#store.prepareMutationApply(
      record.id,
      snapshot.profile,
      this.#now().toISOString(),
    );
    if (prepared.mode === 'write') {
      await this.#replaceWithCas(snapshot.etag, prepared.targetProfile);
    }
    const reply = mutationReply(record, 'applied');
    this.#store.completeMutationAppliedAndEnqueueResult(
      job.id,
      record.id,
      reply,
      `context-workflow-result:${reply.referenceId}`,
      this.#now().toISOString(),
    );
  }

  async #applyUndo(job: HouseholdContextOutboxJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new ContextWorkflowError('shutdown-requested', true);
    }
    if (job.undoIntentId === undefined) {
      throw new ContextWorkflowError('context-undo-missing', false);
    }
    const undo = this.#store.getUndoIntent(job.undoIntentId);
    const original = this.#store.getMutation(job.eventId);
    if (undo === undefined || original === undefined) {
      throw new ContextWorkflowError('context-undo-missing', false);
    }
    const snapshot = await readOrCreateProfile(
      this.#profileRepository,
      undo.requestedAt,
      this.#timeZone,
      this.#signal,
    );
    const prepared = this.#store.prepareUndoApply(
      undo.id,
      snapshot.profile,
      this.#now().toISOString(),
    );
    if (prepared.mode === 'write') {
      await this.#replaceWithCas(snapshot.etag, prepared.targetProfile);
    }
    const reply = undoReply(
      original,
      undo.idempotencyKey,
      undo.messageId,
      'applied',
    );
    this.#store.completeUndoAppliedAndEnqueueResult(
      job.id,
      undo.id,
      reply,
      `context-workflow-result:${reply.referenceId}`,
      this.#now().toISOString(),
    );
  }

  async #replaceWithCas(
    expectedEtag: string,
    targetProfile: HouseholdProfile,
  ): Promise<void> {
    try {
      await this.#profileRepository.replace(
        expectedEtag,
        targetProfile,
        this.#signal,
      );
    } catch (error) {
      if (errorCodeValue(error) !== 'conflict') {
        throw profileFailure(error, 'write');
      }
      const observed = await readProfile(this.#profileRepository, this.#signal);
      if (observed === undefined) {
        throw new ContextWorkflowError('profile-missing-after-conflict', false);
      }
      throw new ContextApplyConflictError(observed.profile.revision);
    }
  }

  async #handleFailure(
    job: HouseholdContextOutboxJob,
    error: unknown,
  ): Promise<void> {
    if (
      job.kind !== 'apply-context-mutation' &&
      job.kind !== 'apply-context-undo'
    ) {
      throw error;
    }
    const conflictRevision =
      error instanceof ContextApplyConflictError
        ? error.observedRevision
        : error instanceof HouseholdContextRevisionConflictError
          ? error.actualRevision
          : error instanceof HouseholdContextSnapshotConflictError
            ? error.observedRevision
            : undefined;
    const now = this.#now();
    if (conflictRevision !== undefined) {
      this.#completeConflict(job, conflictRevision, now.toISOString());
      return;
    }

    const failure =
      error instanceof ContextWorkflowError
        ? error
        : error instanceof HouseholdContextRecordNotFoundError ||
            error instanceof z.ZodError ||
            error instanceof TypeError
          ? new ContextWorkflowError('invalid-context-operation', false)
          : new ContextWorkflowError('context-processing-failed', true);
    if (failure.retryable && job.attemptCount < MAXIMUM_ATTEMPTS) {
      this.#store.retryOutbox(
        job.id,
        failure.code,
        retryAt(now, job.attemptCount),
      );
      return;
    }
    this.#completeFailure(job, failure.code, now.toISOString());
  }

  #completeConflict(
    job: HouseholdContextOutboxJob,
    observedRevision: number,
    now: string,
  ): void {
    if (job.kind === 'apply-context-mutation') {
      const record = this.#store.getMutation(job.eventId);
      if (record === undefined) {
        throw new Error('Context mutation disappeared during conflict');
      }
      const reply = mutationReply(record, 'conflict');
      this.#store.completeMutationConflictAndEnqueueResult(
        job.id,
        record.id,
        observedRevision,
        reply,
        `context-workflow-result:${reply.referenceId}`,
        now,
      );
      return;
    }
    const undo =
      job.undoIntentId === undefined
        ? undefined
        : this.#store.getUndoIntent(job.undoIntentId);
    const original = this.#store.getMutation(job.eventId);
    if (undo === undefined || original === undefined) {
      throw new Error('Context undo disappeared during conflict');
    }
    const reply = undoReply(
      original,
      undo.idempotencyKey,
      undo.messageId,
      'conflict',
    );
    this.#store.completeUndoConflictAndEnqueueResult(
      job.id,
      undo.id,
      observedRevision,
      reply,
      `context-workflow-result:${reply.referenceId}`,
      now,
    );
  }

  #completeFailure(
    job: HouseholdContextOutboxJob,
    errorCode: string,
    now: string,
  ): void {
    if (job.kind === 'apply-context-mutation') {
      const record = this.#store.getMutation(job.eventId);
      if (record === undefined) {
        throw new Error('Context mutation disappeared during failure');
      }
      const reply = mutationReply(record, 'failed', errorCode);
      this.#store.failMutationAndEnqueueResult(
        job.id,
        record.id,
        errorCode,
        reply,
        `context-workflow-result:${reply.referenceId}`,
        now,
      );
      return;
    }
    const undo =
      job.undoIntentId === undefined
        ? undefined
        : this.#store.getUndoIntent(job.undoIntentId);
    const original = this.#store.getMutation(job.eventId);
    if (undo === undefined || original === undefined) {
      throw new Error('Context undo disappeared during failure');
    }
    const reply = undoReply(
      original,
      undo.idempotencyKey,
      undo.messageId,
      'failed',
      errorCode,
    );
    this.#store.failUndoAndEnqueueResult(
      job.id,
      undo.id,
      errorCode,
      reply,
      `context-workflow-result:${reply.referenceId}`,
      now,
    );
  }
}

export class HouseholdContextWorker {
  readonly #workflow: HouseholdContextWorkflow;
  #running: Promise<number> | undefined;
  #rerunRequested = false;

  constructor(workflow: HouseholdContextWorkflow) {
    this.#workflow = workflow;
  }

  kick(): Promise<number> {
    if (this.#running !== undefined) {
      this.#rerunRequested = true;
      return this.#running;
    }
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #drain(): Promise<number> {
    let total = 0;
    do {
      this.#rerunRequested = false;
      total += await this.#workflow.processAvailable();
    } while (this.#rerunRequested);
    return total;
  }
}
