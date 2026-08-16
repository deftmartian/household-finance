import { z } from 'zod';

import type { HouseholdProfile } from '../context/profile.js';
import { XaiSpeechToTextError } from '../model/xai-speech-to-text.js';
import { XaiStructuredClientError } from '../model/xai-structured-client.js';
import { WebDavFileSourceError } from '../nextcloud/index.js';
import {
  createQuestionTalkReplyReferenceId,
  type QuestionOutboxJob,
  type QuestionStore,
  type QuestionTalkReplyPayload,
  type QuestionVoiceOutboxJob,
} from '../storage/question-store.js';
import type {
  TalkConversationSpeaker,
  TalkConversationTurn,
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/client.js';
import type { TalkVoiceAttachmentReference } from '../talk/webhook.js';
import {
  FinanceQuestionAgentError,
  type FinanceQuestionAgent,
  type FinanceAgentConversationTurn,
  type FinanceAgentCurrentMember,
  FinanceQuestionToolReplyHandledError,
  MAX_HOUSEHOLD_CONTEXT_CHARACTERS,
} from './xai-finance-agent.js';

const talkReplyPayloadSchema = z.strictObject({
  roomToken: z.string().min(1),
  message: z.string().min(1).max(8_000),
  replyTo: z.string().regex(/^[1-9]\d*$/),
  referenceId: z.string().regex(/^[a-f0-9]{64}$/),
  silent: z.boolean(),
});
const MAXIMUM_AGENT_HISTORY_TURNS = 16;
const MAXIMUM_JOB_ATTEMPTS = 5;
const TERMINAL_AGENT_FAILURE_MESSAGE =
  'I hit a problem before I could finish that. If you asked for a change, it may already be underway; otherwise nothing needs your attention. Please try again in a moment.';
const TERMINAL_VOICE_FAILURE_MESSAGE =
  'I couldn’t finish transcribing that voice message. Please send it again or type it out, and I’ll help from there.';

export interface FinanceQuestionTalkSender {
  sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity>;
}

export interface FinanceQuestionProfileSource {
  read(): Promise<{ profile: HouseholdProfile } | undefined>;
}

export interface FinanceQuestionConversationHistorySource {
  recentConversation(
    roomToken: string,
    limit?: number,
    throughMessageId?: string,
  ): Promise<readonly TalkConversationTurn[]>;
}

export interface FinanceQuestionVoiceTranscriber {
  transcribe(
    attachment: TalkVoiceAttachmentReference,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface FinanceQuestionWorkflowOptions {
  readonly store: QuestionStore;
  readonly agent: FinanceQuestionAgent;
  readonly talk: FinanceQuestionTalkSender;
  readonly timeZone: string;
  readonly allowedUserIds: readonly string[];
  readonly profileSource?: FinanceQuestionProfileSource;
  readonly conversationHistorySource?: FinanceQuestionConversationHistorySource;
  readonly voiceTranscriber?: FinanceQuestionVoiceTranscriber;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

class TerminalQuestionError extends Error {
  constructor(readonly code: string) {
    super(`Finance question stopped safely: ${code}`);
    this.name = 'TerminalQuestionError';
  }
}

class TerminalVoiceError extends Error {
  constructor(readonly code: string) {
    super(`Voice transcription stopped safely: ${code}`);
    this.name = 'TerminalVoiceError';
  }
}

type VoiceFailureDisposition = {
  readonly action: 'interrupt' | 'retry' | 'terminal';
  readonly terminalCode: string;
};

function transientHttpStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
}

function voiceFailureDisposition(error: unknown): VoiceFailureDisposition {
  if (error instanceof TerminalVoiceError) {
    return { action: 'terminal', terminalCode: error.code };
  }
  if (error instanceof WebDavFileSourceError) {
    return {
      action:
        error.code === 'download-failed' ||
        error.code === 'file-not-found' ||
        error.code === 'search-failed'
          ? 'retry'
          : 'terminal',
      terminalCode: 'voice-transcription-rejected',
    };
  }
  if (error instanceof XaiStructuredClientError) {
    if (
      error.code === 'request-aborted' ||
      error.code === 'request-aborted-before-send'
    ) {
      return {
        action: 'interrupt',
        terminalCode: 'voice-transcription-interrupted',
      };
    }
    if (
      error.phase === 'preflight' &&
      (error.code === 'network-error' ||
        error.code === 'request-timeout' ||
        (error.code === 'http-error' && transientHttpStatus(error.httpStatus)))
    ) {
      return {
        action: 'retry',
        terminalCode: 'voice-transcription-failed',
      };
    }
    return {
      action: 'terminal',
      terminalCode:
        error.code === 'zdr-required'
          ? 'voice-zdr-required'
          : 'voice-transcription-rejected',
    };
  }
  if (error instanceof XaiSpeechToTextError) {
    if (error.code === 'request-aborted') {
      return {
        action: 'interrupt',
        terminalCode: 'voice-transcription-interrupted',
      };
    }
    if (
      error.code === 'network-error' ||
      error.code === 'request-timeout' ||
      (error.code === 'http-error' && transientHttpStatus(error.httpStatus))
    ) {
      return {
        action: 'retry',
        terminalCode: 'voice-transcription-failed',
      };
    }
    return {
      action: 'terminal',
      terminalCode:
        error.code === 'zdr-required'
          ? 'voice-zdr-required'
          : 'voice-transcription-rejected',
    };
  }
  return {
    action: 'terminal',
    terminalCode: 'voice-transcription-failed',
  };
}

interface TerminalQuestionFailure {
  readonly code: string;
  readonly diagnostic?: Readonly<Record<string, string | number>>;
}

function terminalFailure(error: unknown): TerminalQuestionFailure | undefined {
  if (error instanceof TerminalQuestionError) {
    return { code: error.code };
  }
  if (error instanceof FinanceQuestionAgentError) {
    return {
      code: `model-${error.code}`,
      diagnostic: {
        source: 'finance-agent',
        ...(error.responseStage === undefined
          ? {}
          : { responseStage: error.responseStage }),
      },
    };
  }
  if (error instanceof XaiStructuredClientError) {
    return {
      code: `model-${error.code}`,
      diagnostic: {
        source: 'xai',
        phase: error.phase,
        ...(error.responseStage === undefined
          ? {}
          : { responseStage: error.responseStage }),
        ...(error.httpStatus === undefined
          ? {}
          : { httpStatus: error.httpStatus }),
      },
    };
  }
  return undefined;
}

function currentDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (value === undefined) {
      throw new TerminalQuestionError('current-date-unavailable');
    }
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function contextRecordIsActive(
  record: {
    readonly status: 'confirmed' | 'candidate';
    readonly validFrom?: string | undefined;
    readonly expiresAt?: string | undefined;
  },
  currentDate: string,
  currentInstant: string,
): boolean {
  return (
    record.status === 'confirmed' &&
    (record.validFrom === undefined || record.validFrom <= currentDate) &&
    (record.expiresAt === undefined || record.expiresAt > currentInstant)
  );
}

function householdContextForPlanning(
  profile: HouseholdProfile,
  currentDate: string,
  currentInstant: string,
): string {
  const active = (record: {
    readonly status: 'confirmed' | 'candidate';
    readonly validFrom?: string | undefined;
    readonly expiresAt?: string | undefined;
  }): boolean => contextRecordIsActive(record, currentDate, currentInstant);
  const policies = Object.fromEntries(
    Object.entries(profile.policies).filter(
      (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
        entry[1] !== undefined && active(entry[1]),
    ),
  );
  const context: Record<string, unknown> = {
    currency: profile.currency,
    timezone: profile.timezone,
    policies,
  };
  const collections = [
    ['members', profile.members.filter(active)],
    ['dependants', profile.dependants.filter(active)],
    ['incomeCadences', profile.incomeCadences.filter(active)],
    ['obligations', profile.obligations.filter(active)],
    ['savingsGoals', profile.savingsGoals.filter(active)],
    ['accountRoles', profile.accountRoles.filter(active)],
    ['exceptionalExpenses', profile.exceptionalExpenses.filter(active)],
    ['merchantRules', profile.merchantRules.filter(active)],
    ['transactionRules', profile.transactionRules.filter(active)],
  ] as const satisfies ReadonlyArray<readonly [string, readonly unknown[]]>;
  for (const [key] of collections) {
    context[key] = [];
  }
  const serialize = (): string =>
    JSON.stringify(context, (key, value) =>
      key === 'provenance' ||
      key === 'talkActorIds' ||
      key === 'status' ||
      key === 'validFrom' ||
      key === 'expiresAt'
        ? undefined
        : value,
    );
  const omittedCounts: Record<string, number> = Object.fromEntries(
    collections.map(([key]) => [key, 0]),
  );
  const maximumOmissionMetadata = {
    contextTruncated: true,
    omittedCounts: Object.fromEntries(
      collections.map(([key, values]) => [key, values.length]),
    ),
  };
  // Reserve the worst-case metadata size before packing. Round-robin packing
  // ensures one unusually large collection cannot hide every rule or
  // obligation, while exact omitted counts make the bounded view honest.
  const contentLimit =
    MAX_HOUSEHOLD_CONTEXT_CHARACTERS -
    JSON.stringify(maximumOmissionMetadata).length;
  const positions = collections.map(() => 0);
  let remaining = collections.reduce(
    (total, [, values]) => total + values.length,
    0,
  );
  while (remaining > 0) {
    for (const [collectionIndex, [key, values]] of collections.entries()) {
      const position = positions[collectionIndex]!;
      if (position >= values.length) {
        continue;
      }
      positions[collectionIndex] = position + 1;
      remaining -= 1;
      const projected = context[key] as unknown[];
      projected.push(values[position]);
      if (serialize().length > contentLimit) {
        projected.pop();
        omittedCounts[key] = (omittedCounts[key] ?? 0) + 1;
      }
    }
  }
  const visibleOmittedCounts = Object.fromEntries(
    Object.entries(omittedCounts).filter(([, count]) => count > 0),
  );
  if (Object.keys(visibleOmittedCounts).length > 0) {
    context.contextTruncated = true;
    context.omittedCounts = visibleOmittedCounts;
  }
  const serialized = serialize();
  if (serialized.length > MAX_HOUSEHOLD_CONTEXT_CHARACTERS) {
    throw new TerminalQuestionError('household-context-too-large');
  }
  return serialized;
}

function profileMemberForActor(
  profile: HouseholdProfile | undefined,
  actorId: string,
  currentDate: string,
  currentInstant: string,
): HouseholdProfile['members'][number] | undefined {
  return profile?.members.find(
    (member) =>
      contextRecordIsActive(member, currentDate, currentInstant) &&
      member.talkActorIds.includes(actorId),
  );
}

function currentMemberForAgent(
  profile: HouseholdProfile | undefined,
  actorId: string,
  currentDate: string,
  currentInstant: string,
): FinanceAgentCurrentMember | undefined {
  const member = profileMemberForActor(
    profile,
    actorId,
    currentDate,
    currentInstant,
  );
  return member === undefined
    ? undefined
    : {
        id: member.id,
        displayName: member.displayName,
        access: member.access,
      };
}

function modelSafeSpeaker(
  actor: 'household' | 'assistant',
  actorId: string,
  displayName: string | undefined,
  profile: HouseholdProfile | undefined,
  currentDate: string,
  currentInstant: string,
): {
  readonly actorId: string;
  readonly actorDisplayName: string;
} {
  if (actor === 'assistant') {
    return {
      actorId: 'finance-assistant',
      actorDisplayName: 'Household Finance Bot',
    };
  }
  const member = profileMemberForActor(
    profile,
    actorId,
    currentDate,
    currentInstant,
  );
  return member === undefined
    ? {
        actorId: 'household-member',
        actorDisplayName: displayName?.trim() || 'Household member',
      }
    : {
        actorId: member.id,
        actorDisplayName: member.displayName,
      };
}

function modelSafeReplySpeaker(
  speaker: TalkConversationSpeaker | undefined,
  profile: HouseholdProfile | undefined,
  currentDate: string,
  currentInstant: string,
):
  | {
      readonly actor: 'household' | 'assistant';
      readonly actorId: string;
      readonly actorDisplayName: string;
    }
  | undefined {
  if (speaker === undefined || speaker.kind === 'other-bot') {
    return undefined;
  }
  const actor =
    speaker.kind === 'finance-assistant' ? 'assistant' : 'household';
  return {
    actor,
    ...modelSafeSpeaker(
      actor,
      speaker.actorId,
      speaker.displayName,
      profile,
      currentDate,
      currentInstant,
    ),
  };
}

function conversationTurnForAgent(
  turn: TalkConversationTurn,
  profile: HouseholdProfile | undefined,
  currentDate: string,
  currentInstant: string,
): FinanceAgentConversationTurn {
  const safeSpeaker = modelSafeSpeaker(
    turn.actor,
    turn.actorId,
    turn.actorDisplayName,
    profile,
    currentDate,
    currentInstant,
  );
  const replySpeaker = modelSafeReplySpeaker(
    turn.replyTo?.speaker,
    profile,
    currentDate,
    currentInstant,
  );
  const safeReply =
    turn.replyTo !== undefined && turn.replyTo.speaker?.kind !== 'other-bot';
  const safeParentMessageId =
    turn.replyTo?.speaker?.kind === 'other-bot'
      ? undefined
      : turn.parentMessageId;
  return {
    actor: turn.actor,
    ...safeSpeaker,
    messageId: turn.messageId,
    ...(safeParentMessageId === undefined
      ? {}
      : { parentMessageId: safeParentMessageId }),
    ...(!safeReply || turn.replyTo === undefined
      ? {}
      : {
          replyTo: {
            messageId: turn.replyTo.messageId,
            ...(replySpeaker === undefined ? {} : replySpeaker),
            ...(turn.replyTo.message === undefined
              ? {}
              : { message: turn.replyTo.message }),
          },
        }),
    message: turn.message,
  };
}

function conversationWithStoredTranscripts(
  talkTurns: readonly TalkConversationTurn[],
  storedQuestions: ReturnType<
    QuestionStore['recentCompletedConversationInputs']
  >,
  allowedUserIds: ReadonlySet<string>,
  currentEvent: { readonly actorId: string; readonly messageId: string },
): TalkConversationTurn[] {
  const byMessageId = new Map(
    talkTurns.map((turn) => [turn.messageId, turn] as const),
  );
  for (const stored of storedQuestions) {
    if (
      !allowedUserIds.has(stored.actorId) &&
      !(
        stored.actorId === currentEvent.actorId &&
        stored.messageId === currentEvent.messageId
      )
    ) {
      continue;
    }
    const existing = byMessageId.get(stored.messageId);
    byMessageId.set(
      stored.messageId,
      existing?.actor === 'household'
        ? { ...existing, message: stored.question }
        : {
            messageId: stored.messageId,
            actor: 'household',
            actorId: stored.actorId,
            message: stored.question,
          },
    );
  }
  return [...byMessageId.values()].sort((left, right) => {
    if (
      /^[1-9]\d*$/u.test(left.messageId) &&
      /^[1-9]\d*$/u.test(right.messageId)
    ) {
      const leftId = BigInt(left.messageId);
      const rightId = BigInt(right.messageId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    }
    return 0;
  });
}

export class FinanceQuestionWorkflow {
  readonly #store: QuestionStore;
  readonly #agent: FinanceQuestionAgent;
  readonly #talk: FinanceQuestionTalkSender;
  readonly #timeZone: string;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #profileSource: FinanceQuestionProfileSource | undefined;
  readonly #conversationHistory:
    FinanceQuestionConversationHistorySource | undefined;
  readonly #voiceTranscriber: FinanceQuestionVoiceTranscriber | undefined;
  readonly #now: () => Date;
  readonly #signal: AbortSignal | undefined;

  constructor(options: FinanceQuestionWorkflowOptions) {
    this.#store = options.store;
    this.#agent = options.agent;
    this.#talk = options.talk;
    this.#timeZone = options.timeZone;
    this.#allowedUserIds = new Set(
      options.allowedUserIds.map((actorId) =>
        z.string().min(1).max(200).parse(actorId),
      ),
    );
    if (this.#allowedUserIds.size === 0) {
      throw new Error('Finance question allowed user IDs cannot be empty');
    }
    this.#profileSource = options.profileSource;
    this.#conversationHistory = options.conversationHistorySource;
    this.#voiceTranscriber = options.voiceTranscriber;
    this.#now = options.now ?? (() => new Date());
    this.#signal = options.signal;
  }

  async processAvailable(maxJobs = 25): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      if (this.#signal?.aborted === true) {
        break;
      }
      const now = this.#now().toISOString();
      const voiceJob = this.#store.claimNextVoiceOutbox(now);
      if (voiceJob !== undefined) {
        if (!(await this.#processVoice(voiceJob))) {
          break;
        }
        processed += 1;
        continue;
      }
      const questionJob = this.#store.claimNextOutbox(now);
      if (questionJob === undefined) {
        break;
      }
      await this.#processQuestion(questionJob);
      processed += 1;
    }
    return processed;
  }

  async #processVoice(job: QuestionVoiceOutboxJob): Promise<boolean> {
    try {
      switch (job.kind) {
        case 'transcribe-finance-question-voice':
          await this.#transcribeVoice(job);
          return true;
        case 'send-finance-question-voice-failure-reply':
          await this.#sendVoiceTalk(job);
          return true;
      }
    } catch (error) {
      const now = this.#now();
      if (job.kind === 'transcribe-finance-question-voice') {
        const disposition =
          this.#signal?.aborted === true
            ? {
                action: 'interrupt',
                terminalCode: 'voice-transcription-interrupted',
              }
            : voiceFailureDisposition(error);
        if (disposition.action === 'interrupt') {
          this.#store.requeueVoiceOutboxWithoutAttempt(
            job.id,
            disposition.terminalCode,
            now.toISOString(),
          );
          return false;
        }
        if (
          disposition.action === 'terminal' ||
          job.attemptCount >= MAXIMUM_JOB_ATTEMPTS
        ) {
          this.#failVoiceTranscription(
            job,
            disposition.terminalCode,
            now.toISOString(),
          );
          return true;
        }
      } else if (job.attemptCount >= MAXIMUM_JOB_ATTEMPTS) {
        this.#store.failVoiceOutbox(job.id, 'voice-talk-reply-failed');
        return true;
      }
      const delaySeconds = Math.min(60, 2 ** job.attemptCount);
      this.#store.retryVoiceOutbox(
        job.id,
        job.kind === 'transcribe-finance-question-voice'
          ? 'voice-transcription-temporarily-unavailable'
          : 'voice-talk-reply-temporarily-unavailable',
        new Date(now.valueOf() + delaySeconds * 1_000).toISOString(),
      );
      return true;
    }
  }

  async #transcribeVoice(job: QuestionVoiceOutboxJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new Error('shutdown-requested');
    }
    const source = this.#store.getVoiceInbound(job.sourceId);
    if (source === undefined) {
      throw new TerminalVoiceError('voice-source-missing');
    }
    if (source.status !== 'received') {
      this.#store.completeVoiceOutbox(job.id, this.#now().toISOString());
      return;
    }
    if (this.#voiceTranscriber === undefined) {
      throw new TerminalVoiceError('voice-transcriber-unavailable');
    }
    const transcript = await this.#voiceTranscriber.transcribe(
      source.attachment,
      this.#signal,
    );
    this.#store.completeVoiceTranscription(
      job.id,
      source.id,
      transcript,
      this.#now().toISOString(),
    );
  }

  #failVoiceTranscription(
    job: QuestionVoiceOutboxJob,
    errorCode: string,
    now: string,
  ): void {
    const source = this.#store.getVoiceInbound(job.sourceId);
    if (source === undefined) {
      this.#store.failVoiceOutbox(job.id, 'voice-source-missing');
      return;
    }
    const referenceId = createQuestionTalkReplyReferenceId(
      source.idempotencyKey,
      'voice-transcription-failed',
    );
    this.#store.failVoiceTranscriptionAndEnqueueReply(
      job.id,
      source.id,
      errorCode,
      {
        roomToken: source.roomToken,
        message: TERMINAL_VOICE_FAILURE_MESSAGE,
        replyTo: source.messageId,
        referenceId,
        silent: false,
      },
      `question-voice-talk-reply:${source.idempotencyKey}:failed`,
      now,
    );
  }

  async #sendVoiceTalk(job: QuestionVoiceOutboxJob): Promise<void> {
    const payload = talkReplyPayloadSchema.parse(job.payload);
    await this.#talk.sendReplyWithIdentity(payload);
    this.#store.completeVoiceTalkReplyOutbox(
      job.id,
      job.sourceId,
      this.#now().toISOString(),
    );
  }

  async #processQuestion(job: QuestionOutboxJob): Promise<void> {
    try {
      switch (job.kind) {
        case 'send-finance-question-acknowledgement':
        case 'send-finance-question-talk-reply':
          await this.#sendTalk(job);
          return;
        case 'process-finance-question':
          await this.#answer(job);
          return;
      }
    } catch (error) {
      const terminal = terminalFailure(error);
      const now = this.#now();
      if (job.kind === 'process-finance-question' && terminal !== undefined) {
        const event = this.#store.getInbound(job.eventId);
        if (event === undefined) {
          this.#store.failOutbox(job.id, 'question-event-missing');
          return;
        }
        const referenceId = createQuestionTalkReplyReferenceId(
          event.idempotencyKey,
          'failed',
        );
        this.#store.failProcessingAndEnqueueReply(
          job.id,
          event.id,
          terminal.code,
          {
            roomToken: event.roomToken,
            message: TERMINAL_AGENT_FAILURE_MESSAGE,
            replyTo: event.messageId,
            referenceId,
            silent: false,
          },
          `question-talk-reply:${event.idempotencyKey}:failed`,
          now.toISOString(),
          terminal.diagnostic,
        );
        return;
      }
      if (job.attemptCount >= MAXIMUM_JOB_ATTEMPTS) {
        if (job.kind === 'process-finance-question') {
          const event = this.#store.getInbound(job.eventId);
          if (event !== undefined) {
            const referenceId = createQuestionTalkReplyReferenceId(
              event.idempotencyKey,
              'failed',
            );
            this.#store.failProcessingAndEnqueueReply(
              job.id,
              event.id,
              'actual-read-unavailable',
              {
                roomToken: event.roomToken,
                message: TERMINAL_AGENT_FAILURE_MESSAGE,
                replyTo: event.messageId,
                referenceId,
                silent: false,
              },
              `question-talk-reply:${event.idempotencyKey}:failed`,
              now.toISOString(),
            );
          } else {
            this.#store.failOutbox(job.id, 'question-event-missing');
          }
        } else {
          this.#store.deadLetterTalkReplyOutbox(
            job.id,
            job.eventId,
            'talk-reply-failed',
            now.toISOString(),
          );
        }
        return;
      }
      const delaySeconds = Math.min(60, 2 ** job.attemptCount);
      this.#store.retryOutbox(
        job.id,
        'transient-processing-error',
        new Date(now.valueOf() + delaySeconds * 1_000).toISOString(),
      );
    }
  }

  async #sendTalk(job: QuestionOutboxJob): Promise<void> {
    const payload = talkReplyPayloadSchema.parse(job.payload);
    const item = this.#store.getQuestionItem(job.eventId);
    if (
      job.kind === 'send-finance-question-acknowledgement' &&
      item !== undefined &&
      item.status !== 'received'
    ) {
      this.#store.completeOutbox(job.id, this.#now().toISOString());
      return;
    }
    await this.#talk.sendReplyWithIdentity(payload);
    this.#store.completeTalkReplyOutbox(
      job.id,
      job.eventId,
      payload.referenceId,
      this.#now().toISOString(),
    );
  }

  async #answer(job: QuestionOutboxJob): Promise<void> {
    if (this.#signal?.aborted === true) {
      throw new Error('shutdown-requested');
    }
    const event = this.#store.getInbound(job.eventId);
    const item = this.#store.getQuestionItem(job.eventId);
    if (event === undefined || item === undefined) {
      throw new TerminalQuestionError('question-event-missing');
    }
    if (item.status !== 'received') {
      this.#store.completeOutbox(job.id, this.#now().toISOString());
      return;
    }
    const now = this.#now();
    const currentInstant = now.toISOString();
    const currentDate = currentDateInTimeZone(now, this.#timeZone);
    const profile = (await this.#profileSource?.read())?.profile;
    const householdContext =
      profile === undefined
        ? undefined
        : householdContextForPlanning(profile, currentDate, currentInstant);
    const talkConversation =
      (await this.#conversationHistory?.recentConversation(
        event.roomToken,
        MAXIMUM_AGENT_HISTORY_TURNS + 1,
        event.messageId,
      )) ?? [];
    const recentConversation = conversationWithStoredTranscripts(
      talkConversation,
      this.#store.recentCompletedConversationInputs(
        event.roomToken,
        16,
        event.messageId,
      ),
      this.#allowedUserIds,
      event,
    );
    const currentTalkTurn = recentConversation.find(
      (turn) => turn.messageId === event.messageId,
    );
    const currentConversationTurn =
      currentTalkTurn === undefined
        ? undefined
        : conversationTurnForAgent(
            currentTalkTurn,
            profile,
            currentDate,
            currentInstant,
          );
    const priorConversation = recentConversation
      .filter((turn) => turn.messageId !== event.messageId)
      .slice(-MAXIMUM_AGENT_HISTORY_TURNS)
      .map((turn) =>
        conversationTurnForAgent(turn, profile, currentDate, currentInstant),
      );
    const currentMember = currentMemberForAgent(
      profile,
      event.actorId,
      currentDate,
      currentInstant,
    );
    const unboundConfirmation =
      /^(?:y|yes|n|no|approve|approved|reject|rejected|undo|confirm|confirmed|cancel)$/iu.test(
        event.question.normalize('NFC').trim(),
      );
    let run;
    try {
      run = await this.#agent.answer(
        {
          question: event.question,
          currentDate,
          timezone: this.#timeZone,
          recentConversation: priorConversation,
          ...(currentMember === undefined ? {} : { currentMember }),
          ...(currentConversationTurn?.replyTo === undefined
            ? {}
            : { currentReplyTo: currentConversationTurn.replyTo }),
          ...(householdContext === undefined ? {} : { householdContext }),
          actionContext: {
            idempotencyKey: event.idempotencyKey,
            eventId: event.id,
            backendUrl: event.backendUrl,
            roomToken: event.roomToken,
            actorId: event.actorId,
            messageId: event.messageId,
            message: event.question,
            receivedAt: event.receivedAt,
            reserveStateChange: (
              toolName: string,
              toolInput: unknown,
            ): boolean => {
              const now = this.#now().toISOString();
              if (unboundConfirmation) {
                this.#store.denyStateChangingToolCall(
                  event.id,
                  toolName,
                  'unbound-confirmation',
                  now,
                );
                return false;
              }
              return this.#store.reserveStateChangingToolCall(
                event.id,
                toolName,
                toolInput,
                now,
                5,
              );
            },
          },
        },
        this.#signal,
      );
    } catch (error) {
      if (!(error instanceof FinanceQuestionToolReplyHandledError)) {
        throw error;
      }
      this.#store.completeQuestionWithoutReply(
        job.id,
        event.id,
        {
          schemaVersion: 'finance-agent-plan.v1',
          kind: 'finance-agent',
        },
        {
          schemaVersion: 'finance-agent-result.v1',
          toolCalls: error.toolNames,
          replyOwnedByTool: true,
        },
        {
          replyOwnedByTool: true,
          modelContinuationCompleted: false,
        },
        'The requested change was handled separately.',
        this.#now().toISOString(),
      );
      return;
    }
    const plan = {
      schemaVersion: 'finance-agent-plan.v1',
      kind: 'finance-agent',
    } as const;
    const result = {
      schemaVersion: 'finance-agent-result.v1',
      toolCalls: run.metadata.toolCalls,
    } as const;
    if (run.replyHandled === true) {
      this.#store.completeQuestionWithoutReply(
        job.id,
        event.id,
        plan,
        result,
        run.metadata,
        'The requested change was handled separately.',
        this.#now().toISOString(),
      );
      return;
    }
    const referenceId = createQuestionTalkReplyReferenceId(
      event.idempotencyKey,
      'completed',
    );
    const reply: QuestionTalkReplyPayload = {
      roomToken: event.roomToken,
      message: run.answer,
      replyTo: event.messageId,
      referenceId,
      silent: false,
    };
    this.#store.completeQuestionAndEnqueueReply(
      event.id,
      plan,
      result,
      run.metadata,
      run.answer,
      reply,
      `question-talk-reply:${event.idempotencyKey}:completed`,
      this.#now().toISOString(),
    );
    this.#store.completeOutbox(job.id, this.#now().toISOString());
  }
}

export class FinanceQuestionWorker {
  readonly #workflow: FinanceQuestionWorkflow;
  #running: Promise<number> | undefined;

  constructor(workflow: FinanceQuestionWorkflow) {
    this.#workflow = workflow;
  }

  kick(): Promise<number> {
    this.#running ??= this.#workflow.processAvailable().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }
}
