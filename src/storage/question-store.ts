import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import {
  MAX_TALK_RECEIPT_ATTACHMENT_BYTES,
  type TalkVoiceAttachmentReference,
} from '../talk/webhook.js';

export type QuestionStatus = 'received' | 'completed' | 'failed';

export interface QuestionInboundEventInput {
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  actorId: string;
  messageId: string;
  question: string;
  receivedAt: string;
}

export interface QuestionInboundEvent extends QuestionInboundEventInput {
  id: string;
}

export type QuestionVoiceStatus = 'received' | 'transcribed' | 'failed';

export interface QuestionVoiceInboundEventInput {
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  actorId: string;
  messageId: string;
  attachment: TalkVoiceAttachmentReference;
  receivedAt: string;
}

export interface QuestionVoiceInboundEvent extends QuestionVoiceInboundEventInput {
  id: string;
  status: QuestionVoiceStatus;
  errorCode?: string;
  completedAt?: string;
}

export interface QuestionItem {
  eventId: string;
  status: QuestionStatus;
  plan?: unknown;
  result?: unknown;
  modelMetadata?: unknown;
  answer?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionTalkReplyPayload {
  roomToken: string;
  message: string;
  replyTo: string;
  referenceId: string;
  silent: boolean;
}

export type QuestionOutboxKind =
  | 'send-finance-question-acknowledgement'
  | 'process-finance-question'
  | 'send-finance-question-talk-reply';

export interface QuestionOutboxJob {
  id: number;
  idempotencyKey: string;
  kind: QuestionOutboxKind;
  eventId: string;
  payload: unknown;
  attemptCount: number;
}

export type QuestionVoiceOutboxKind =
  | 'transcribe-finance-question-voice'
  | 'send-finance-question-voice-failure-reply';

export interface QuestionVoiceOutboxJob {
  id: number;
  idempotencyKey: string;
  kind: QuestionVoiceOutboxKind;
  sourceId: string;
  payload: unknown;
  attemptCount: number;
}

export interface QuestionAuditEvent {
  id: number;
  eventId: string;
  action: string;
  detail: unknown;
  occurredAt: string;
}

export interface CompletedQuestionConversationInput {
  readonly actorId: string;
  readonly messageId: string;
  readonly question: string;
  readonly receivedAt: string;
}

interface QuestionInboundRow {
  id: string;
  idempotency_key: string;
  backend_url: string;
  room_token: string;
  actor_id: string;
  message_id: string;
  question: string;
  received_at: string;
}

interface QuestionItemRow {
  event_id: string;
  status: QuestionStatus;
  plan_json: string | null;
  result_json: string | null;
  model_metadata_json: string | null;
  answer: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface QuestionOutboxRow {
  id: number;
  idempotency_key: string;
  kind: QuestionOutboxKind;
  event_id: string;
  payload_json: string;
  attempt_count: number;
}

interface QuestionVoiceInboundRow {
  id: string;
  idempotency_key: string;
  backend_url: string;
  room_token: string;
  actor_id: string;
  message_id: string;
  file_id: string;
  etag: string;
  size_bytes: number;
  media_type: TalkVoiceAttachmentReference['mediaType'];
  status: QuestionVoiceStatus;
  error_code: string | null;
  received_at: string;
  completed_at: string | null;
}

interface QuestionVoiceOutboxRow {
  id: number;
  idempotency_key: string;
  kind: QuestionVoiceOutboxKind;
  source_id: string;
  payload_json: string;
  attempt_count: number;
}

interface QuestionAuditRow {
  id: number;
  event_id: string;
  action: string;
  detail_json: string;
  occurred_at: string;
}

const questionSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS question_inbound_events (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    backend_url TEXT NOT NULL,
    room_token TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    question TEXT NOT NULL CHECK (
      length(question) BETWEEN 1 AND 2000
    ),
    received_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS question_items (
    event_id TEXT PRIMARY KEY REFERENCES question_inbound_events(id),
    status TEXT NOT NULL CHECK (
      status IN ('received', 'completed', 'failed')
    ),
    plan_json TEXT,
    result_json TEXT,
    model_metadata_json TEXT,
    answer TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS question_items_completed
    ON question_items(status, updated_at, event_id);

  CREATE TABLE IF NOT EXISTS question_state_change_reservations (
    event_id TEXT NOT NULL REFERENCES question_inbound_events(id),
    call_sha256 TEXT NOT NULL CHECK (
      length(call_sha256) = 64
      AND call_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    tool_name TEXT NOT NULL CHECK (
      length(tool_name) BETWEEN 1 AND 100
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (event_id, call_sha256)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS question_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'send-finance-question-acknowledgement',
        'process-finance-question',
        'send-finance-question-talk-reply'
      )
    ),
    event_id TEXT NOT NULL REFERENCES question_inbound_events(id),
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'processing', 'completed', 'failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    locked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS question_outbox_ready
    ON question_outbox(state, available_at, id);

  CREATE TABLE IF NOT EXISTS question_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES question_inbound_events(id),
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS question_voice_sources (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    backend_url TEXT NOT NULL,
    room_token TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    etag TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (
      size_bytes BETWEEN 1 AND ${String(MAX_TALK_RECEIPT_ATTACHMENT_BYTES)}
    ),
    media_type TEXT NOT NULL CHECK (
      media_type IN ('audio/mpeg', 'audio/mp4', 'audio/wav')
    ),
    status TEXT NOT NULL CHECK (
      status IN ('received', 'transcribed', 'failed')
    ),
    error_code TEXT,
    received_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (status = 'received' AND error_code IS NULL AND completed_at IS NULL)
      OR
      (status = 'transcribed' AND error_code IS NULL AND completed_at IS NOT NULL)
      OR
      (status = 'failed' AND error_code IS NOT NULL AND completed_at IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS question_voice_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'transcribe-finance-question-voice',
        'send-finance-question-voice-failure-reply'
      )
    ),
    source_id TEXT NOT NULL REFERENCES question_voice_sources(id),
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'processing', 'completed', 'failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    locked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS question_voice_outbox_ready
    ON question_voice_outbox(state, available_at, id);
`;

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function serializeJson(value: unknown, name: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${name} must be JSON serializable`);
  }
  return serialized;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Tool input contains a non-finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError('Tool input is not JSON-compatible');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Tool input contains a cycle');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => canonicalJson(item, ancestors))
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Tool input contains a non-plain object');
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function stateChangeCallDigest(toolName: string, input: unknown): string {
  const canonicalInput = canonicalJson(input);
  if (Buffer.byteLength(canonicalInput, 'utf8') > 64 * 1024) {
    throw new RangeError('Tool input is too large to reserve');
  }
  return createHash('sha256')
    .update('household-finance.question-state-change.v1\0', 'utf8')
    .update(toolName, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalInput, 'utf8')
    .digest('hex');
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function normalizedQuestion(value: string): string {
  return normalizedBoundedConversationText(value, 2_000, 'question');
}

function normalizedAnswer(value: string): string {
  return normalizedBoundedConversationText(value, 2_000, 'answer');
}

function normalizedBoundedConversationText(
  value: string,
  maximumCharacters: number,
  name: string,
): string {
  const normalized = value.normalize('NFC').trim();
  const containsUnsafeControlCharacter = Array.from(normalized).some(
    (character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        ((codePoint < 32 &&
          codePoint !== 9 &&
          codePoint !== 10 &&
          codePoint !== 13) ||
          codePoint === 127)
      );
    },
  );
  if (
    normalized.length === 0 ||
    normalized.length > maximumCharacters ||
    containsUnsafeControlCharacter
  ) {
    throw new RangeError(
      `${name} must contain between 1 and ${String(maximumCharacters)} safe characters`,
    );
  }
  return normalized;
}

function toInboundEvent(row: QuestionInboundRow): QuestionInboundEvent {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    backendUrl: row.backend_url,
    roomToken: row.room_token,
    actorId: row.actor_id,
    messageId: row.message_id,
    question: row.question,
    receivedAt: row.received_at,
  };
}

function normalizedVoiceAttachment(
  attachment: TalkVoiceAttachmentReference,
): TalkVoiceAttachmentReference {
  if (
    !/^[1-9]\d{0,19}$/u.test(attachment.fileId) ||
    attachment.etag.length === 0 ||
    attachment.etag.length > 500 ||
    attachment.etag !== attachment.etag.normalize('NFC').trim() ||
    !Number.isSafeInteger(attachment.sizeBytes) ||
    attachment.sizeBytes <= 0 ||
    attachment.sizeBytes > MAX_TALK_RECEIPT_ATTACHMENT_BYTES ||
    !(['audio/mpeg', 'audio/mp4', 'audio/wav'] as const).includes(
      attachment.mediaType,
    )
  ) {
    throw new RangeError('Voice attachment metadata is invalid');
  }
  return { ...attachment };
}

function toVoiceInboundEvent(
  row: QuestionVoiceInboundRow,
): QuestionVoiceInboundEvent {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    backendUrl: row.backend_url,
    roomToken: row.room_token,
    actorId: row.actor_id,
    messageId: row.message_id,
    attachment: {
      fileId: row.file_id,
      etag: row.etag,
      sizeBytes: row.size_bytes,
      mediaType: row.media_type,
    },
    status: row.status,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    receivedAt: row.received_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function toQuestionItem(row: QuestionItemRow): QuestionItem {
  return {
    eventId: row.event_id,
    status: row.status,
    ...(row.plan_json === null ? {} : { plan: parseJson(row.plan_json) }),
    ...(row.result_json === null ? {} : { result: parseJson(row.result_json) }),
    ...(row.model_metadata_json === null
      ? {}
      : { modelMetadata: parseJson(row.model_metadata_json) }),
    ...(row.answer === null ? {} : { answer: row.answer }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createQuestionTalkReplyReferenceId(
  eventIdempotencyKey: string,
  purpose: string,
): string {
  return createHash('sha256')
    .update('finance-question-talk-reply-v1\0')
    .update(eventIdempotencyKey)
    .update('\0')
    .update(purpose)
    .digest('hex');
}

function safeModelAuditDetail(metadata: unknown): Record<string, unknown> {
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    return { metadataRecorded: true };
  }
  const source = metadata as Record<string, unknown>;
  const detail: Record<string, unknown> = { metadataRecorded: true };
  for (const key of [
    'provider',
    'requestedModel',
    'resolvedModel',
    'zeroDataRetention',
    'durationMs',
    'correctiveRetries',
    'correctiveRetryStage',
    'usageIncludesAllAttempts',
  ]) {
    const value = source[key];
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      detail[key] = value;
    }
  }
  const usage = source.usage;
  if (
    usage !== null &&
    typeof usage === 'object' &&
    !Array.isArray(usage) &&
    typeof (usage as Record<string, unknown>).costInUsdTicks === 'number'
  ) {
    detail.costInUsdTicks = (usage as Record<string, unknown>).costInUsdTicks;
  }
  return detail;
}

/**
 * Durable state for the conversational question lane. It stores no ledger
 * identifiers or write payloads; the small reservation table only bounds how
 * many distinct state-changing tool calls one authenticated message may make.
 */
export class QuestionStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new Database(databasePath);
    this.#database.exec(questionSchema);
  }

  close(): void {
    this.#database.close();
  }

  recordInbound(
    input: QuestionInboundEventInput,
    options: { readonly enqueueAcknowledgement?: boolean } = {},
  ): {
    event: QuestionInboundEvent;
    inserted: boolean;
  } {
    const question = normalizedQuestion(input.question);
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          'SELECT * FROM question_inbound_events WHERE idempotency_key = ?',
        )
        .get(input.idempotencyKey) as QuestionInboundRow | undefined;
      if (existing !== undefined) {
        return { event: toInboundEvent(existing), inserted: false };
      }

      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO question_inbound_events (
             id,
             idempotency_key,
             backend_url,
             room_token,
             actor_id,
             message_id,
             question,
             received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.idempotencyKey,
          input.backendUrl,
          input.roomToken,
          input.actorId,
          input.messageId,
          question,
          input.receivedAt,
        );
      this.#database
        .prepare(
          `INSERT INTO question_items (
             event_id, status, created_at, updated_at
           ) VALUES (?, 'received', ?, ?)`,
        )
        .run(id, input.receivedAt, input.receivedAt);
      let acknowledgementReferenceId: string | undefined;
      if (options.enqueueAcknowledgement !== false) {
        acknowledgementReferenceId = createQuestionTalkReplyReferenceId(
          input.idempotencyKey,
          'acknowledged',
        );
        this.#enqueue(
          'send-finance-question-acknowledgement',
          id,
          {
            roomToken: input.roomToken,
            message: 'Got it — I’m checking Actual now.',
            replyTo: input.messageId,
            referenceId: acknowledgementReferenceId,
            silent: false,
          } satisfies QuestionTalkReplyPayload,
          `question-talk-reply:${input.idempotencyKey}:acknowledged`,
          input.receivedAt,
        );
      }
      this.#enqueue(
        'process-finance-question',
        id,
        {},
        `process-finance-question:${input.idempotencyKey}`,
        input.receivedAt,
      );
      this.#appendAudit(id, 'question.received', {}, input.receivedAt);
      if (acknowledgementReferenceId !== undefined) {
        this.#appendAudit(
          id,
          'question.acknowledgement-queued',
          { referenceId: acknowledgementReferenceId },
          input.receivedAt,
        );
      }

      return {
        event: {
          id,
          ...input,
          question,
        },
        inserted: true,
      };
    })();
  }

  recordVoiceInbound(input: QuestionVoiceInboundEventInput): {
    event: QuestionVoiceInboundEvent;
    inserted: boolean;
  } {
    const attachment = normalizedVoiceAttachment(input.attachment);
    return this.#database.transaction(() => {
      const existingVoice = this.#database
        .prepare(
          'SELECT * FROM question_voice_sources WHERE idempotency_key = ?',
        )
        .get(input.idempotencyKey) as QuestionVoiceInboundRow | undefined;
      if (existingVoice !== undefined) {
        return {
          event: toVoiceInboundEvent(existingVoice),
          inserted: false,
        };
      }

      const existingQuestion = this.#database
        .prepare(
          'SELECT * FROM question_inbound_events WHERE idempotency_key = ?',
        )
        .get(input.idempotencyKey) as QuestionInboundRow | undefined;
      if (existingQuestion !== undefined) {
        return {
          event: {
            id: existingQuestion.id,
            ...input,
            attachment,
            status: 'transcribed' as const,
            completedAt: existingQuestion.received_at,
          },
          inserted: false,
        };
      }

      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO question_voice_sources (
             id,
             idempotency_key,
             backend_url,
             room_token,
             actor_id,
             message_id,
             file_id,
             etag,
             size_bytes,
             media_type,
             status,
             received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
        )
        .run(
          id,
          input.idempotencyKey,
          input.backendUrl,
          input.roomToken,
          input.actorId,
          input.messageId,
          attachment.fileId,
          attachment.etag,
          attachment.sizeBytes,
          attachment.mediaType,
          input.receivedAt,
        );
      this.#enqueueVoice(
        'transcribe-finance-question-voice',
        id,
        {},
        `transcribe-finance-question-voice:${input.idempotencyKey}`,
        input.receivedAt,
      );
      return {
        event: {
          id,
          ...input,
          attachment,
          status: 'received' as const,
        },
        inserted: true,
      };
    })();
  }

  getInbound(eventId: string): QuestionInboundEvent | undefined {
    const row = this.#database
      .prepare('SELECT * FROM question_inbound_events WHERE id = ?')
      .get(eventId) as QuestionInboundRow | undefined;
    return row === undefined ? undefined : toInboundEvent(row);
  }

  getVoiceInbound(sourceId: string): QuestionVoiceInboundEvent | undefined {
    const row = this.#database
      .prepare('SELECT * FROM question_voice_sources WHERE id = ?')
      .get(sourceId) as QuestionVoiceInboundRow | undefined;
    return row === undefined ? undefined : toVoiceInboundEvent(row);
  }

  getQuestionItem(eventId: string): QuestionItem | undefined {
    const row = this.#database
      .prepare('SELECT * FROM question_items WHERE event_id = ?')
      .get(eventId) as QuestionItemRow | undefined;
    return row === undefined ? undefined : toQuestionItem(row);
  }

  reserveStateChangingToolCall(
    eventId: string,
    toolNameInput: string,
    input: unknown,
    now: string,
    maximumDistinctCalls = 5,
  ): boolean {
    positiveSafeInteger(maximumDistinctCalls, 'maximumDistinctCalls');
    if (maximumDistinctCalls > 20) {
      throw new RangeError('maximumDistinctCalls cannot exceed 20');
    }
    const toolName = toolNameInput.normalize('NFC').trim();
    if (
      toolName.length === 0 ||
      toolName.length > 100 ||
      !/^[a-z][a-z0-9_]*$/u.test(toolName)
    ) {
      throw new TypeError('toolName is invalid');
    }
    const digest = stateChangeCallDigest(toolName, input);
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT 1
             FROM question_state_change_reservations
            WHERE event_id = ? AND call_sha256 = ?`,
        )
        .get(eventId, digest);
      if (existing !== undefined) {
        return true;
      }
      const count = this.#database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM question_state_change_reservations
            WHERE event_id = ?`,
        )
        .get(eventId) as { count: number };
      if (count.count >= maximumDistinctCalls) {
        return false;
      }
      this.#database
        .prepare(
          `INSERT INTO question_state_change_reservations (
             event_id, call_sha256, tool_name, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(eventId, digest, toolName, now);
      this.#appendAudit(
        eventId,
        'question.state-change-reserved',
        { toolName },
        now,
      );
      return true;
    })();
  }

  recentCompletedConversationInputs(
    roomToken: string,
    limit: number,
    throughMessageId: string,
  ): CompletedQuestionConversationInput[] {
    positiveSafeInteger(limit, 'limit');
    if (limit > 16) {
      throw new RangeError('limit cannot exceed 16');
    }
    if (!/^[1-9]\d*$/u.test(throughMessageId)) {
      throw new RangeError(
        'throughMessageId must be a positive decimal message ID',
      );
    }
    return this.#database
      .prepare(
        `SELECT actor_id AS actorId,
                message_id AS messageId,
                question,
                received_at AS receivedAt
           FROM (
             SELECT inbound.actor_id,
                    inbound.message_id,
                    inbound.question,
                    inbound.received_at,
                    inbound.rowid AS inbound_sequence
               FROM question_items AS item
               JOIN question_inbound_events AS inbound
                 ON inbound.id = item.event_id
              WHERE inbound.room_token = ?
                AND item.status = 'completed'
                AND inbound.message_id NOT GLOB '*[^0-9]*'
                AND substr(inbound.message_id, 1, 1) <> '0'
                AND (
                  length(inbound.message_id) < length(?)
                  OR (
                    length(inbound.message_id) = length(?)
                    AND inbound.message_id <= ?
                  )
                )
              ORDER BY inbound.received_at DESC, inbound.rowid DESC
              LIMIT ?
           )
          ORDER BY receivedAt, inbound_sequence`,
      )
      .all(
        roomToken,
        throughMessageId,
        throughMessageId,
        throughMessageId,
        limit,
      ) as CompletedQuestionConversationInput[];
  }

  completeQuestionAndEnqueueReply(
    eventId: string,
    plan: unknown,
    result: unknown,
    metadata: unknown,
    answer: string,
    replyPayload: QuestionTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      this.#completeQuestion(eventId, plan, result, metadata, answer, now);
      this.#enqueue(
        'send-finance-question-talk-reply',
        eventId,
        replyPayload,
        replyIdempotencyKey,
        now,
      );
    })();
  }

  completeQuestionWithoutReply(
    jobId: number,
    eventId: string,
    plan: unknown,
    result: unknown,
    metadata: unknown,
    answer: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      this.#completeQuestion(eventId, plan, result, metadata, answer, now);
      const completed = this.#database
        .prepare(
          `UPDATE question_outbox
              SET state = 'completed', completed_at = ?, locked_at = NULL
            WHERE id = ?
              AND event_id = ?
              AND kind = 'process-finance-question'
              AND state = 'processing'`,
        )
        .run(now, jobId, eventId);
      if (completed.changes !== 1) {
        throw new Error('Question processing outbox job is not claimed');
      }
    })();
  }

  markFailed(
    eventId: string,
    errorCode: string,
    now: string,
    diagnostic?: unknown,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE question_items
            SET status = 'failed', error_code = ?, updated_at = ?
          WHERE event_id = ? AND status <> 'completed'`,
      )
      .run(errorCode, now, eventId);
    if (result.changes !== 1) {
      throw new Error('Unknown or completed finance question event');
    }
    this.#appendAudit(
      eventId,
      'question.failed',
      {
        errorCode,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
      now,
    );
  }

  failProcessingAndEnqueueReply(
    jobId: number,
    eventId: string,
    errorCode: string,
    replyPayload: QuestionTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
    diagnostic?: unknown,
  ): void {
    this.#database.transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE question_outbox
              SET state = 'failed', locked_at = NULL, last_error = ?
            WHERE id = ?
              AND event_id = ?
              AND kind = 'process-finance-question'
              AND state = 'processing'`,
        )
        .run(errorCode, jobId, eventId);
      if (result.changes !== 1) {
        throw new Error('Question processing outbox job is not claimed');
      }
      this.markFailed(eventId, errorCode, now, diagnostic);
      this.#enqueue(
        'send-finance-question-talk-reply',
        eventId,
        replyPayload,
        replyIdempotencyKey,
        now,
      );
    })();
  }

  completeVoiceTranscription(
    jobId: number,
    sourceId: string,
    transcriptInput: string,
    now: string,
  ): QuestionInboundEvent {
    return this.#database.transaction(() => {
      const source = this.#database
        .prepare('SELECT * FROM question_voice_sources WHERE id = ?')
        .get(sourceId) as QuestionVoiceInboundRow | undefined;
      if (source === undefined || source.status !== 'received') {
        throw new Error('Voice source is not awaiting transcription');
      }
      const existingQuestion = this.#database
        .prepare(
          'SELECT * FROM question_inbound_events WHERE idempotency_key = ?',
        )
        .get(source.idempotency_key) as QuestionInboundRow | undefined;
      if (
        existingQuestion !== undefined &&
        (existingQuestion.backend_url !== source.backend_url ||
          existingQuestion.room_token !== source.room_token ||
          existingQuestion.actor_id !== source.actor_id ||
          existingQuestion.message_id !== source.message_id)
      ) {
        throw new Error(
          'Voice source conflicts with an existing finance question',
        );
      }
      const completed = this.#database
        .prepare(
          `UPDATE question_voice_outbox
              SET state = 'completed', completed_at = ?, locked_at = NULL
            WHERE id = ?
              AND source_id = ?
              AND kind = 'transcribe-finance-question-voice'
              AND state = 'processing'`,
        )
        .run(now, jobId, sourceId);
      if (completed.changes !== 1) {
        throw new Error('Voice transcription outbox job is not claimed');
      }
      if (existingQuestion !== undefined) {
        const updated = this.#database
          .prepare(
            `UPDATE question_voice_sources
                SET status = 'transcribed', completed_at = ?
              WHERE id = ? AND status = 'received'`,
          )
          .run(now, source.id);
        if (updated.changes !== 1) {
          throw new Error('Voice source transcription state changed');
        }
        this.#appendAudit(
          existingQuestion.id,
          'question.voice-transcribed',
          {},
          now,
        );
        return toInboundEvent(existingQuestion);
      }
      const question = normalizedQuestion(transcriptInput);
      this.#database
        .prepare(
          `INSERT INTO question_inbound_events (
             id,
             idempotency_key,
             backend_url,
             room_token,
             actor_id,
             message_id,
             question,
             received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.id,
          source.idempotency_key,
          source.backend_url,
          source.room_token,
          source.actor_id,
          source.message_id,
          question,
          source.received_at,
        );
      this.#database
        .prepare(
          `INSERT INTO question_items (
             event_id, status, created_at, updated_at
           ) VALUES (?, 'received', ?, ?)`,
        )
        .run(source.id, source.received_at, now);
      this.#enqueue(
        'process-finance-question',
        source.id,
        {},
        `process-finance-question:${source.idempotency_key}`,
        now,
      );
      const updated = this.#database
        .prepare(
          `UPDATE question_voice_sources
              SET status = 'transcribed', completed_at = ?
            WHERE id = ? AND status = 'received'`,
        )
        .run(now, source.id);
      if (updated.changes !== 1) {
        throw new Error('Voice source transcription state changed');
      }
      this.#appendAudit(source.id, 'question.received', {}, source.received_at);
      this.#appendAudit(source.id, 'question.voice-transcribed', {}, now);
      return {
        id: source.id,
        idempotencyKey: source.idempotency_key,
        backendUrl: source.backend_url,
        roomToken: source.room_token,
        actorId: source.actor_id,
        messageId: source.message_id,
        question,
        receivedAt: source.received_at,
      };
    })();
  }

  failVoiceTranscriptionAndEnqueueReply(
    jobId: number,
    sourceId: string,
    errorCode: string,
    replyPayload: QuestionTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      const failed = this.#database
        .prepare(
          `UPDATE question_voice_outbox
              SET state = 'failed', locked_at = NULL, last_error = ?
            WHERE id = ?
              AND source_id = ?
              AND kind = 'transcribe-finance-question-voice'
              AND state = 'processing'`,
        )
        .run(errorCode, jobId, sourceId);
      if (failed.changes !== 1) {
        throw new Error('Voice transcription outbox job is not claimed');
      }
      const source = this.#database
        .prepare(
          `UPDATE question_voice_sources
              SET status = 'failed', error_code = ?, completed_at = ?
            WHERE id = ? AND status = 'received'`,
        )
        .run(errorCode, now, sourceId);
      if (source.changes !== 1) {
        throw new Error('Voice source is not awaiting transcription');
      }
      this.#enqueueVoice(
        'send-finance-question-voice-failure-reply',
        sourceId,
        replyPayload,
        replyIdempotencyKey,
        now,
      );
    })();
  }

  claimNextVoiceOutbox(now: string): QuestionVoiceOutboxJob | undefined {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT id, idempotency_key, kind, source_id, payload_json,
                  attempt_count
             FROM question_voice_outbox
            WHERE state = 'pending' AND available_at <= ?
            ORDER BY
              CASE kind
                WHEN 'send-finance-question-voice-failure-reply' THEN 0
                ELSE 1
              END,
              id
            LIMIT 1`,
        )
        .get(now) as QuestionVoiceOutboxRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const claimed = this.#database
        .prepare(
          `UPDATE question_voice_outbox
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  locked_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(now, row.id);
      if (claimed.changes !== 1) {
        return undefined;
      }
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        kind: row.kind,
        sourceId: row.source_id,
        payload: parseJson(row.payload_json),
        attemptCount: row.attempt_count + 1,
      };
    })();
  }

  completeVoiceOutbox(jobId: number, now: string): void {
    const result = this.#database
      .prepare(
        `UPDATE question_voice_outbox
            SET state = 'completed', completed_at = ?, locked_at = NULL
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
    if (result.changes !== 1) {
      throw new Error('Voice outbox job is not claimed');
    }
  }

  completeVoiceTalkReplyOutbox(jobId: number, sourceId: string, now: string) {
    const result = this.#database
      .prepare(
        `UPDATE question_voice_outbox
            SET state = 'completed', completed_at = ?, locked_at = NULL
          WHERE id = ?
            AND source_id = ?
            AND kind = 'send-finance-question-voice-failure-reply'
            AND state = 'processing'`,
      )
      .run(now, jobId, sourceId);
    if (result.changes !== 1) {
      throw new Error('Voice Talk reply outbox job is not claimed');
    }
  }

  retryVoiceOutbox(
    jobId: number,
    errorCode: string,
    availableAt: string,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE question_voice_outbox
            SET state = 'pending',
                available_at = ?,
                locked_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(availableAt, errorCode, jobId);
    if (result.changes !== 1) {
      throw new Error('Voice outbox job is not claimed');
    }
  }

  requeueVoiceOutboxWithoutAttempt(
    jobId: number,
    errorCode: string,
    availableAt: string,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE question_voice_outbox
            SET state = 'pending',
                attempt_count = attempt_count - 1,
                available_at = ?,
                locked_at = NULL,
                last_error = ?
          WHERE id = ?
            AND kind = 'transcribe-finance-question-voice'
            AND state = 'processing'
            AND attempt_count > 0`,
      )
      .run(availableAt, errorCode, jobId);
    if (result.changes !== 1) {
      throw new Error('Voice outbox job is not claimed');
    }
  }

  failVoiceOutbox(jobId: number, errorCode: string): void {
    const result = this.#database
      .prepare(
        `UPDATE question_voice_outbox
            SET state = 'failed', locked_at = NULL, last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(errorCode, jobId);
    if (result.changes !== 1) {
      throw new Error('Voice outbox job is not claimed');
    }
  }

  claimNextOutbox(now: string): QuestionOutboxJob | undefined {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT id, idempotency_key, kind, event_id, payload_json,
                  attempt_count
             FROM question_outbox
            WHERE state = 'pending' AND available_at <= ?
            ORDER BY
              CASE kind
                WHEN 'send-finance-question-acknowledgement' THEN 0
                WHEN 'process-finance-question' THEN 1
                ELSE 2
              END,
              id
            LIMIT 1`,
        )
        .get(now) as QuestionOutboxRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const claimed = this.#database
        .prepare(
          `UPDATE question_outbox
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  locked_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(now, row.id);
      if (claimed.changes !== 1) {
        return undefined;
      }
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        kind: row.kind,
        eventId: row.event_id,
        payload: parseJson(row.payload_json),
        attemptCount: row.attempt_count + 1,
      };
    })();
  }

  completeOutbox(jobId: number, now: string): void {
    this.#completeClaimedOutbox(jobId, now);
  }

  completeTalkReplyOutbox(
    jobId: number,
    eventId: string,
    referenceId: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      const completed = this.#database
        .prepare(
          `UPDATE question_outbox
              SET state = 'completed', completed_at = ?, locked_at = NULL
            WHERE id = ?
              AND event_id = ?
              AND kind IN (
                'send-finance-question-acknowledgement',
                'send-finance-question-talk-reply'
              )
              AND state = 'processing'`,
        )
        .run(now, jobId, eventId);
      if (completed.changes !== 1) {
        throw new Error('Question Talk reply outbox job is not claimed');
      }
      this.#appendAudit(
        eventId,
        'question.talk-reply-delivered',
        { referenceId },
        now,
      );
    })();
  }

  retryOutbox(jobId: number, errorCode: string, availableAt: string): void {
    const result = this.#database
      .prepare(
        `UPDATE question_outbox
            SET state = 'pending',
                available_at = ?,
                locked_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(availableAt, errorCode, jobId);
    if (result.changes !== 1) {
      throw new Error('Question outbox job is not claimed');
    }
  }

  failOutbox(jobId: number, errorCode: string): void {
    const result = this.#database
      .prepare(
        `UPDATE question_outbox
            SET state = 'failed', locked_at = NULL, last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(errorCode, jobId);
    if (result.changes !== 1) {
      throw new Error('Question outbox job is not claimed');
    }
  }

  deadLetterTalkReplyOutbox(
    jobId: number,
    eventId: string,
    errorCode: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE question_outbox
              SET state = 'failed', locked_at = NULL, last_error = ?
            WHERE id = ?
              AND event_id = ?
              AND kind IN (
                'send-finance-question-acknowledgement',
                'send-finance-question-talk-reply'
              )
              AND state = 'processing'`,
        )
        .run(errorCode, jobId, eventId);
      if (result.changes !== 1) {
        throw new Error('Question Talk reply outbox job is not claimed');
      }
      this.#appendAudit(
        eventId,
        'question.talk-reply-dead-lettered',
        { errorCode },
        now,
      );
    })();
  }

  recoverInterruptedOutbox(now: string): number {
    return this.#database.transaction(() => {
      const questionJobs = this.#database
        .prepare(
          `UPDATE question_outbox
              SET state = 'pending', available_at = ?, locked_at = NULL
            WHERE state = 'processing'`,
        )
        .run(now).changes;
      const voiceJobs = this.#database
        .prepare(
          `UPDATE question_voice_outbox
              SET state = 'pending', available_at = ?, locked_at = NULL
            WHERE state = 'processing'`,
        )
        .run(now).changes;
      return questionJobs + voiceJobs;
    })();
  }

  listAudit(eventId: string): QuestionAuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT id, event_id, action, detail_json, occurred_at
           FROM question_audit_events
          WHERE event_id = ?
          ORDER BY id`,
      )
      .all(eventId) as QuestionAuditRow[];
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      action: row.action,
      detail: parseJson(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }

  #completeQuestion(
    eventId: string,
    plan: unknown,
    result: unknown,
    metadata: unknown,
    answer: string,
    now: string,
  ): void {
    const normalized = normalizedAnswer(answer);
    const updated = this.#database
      .prepare(
        `UPDATE question_items
            SET status = 'completed',
                plan_json = ?,
                result_json = ?,
                model_metadata_json = ?,
                answer = ?,
                error_code = NULL,
                updated_at = ?
          WHERE event_id = ? AND status = 'received'`,
      )
      .run(
        serializeJson(plan, 'plan'),
        serializeJson(result, 'result'),
        serializeJson(metadata, 'metadata'),
        normalized,
        now,
        eventId,
      );
    if (updated.changes !== 1) {
      throw new Error('Unknown or non-pending finance question event');
    }
    this.#appendAudit(
      eventId,
      'question.completed',
      safeModelAuditDetail(metadata),
      now,
    );
  }

  #completeClaimedOutbox(jobId: number, now: string): void {
    const result = this.#database
      .prepare(
        `UPDATE question_outbox
            SET state = 'completed', completed_at = ?, locked_at = NULL
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
    if (result.changes !== 1) {
      throw new Error('Question outbox job is not claimed');
    }
  }

  #enqueue(
    kind: QuestionOutboxKind,
    eventId: string,
    payload: unknown,
    idempotencyKey: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO question_outbox (
           idempotency_key,
           kind,
           event_id,
           payload_json,
           state,
           available_at,
           created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        idempotencyKey,
        kind,
        eventId,
        serializeJson(payload, 'outbox payload'),
        now,
        now,
      );
  }

  #enqueueVoice(
    kind: QuestionVoiceOutboxKind,
    sourceId: string,
    payload: unknown,
    idempotencyKey: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO question_voice_outbox (
           idempotency_key,
           kind,
           source_id,
           payload_json,
           state,
           available_at,
           created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        idempotencyKey,
        kind,
        sourceId,
        serializeJson(payload, 'voice outbox payload'),
        now,
        now,
      );
  }

  #appendAudit(
    eventId: string,
    action: string,
    detail: unknown,
    occurredAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO question_audit_events (
           event_id,
           action,
           detail_json,
           occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(eventId, action, serializeJson(detail, 'audit detail'), occurredAt);
  }
}
