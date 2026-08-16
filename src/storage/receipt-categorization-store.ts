import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  isReceiptCategorizationDeterministicallyReevaluatable,
  receiptCategoryProposalSchema,
  resolveReceiptCategorizationClarification,
  type ReceiptCategorizationResult,
  type ReceiptCategoryProposal,
  type ReceiptCategorySplit,
} from '../categorization/receipt.js';
import {
  householdFinanceActiveReceiptRecordSchema,
  householdFinanceReceiptSha256,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../receipt-record/index.js';
import type { XaiStructuredRunMetadata } from '../model/xai-structured-client.js';

const MAX_RECORD_BYTES = 256 * 1_024;
const MAX_PROPOSAL_BYTES = 128 * 1_024;
const MAX_METADATA_BYTES = 16 * 1_024;
const MAX_DECISION_BYTES = 32 * 1_024;
const MAX_OUTBOX_BYTES = 16 * 1_024;
const RECEIPT_CATEGORIZATION_FAILURE_NOTICE =
  "I saved the receipt, but I couldn't safely finish categorizing it. I didn't change any transaction. You can send a clearer photo or tell me how you'd like it categorized.";
const timestampSchema = z.iso.datetime({ offset: true });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.normalize('NFC').trim())
  .refine(
    (value) =>
      ![...value].some((character) => {
        const point = character.codePointAt(0);
        return point === undefined || point <= 0x1f || point === 0x7f;
      }),
  );
const errorCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const categoryAliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
const botActorIdSchema = z.string().regex(/^bots\/bot-[a-f0-9]{40}$/);

const metadataSchema = z.strictObject({
  provider: z.literal('xai'),
  requestedModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  resolvedModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  preflightAttempts: z.number().int().safe().positive(),
  requestAttempts: z.number().int().safe().positive(),
  durationMs: z.number().int().safe().nonnegative(),
  zeroDataRetention: z.literal(true),
  usage: z.strictObject({
    inputTokens: z.number().int().safe().nonnegative().optional(),
    outputTokens: z.number().int().safe().nonnegative().optional(),
    reasoningTokens: z.number().int().safe().nonnegative().optional(),
    totalTokens: z.number().int().safe().nonnegative().optional(),
    costInUsdTicks: z.number().int().safe().nonnegative(),
  }),
});

const categorizationResultSchema = z
  .discriminatedUnion('disposition', [
    z.strictObject({
      disposition: z.literal('ready'),
      splits: z
        .array(
          z.strictObject({
            categoryAlias: z
              .string()
              .min(1)
              .max(64)
              .regex(/^[a-z][a-z0-9-]*$/),
            amountMinorUnits: z.number().int().safe().nonnegative(),
          }),
        )
        .min(1)
        .max(200),
      totalMinorUnits: z.number().int().safe().nonnegative(),
    }),
    z.strictObject({
      disposition: z.literal('review'),
      issueCodes: z
        .array(
          z.enum([
            'category-not-allowed',
            'classification-incomplete',
            'classification-uncertain',
            'currency-not-household',
            'duplicate-item-classification',
            'receipt-not-ready',
            'split-allocation-failed',
            'split-total-mismatch',
          ]),
        )
        .min(1)
        .max(7),
    }),
  ])
  .superRefine((result, context) => {
    if (result.disposition === 'ready') {
      const aliases = result.splits.map((split) => split.categoryAlias);
      if (
        new Set(aliases).size !== aliases.length ||
        aliases.some(
          (alias, index) => index > 0 && alias <= aliases[index - 1]!,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt category splits must use unique sorted aliases',
          path: ['splits'],
        });
      }
      const total = result.splits.reduce(
        (sum, split) => sum + BigInt(split.amountMinorUnits),
        0n,
      );
      if (total !== BigInt(result.totalMinorUnits)) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt category splits must equal the receipt total',
          path: ['splits'],
        });
      }
    } else if (
      new Set(result.issueCodes).size !== result.issueCodes.length ||
      result.issueCodes.some(
        (code, index) => index > 0 && code <= result.issueCodes[index - 1]!,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Receipt review issue codes must be unique and sorted',
        path: ['issueCodes'],
      });
    }
  });

const sourceSchema = z
  .strictObject({
    schemaVersion: z.literal('receipt-categorization-source.v1'),
    eventId: z.uuid(),
    sourceSha256: hashSchema,
    roomToken: identifierSchema,
    messageId: identifierSchema,
    receivedAt: timestampSchema,
    record: householdFinanceActiveReceiptRecordSchema,
  })
  .superRefine((source, context) => {
    const primary = source.record.sources[0]!;
    if (
      source.eventId !== source.record.receiptId ||
      source.sourceSha256 !== householdFinanceReceiptSha256(source.record) ||
      source.roomToken !== primary.talk.roomToken ||
      source.messageId !== primary.talk.messageId ||
      source.receivedAt !== primary.receivedAt
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Receipt categorization index fields do not match the canonical record',
      });
    }
  });

const talkPayloadSchema = z.strictObject({
  roomToken: identifierSchema,
  message: z.string().min(1).max(2_000),
  replyTo: identifierSchema,
  referenceId: hashSchema,
  silent: z.boolean(),
});

export interface ReceiptCategorizationSource {
  schemaVersion: 'receipt-categorization-source.v1';
  eventId: string;
  sourceSha256: string;
  roomToken: string;
  messageId: string;
  receivedAt: string;
  record: HouseholdFinanceActiveReceiptRecordV1;
}

export type ReceiptCategorizationStatus =
  'observed' | 'planned' | 'ready' | 'attention' | 'published' | 'failed';

export interface ReceiptCategorizationItem {
  eventId: string;
  status: ReceiptCategorizationStatus;
  proposal?: ReceiptCategoryProposal;
  modelMetadata?: XaiStructuredRunMetadata;
  decision?: ReceiptCategorizationResult;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
}

export interface ReadyReceiptCategorizationRecord {
  schemaVersion: 'ready-receipt-categorization.v1';
  receiptId: string;
  idempotencyKey: string;
  sourceSha256: string;
  roomToken: string;
  messageId: string;
  receivedAt: string;
  record: HouseholdFinanceActiveReceiptRecordV1;
  splits: readonly ReceiptCategorySplit[];
  totalMinorUnits: number;
  status: 'ready' | 'published';
}

export type ReceiptCategorizationJobKind =
  | 'classify-receipt-items'
  | 'publish-ready-receipt'
  | 'send-receipt-categorization-clarification';

export interface ReceiptCategorizationJob {
  id: number;
  idempotencyKey: string;
  kind: ReceiptCategorizationJobKind;
  eventId: string;
  payload: unknown;
  attemptCount: number;
  leaseExpiresAt: string;
}

export interface ReceiptCategorizationTalkPayload {
  roomToken: string;
  message: string;
  replyTo: string;
  referenceId: string;
  silent: boolean;
}

export interface ReceiptCategorizationAuditEvent {
  id: number;
  eventId: string;
  action: string;
  detail: unknown;
  occurredAt: string;
}

export interface ReceiptCategorizationClarificationResolution {
  referenceId: string;
  eventId: string;
  roomToken: string;
  categoryAlias: string;
  actorId: string;
  inboundMessageId: string;
  parentBotId: string;
  parentMessageId: string;
  result: Extract<ReceiptCategorizationResult, { disposition: 'ready' }>;
  resolvedAt: string;
}

export interface OpenReceiptCategorizationClarification {
  referenceId: string;
  eventId: string;
  roomToken: string;
  botActorId: string;
  parentMessageId: string;
  deliveredAt: string;
  summary: string;
}

export type IgnoreReceiptCategorizationResult =
  | { readonly status: 'ignored' | 'already-ignored' | 'not-found' }
  | { readonly status: 'still-processing' };

interface SourceRow {
  event_id: string;
  source_sha256: string;
  room_token: string;
  message_id: string;
  received_at: string;
  record_json: string;
}

interface ItemRow {
  event_id: string;
  status: ReceiptCategorizationStatus;
  proposal_json: string | null;
  model_metadata_json: string | null;
  decision_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface JobRow {
  id: number;
  idempotency_key: string;
  kind: ReceiptCategorizationJobKind;
  event_id: string;
  payload_json: string;
  state: 'pending' | 'processing' | 'completed' | 'failed';
  attempt_count: number;
  lease_expires_at: string | null;
}

interface AuditRow {
  id: number;
  event_id: string;
  action: string;
  detail_json: string;
  occurred_at: string;
}

interface ClarificationRequestRow {
  reference_id: string;
  event_id: string;
  room_token: string;
  outbox_idempotency_key: string;
  created_at: string;
}

interface ClarificationResolutionRow {
  reference_id: string;
  event_id: string;
  room_token: string;
  category_alias: string;
  actor_id: string;
  inbound_message_id: string;
  parent_bot_id: string;
  parent_message_id: string;
  result_json: string;
  resolved_at: string;
}

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS receipt_categorization_sources (
    event_id TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL UNIQUE,
    room_token TEXT NOT NULL,
    message_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (
      length(CAST(record_json AS BLOB)) <= ${String(MAX_RECORD_BYTES)}
    )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_source_no_delete
  BEFORE DELETE ON receipt_categorization_sources
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization sources are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_categorization_items (
    event_id TEXT PRIMARY KEY
      REFERENCES receipt_categorization_sources(event_id),
    status TEXT NOT NULL CHECK (
      status IN ('observed', 'planned', 'ready', 'attention', 'published', 'failed')
    ),
    proposal_json TEXT CHECK (
      proposal_json IS NULL
      OR length(CAST(proposal_json AS BLOB)) <= ${String(MAX_PROPOSAL_BYTES)}
    ),
    model_metadata_json TEXT CHECK (
      model_metadata_json IS NULL
      OR length(CAST(model_metadata_json AS BLOB)) <= ${String(MAX_METADATA_BYTES)}
    ),
    decision_json TEXT CHECK (
      decision_json IS NULL
      OR length(CAST(decision_json AS BLOB)) <= ${String(MAX_DECISION_BYTES)}
    ),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    CHECK (
      (proposal_json IS NULL AND model_metadata_json IS NULL)
      OR (proposal_json IS NOT NULL AND model_metadata_json IS NOT NULL)
    ),
    CHECK (
      (status = 'observed'
        AND proposal_json IS NULL
        AND decision_json IS NULL
        AND error_code IS NULL
        AND published_at IS NULL)
      OR (status = 'planned'
        AND proposal_json IS NOT NULL
        AND decision_json IS NULL
        AND error_code IS NULL
        AND published_at IS NULL)
      OR (status IN ('ready', 'attention')
        AND proposal_json IS NOT NULL
        AND decision_json IS NOT NULL
        AND error_code IS NULL
        AND published_at IS NULL)
      OR (status = 'published'
        AND proposal_json IS NOT NULL
        AND decision_json IS NOT NULL
        AND error_code IS NULL
        AND published_at IS NOT NULL)
      OR (status = 'failed'
        AND error_code IS NOT NULL
        AND published_at IS NULL)
    )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_status_transition
  BEFORE UPDATE OF status ON receipt_categorization_items
  WHEN NOT (
    (OLD.status = 'observed' AND NEW.status IN ('planned', 'failed'))
    OR (OLD.status = 'planned' AND NEW.status IN ('ready', 'attention', 'failed'))
    OR (OLD.status = 'attention' AND NEW.status = 'ready')
    OR (OLD.status = 'ready' AND NEW.status IN ('published', 'failed'))
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid receipt categorization status transition');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_proposal_once
  BEFORE UPDATE OF proposal_json, model_metadata_json
    ON receipt_categorization_items
  WHEN NOT (
    OLD.status = 'observed'
    AND NEW.status = 'planned'
    AND OLD.proposal_json IS NULL
    AND OLD.model_metadata_json IS NULL
    AND NEW.proposal_json IS NOT NULL
    AND NEW.model_metadata_json IS NOT NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'receipt category proposal is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_decision_once
  BEFORE UPDATE OF decision_json ON receipt_categorization_items
  WHEN NOT (
    (
      OLD.status = 'planned'
      AND NEW.status IN ('ready', 'attention')
      AND OLD.decision_json IS NULL
      AND NEW.decision_json IS NOT NULL
    )
    OR (
      OLD.status = 'attention'
      AND NEW.status = 'ready'
      AND OLD.decision_json IS NOT NULL
      AND NEW.decision_json IS NOT NULL
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'receipt category decision is immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_categorization_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'classify-receipt-items',
        'publish-ready-receipt',
        'send-receipt-categorization-clarification'
      )
    ),
    event_id TEXT NOT NULL
      REFERENCES receipt_categorization_sources(event_id),
    payload_json TEXT NOT NULL CHECK (
      length(CAST(payload_json AS BLOB)) <= ${String(MAX_OUTBOX_BYTES)}
    ),
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'processing', 'completed', 'failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    locked_at TEXT,
    lease_expires_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (state = 'processing'
        AND locked_at IS NOT NULL
        AND lease_expires_at IS NOT NULL)
      OR (state <> 'processing'
        AND locked_at IS NULL
        AND lease_expires_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS receipt_categorization_outbox_ready
    ON receipt_categorization_outbox(state, available_at, id);

  CREATE TABLE IF NOT EXISTS receipt_categorization_clarifications (
    reference_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL
      REFERENCES receipt_categorization_sources(event_id),
    room_token TEXT NOT NULL,
    outbox_idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_clarification_no_update
  BEFORE UPDATE ON receipt_categorization_clarifications
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization clarifications are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_categorization_clarification_deliveries (
    reference_id TEXT PRIMARY KEY
      REFERENCES receipt_categorization_clarifications(reference_id),
    room_token TEXT NOT NULL,
    bot_actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    UNIQUE(room_token, message_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_delivery_no_update
  BEFORE UPDATE ON receipt_categorization_clarification_deliveries
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization deliveries are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_categorization_clarification_resolutions (
    reference_id TEXT PRIMARY KEY
      REFERENCES receipt_categorization_clarifications(reference_id),
    event_id TEXT NOT NULL
      REFERENCES receipt_categorization_sources(event_id),
    room_token TEXT NOT NULL,
    category_alias TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL,
    parent_bot_id TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (
      length(CAST(result_json AS BLOB)) <= ${String(MAX_DECISION_BYTES)}
    ),
    resolved_at TEXT NOT NULL,
    UNIQUE(event_id),
    UNIQUE(room_token, inbound_message_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_resolution_no_update
  BEFORE UPDATE ON receipt_categorization_clarification_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization resolutions are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_categorization_provider_calls (
    event_id TEXT PRIMARY KEY
      REFERENCES receipt_categorization_sources(event_id),
    started_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS receipt_categorization_ignores (
    event_id TEXT PRIMARY KEY
      REFERENCES receipt_categorization_sources(event_id),
    room_token TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL UNIQUE,
    ignored_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_ignore_no_update
  BEFORE UPDATE ON receipt_categorization_ignores
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization ignore is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_ignore_no_delete
  BEFORE DELETE ON receipt_categorization_ignores
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization ignore is immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_categorization_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL
      REFERENCES receipt_categorization_sources(event_id),
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_audit_no_update
  BEFORE UPDATE ON receipt_categorization_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization audit is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_categorization_audit_no_delete
  BEFORE DELETE ON receipt_categorization_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'receipt categorization audit is append-only');
  END;
`;

export class ReceiptCategorizationIdentityConflictError extends Error {
  constructor() {
    super('Receipt event identity is bound to a different source document');
    this.name = 'ReceiptCategorizationIdentityConflictError';
  }
}

export class ReceiptCategorizationClarificationNotApplicableError extends Error {
  readonly code = 'currency-not-household';

  constructor() {
    super(
      'Receipt categorization clarification cannot override household currency',
    );
    this.name = 'ReceiptCategorizationClarificationNotApplicableError';
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function serialize(value: unknown, name: string, maximumBytes: number): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new TypeError(`${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(result, 'utf8') > maximumBytes) {
    throw new RangeError(`${name} exceeds its persisted byte limit`);
  }
  return result;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function toSource(row: SourceRow): ReceiptCategorizationSource {
  const source = sourceSchema.parse({
    schemaVersion: 'receipt-categorization-source.v1',
    eventId: row.event_id,
    sourceSha256: row.source_sha256,
    roomToken: row.room_token,
    messageId: row.message_id,
    receivedAt: row.received_at,
    record: parseJson(row.record_json),
  });
  return {
    schemaVersion: source.schemaVersion,
    eventId: source.eventId,
    sourceSha256: source.sourceSha256,
    roomToken: source.roomToken,
    messageId: source.messageId,
    receivedAt: source.receivedAt,
    record: source.record,
  };
}

function toItem(row: ItemRow): ReceiptCategorizationItem {
  return {
    eventId: row.event_id,
    status: row.status,
    ...(row.proposal_json === null
      ? {}
      : {
          proposal: receiptCategoryProposalSchema.parse(
            parseJson(row.proposal_json),
          ),
        }),
    ...(row.model_metadata_json === null
      ? {}
      : {
          modelMetadata: metadataSchema.parse(
            parseJson(row.model_metadata_json),
          ) as XaiStructuredRunMetadata,
        }),
    ...(row.decision_json === null
      ? {}
      : {
          decision: categorizationResultSchema.parse(
            parseJson(row.decision_json),
          ) as ReceiptCategorizationResult,
        }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.published_at === null ? {} : { publishedAt: row.published_at }),
  };
}

function toClarificationResolution(
  row: ClarificationResolutionRow,
): ReceiptCategorizationClarificationResolution {
  const result = categorizationResultSchema.parse(
    parseJson(row.result_json),
  ) as ReceiptCategorizationResult;
  if (result.disposition !== 'ready') {
    throw new Error('Receipt clarification resolution is not ready');
  }
  return {
    referenceId: row.reference_id,
    eventId: row.event_id,
    roomToken: row.room_token,
    categoryAlias: row.category_alias,
    actorId: row.actor_id,
    inboundMessageId: row.inbound_message_id,
    parentBotId: row.parent_bot_id,
    parentMessageId: row.parent_message_id,
    result,
    resolvedAt: row.resolved_at,
  };
}

export function createReceiptCategorizationReferenceId(
  eventId: string,
): string {
  return createHash('sha256')
    .update('receipt-categorization-talk-reply-v1\0')
    .update(eventId)
    .digest('hex');
}

export function createReceiptCategorizationFailureReferenceId(
  eventId: string,
): string {
  return createHash('sha256')
    .update('receipt-categorization-failure-talk-reply-v1\0')
    .update(eventId)
    .digest('hex');
}

export class ReceiptCategorizationStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new Database(databasePath);
    this.#database.exec(schema);
  }

  close(): void {
    this.#database.close();
  }

  recordCanonical(
    untrustedSource: ReceiptCategorizationSource,
    nowInput?: string,
  ): { inserted: boolean; eventId: string } {
    const source = sourceSchema.parse(untrustedSource);
    const now = timestampSchema.parse(nowInput ?? source.receivedAt);
    const recordJson = serialize(
      source.record,
      'receipt categorization source',
      MAX_RECORD_BYTES,
    );
    return this.#database.transaction(() => {
      const byEvent = this.#sourceRow(source.eventId);
      if (byEvent?.source_sha256 === source.sourceSha256) {
        return { inserted: false, eventId: byEvent.event_id };
      }
      const bySource = this.#database
        .prepare(
          `SELECT *
             FROM receipt_categorization_sources
            WHERE source_sha256 = ?`,
        )
        .get(source.sourceSha256) as SourceRow | undefined;
      if (bySource !== undefined) {
        return { inserted: false, eventId: bySource.event_id };
      }
      if (byEvent !== undefined) {
        if (this.#isIgnored(source.eventId)) {
          return { inserted: false, eventId: source.eventId };
        }
        const processing = this.#database
          .prepare(
            `SELECT 1
               FROM receipt_categorization_outbox
              WHERE event_id = ? AND state = 'processing'
              LIMIT 1`,
          )
          .get(source.eventId);
        if (processing !== undefined) {
          return { inserted: false, eventId: source.eventId };
        }
        const item = this.#requireItem(source.eventId);
        this.#database
          .prepare(
            `UPDATE receipt_categorization_outbox
                SET state = 'failed',
                    locked_at = NULL,
                    lease_expires_at = NULL,
                    last_error = 'superseded-by-receipt-revision'
              WHERE event_id = ? AND state = 'pending'`,
          )
          .run(source.eventId);
        this.#database
          .prepare(
            `DELETE FROM receipt_categorization_provider_calls
              WHERE event_id = ?`,
          )
          .run(source.eventId);
        this.#database
          .prepare(
            `DELETE FROM receipt_categorization_clarification_resolutions
              WHERE event_id = ?`,
          )
          .run(source.eventId);
        this.#database
          .prepare(
            `DELETE FROM receipt_categorization_clarification_deliveries
              WHERE reference_id IN (
                SELECT reference_id
                  FROM receipt_categorization_clarifications
                 WHERE event_id = ?
              )`,
          )
          .run(source.eventId);
        this.#database
          .prepare(
            `DELETE FROM receipt_categorization_clarifications
              WHERE event_id = ?`,
          )
          .run(source.eventId);
        this.#database
          .prepare(
            `DELETE FROM receipt_categorization_items
              WHERE event_id = ?`,
          )
          .run(source.eventId);
        this.#database
          .prepare(
            `UPDATE receipt_categorization_sources
                SET source_sha256 = ?,
                    room_token = ?,
                    message_id = ?,
                    received_at = ?,
                    record_json = ?
              WHERE event_id = ?`,
          )
          .run(
            source.sourceSha256,
            source.roomToken,
            source.messageId,
            source.receivedAt,
            recordJson,
            source.eventId,
          );
        this.#database
          .prepare(
            `INSERT INTO receipt_categorization_items (
               event_id, status, created_at, updated_at
             ) VALUES (?, 'observed', ?, ?)`,
          )
          .run(source.eventId, item.created_at, now);
        this.#enqueue(
          'classify-receipt-items',
          source.eventId,
          {},
          `receipt-categorization:classify:${source.sourceSha256}`,
          now,
        );
        this.#appendAudit(
          source.eventId,
          'receipt-categorization.revised',
          {
            previousSourceSha256: byEvent.source_sha256,
            sourceSha256: source.sourceSha256,
          },
          now,
        );
        return { inserted: true, eventId: source.eventId };
      }
      this.#database
        .prepare(
          `INSERT INTO receipt_categorization_sources (
             event_id, source_sha256, room_token, message_id,
             received_at, record_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.eventId,
          source.sourceSha256,
          source.roomToken,
          source.messageId,
          source.receivedAt,
          recordJson,
        );
      this.#database
        .prepare(
          `INSERT INTO receipt_categorization_items (
             event_id, status, created_at, updated_at
           ) VALUES (?, 'observed', ?, ?)`,
        )
        .run(source.eventId, now, now);
      this.#enqueue(
        'classify-receipt-items',
        source.eventId,
        {},
        `receipt-categorization:classify:${source.sourceSha256}`,
        now,
      );
      this.#appendAudit(
        source.eventId,
        'receipt-categorization.observed',
        { sourceSha256: source.sourceSha256 },
        now,
      );
      return { inserted: true, eventId: source.eventId };
    })();
  }

  getSource(eventId: string): ReceiptCategorizationSource | undefined {
    const row = this.#sourceRow(eventId);
    return row === undefined ? undefined : toSource(row);
  }

  getBySourceSha256(
    sourceSha256Input: string,
  ): ReceiptCategorizationSource | undefined {
    const sourceSha256 = hashSchema.parse(sourceSha256Input);
    const row = this.#database
      .prepare(
        `SELECT *
           FROM receipt_categorization_sources
          WHERE source_sha256 = ?`,
      )
      .get(sourceSha256) as SourceRow | undefined;
    return row === undefined ? undefined : toSource(row);
  }

  getItem(eventId: string): ReceiptCategorizationItem | undefined {
    const row = this.#itemRow(eventId);
    return row === undefined ? undefined : toItem(row);
  }

  ignoreReceipt(input: {
    readonly eventId: string;
    readonly roomToken: string;
    readonly actorId: string;
    readonly inboundMessageId: string;
    readonly ignoredAt: string;
  }): IgnoreReceiptCategorizationResult {
    const eventId = identifierSchema.parse(input.eventId);
    const roomToken = identifierSchema.parse(input.roomToken);
    const actorId = identifierSchema.parse(input.actorId);
    const inboundMessageId = identifierSchema.parse(input.inboundMessageId);
    const ignoredAt = timestampSchema.parse(input.ignoredAt);
    return this.#database.transaction((): IgnoreReceiptCategorizationResult => {
      const source = this.#sourceRow(eventId);
      if (source === undefined) {
        return { status: 'not-found' };
      }
      if (source.room_token !== roomToken) {
        throw new Error('Receipt categorization room does not match');
      }
      const existing = this.#database
        .prepare(
          `SELECT event_id
             FROM receipt_categorization_ignores
            WHERE event_id = ? OR inbound_message_id = ?
            LIMIT 1`,
        )
        .get(eventId, inboundMessageId) as { event_id: string } | undefined;
      if (existing !== undefined) {
        if (existing.event_id !== eventId) {
          throw new Error('Receipt categorization ignore message was reused');
        }
        return { status: 'already-ignored' };
      }
      const active = this.#database
        .prepare(
          `SELECT 1
             FROM receipt_categorization_outbox
            WHERE event_id = ? AND state = 'processing'
            LIMIT 1`,
        )
        .get(eventId);
      if (active !== undefined) {
        return { status: 'still-processing' };
      }
      this.#database
        .prepare(
          `INSERT INTO receipt_categorization_ignores (
             event_id, room_token, actor_id, inbound_message_id, ignored_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(eventId, roomToken, actorId, inboundMessageId, ignoredAt);
      this.#database
        .prepare(
          `UPDATE receipt_categorization_outbox
              SET state = 'failed',
                  locked_at = NULL,
                  lease_expires_at = NULL,
                  last_error = 'receipt-ignored'
            WHERE event_id = ? AND state = 'pending'`,
        )
        .run(eventId);
      this.#appendAudit(
        eventId,
        'receipt-categorization.ignored',
        { actorId, inboundMessageId },
        ignoredAt,
      );
      return { status: 'ignored' };
    })();
  }

  getClarificationResolution(
    referenceIdInput: string,
  ): ReceiptCategorizationClarificationResolution | undefined {
    const referenceId = hashSchema.parse(referenceIdInput);
    const row = this.#database
      .prepare(
        `SELECT reference_id, event_id, room_token, category_alias,
                actor_id, inbound_message_id, parent_bot_id,
                parent_message_id, result_json, resolved_at
           FROM receipt_categorization_clarification_resolutions
          WHERE reference_id = ?`,
      )
      .get(referenceId) as ClarificationResolutionRow | undefined;
    return row === undefined ? undefined : toClarificationResolution(row);
  }

  latestOpenClarification(
    roomTokenInput: string,
    deliveredAtOrBeforeInput?: string,
  ): OpenReceiptCategorizationClarification | undefined {
    const roomToken = identifierSchema.parse(roomTokenInput);
    const deliveredAtOrBefore =
      deliveredAtOrBeforeInput === undefined
        ? null
        : timestampSchema.parse(deliveredAtOrBeforeInput);
    const row = this.#database
      .prepare(
        `SELECT clarification.reference_id,
                clarification.event_id,
                clarification.room_token,
                delivery.bot_actor_id,
                delivery.message_id,
                delivery.delivered_at,
                source.record_json
           FROM receipt_categorization_clarifications AS clarification
           JOIN receipt_categorization_clarification_deliveries AS delivery
             ON delivery.reference_id = clarification.reference_id
           JOIN receipt_categorization_sources AS source
             ON source.event_id = clarification.event_id
           JOIN receipt_categorization_items AS item
             ON item.event_id = clarification.event_id
           LEFT JOIN receipt_categorization_clarification_resolutions AS resolution
             ON resolution.reference_id = clarification.reference_id
          WHERE clarification.room_token = ?
            AND (? IS NULL OR delivery.delivered_at <= ?)
            AND resolution.reference_id IS NULL
            AND item.status = 'attention'
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_categorization_ignores AS ignored
               WHERE ignored.event_id = clarification.event_id
            )
          ORDER BY delivery.delivered_at DESC, clarification.reference_id
          LIMIT 1`,
      )
      .get(roomToken, deliveredAtOrBefore, deliveredAtOrBefore) as
      | {
          reference_id: string;
          event_id: string;
          room_token: string;
          bot_actor_id: string;
          message_id: string;
          delivered_at: string;
          record_json: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const receipt = householdFinanceActiveReceiptRecordSchema.parse(
      parseJson(row.record_json),
    );
    const merchant = receipt.merchant ?? 'an unreadable merchant';
    const items = receipt.items
      .slice(0, 5)
      .map((item) => item.description ?? 'an unreadable item')
      .join(', ');
    return {
      referenceId: row.reference_id,
      eventId: row.event_id,
      roomToken: row.room_token,
      botActorId: row.bot_actor_id,
      parentMessageId: row.message_id,
      deliveredAt: row.delivered_at,
      summary: `Receipt from ${merchant}${items.length === 0 ? '' : ` with ${items}`}`,
    };
  }

  resolveClarification(input: {
    referenceId: string;
    roomToken: string;
    categoryAlias: string;
    actorId: string;
    inboundMessageId: string;
    parentBotId: string;
    parentMessageId: string;
    resolvedAt: string;
  }): ReceiptCategorizationItem {
    const referenceId = hashSchema.parse(input.referenceId);
    const roomToken = identifierSchema.parse(input.roomToken);
    const categoryAlias = categoryAliasSchema.parse(input.categoryAlias);
    const actorId = identifierSchema.parse(input.actorId);
    const inboundMessageId = identifierSchema.parse(input.inboundMessageId);
    const parentBotId = botActorIdSchema.parse(input.parentBotId);
    const parentMessageId = identifierSchema.parse(input.parentMessageId);
    const resolvedAt = timestampSchema.parse(input.resolvedAt);

    return this.#database.transaction(() => {
      const request = this.#database
        .prepare(
          `SELECT reference_id, event_id, room_token,
                  outbox_idempotency_key, created_at
             FROM receipt_categorization_clarifications
            WHERE reference_id = ?`,
        )
        .get(referenceId) as ClarificationRequestRow | undefined;
      if (request === undefined) {
        throw new Error('Unknown receipt categorization clarification');
      }
      if (request.room_token !== roomToken) {
        throw new Error('Receipt clarification room does not match');
      }
      const delivered = this.#database
        .prepare(
          `SELECT 1
             FROM receipt_categorization_outbox
            WHERE idempotency_key = ?
              AND kind = 'send-receipt-categorization-clarification'
              AND event_id = ?
              AND state = 'completed'`,
        )
        .get(request.outbox_idempotency_key, request.event_id);
      if (delivered === undefined) {
        throw new Error('Receipt clarification was not delivered');
      }
      const delivery = this.#database
        .prepare(
          `SELECT room_token, bot_actor_id, message_id
             FROM receipt_categorization_clarification_deliveries
            WHERE reference_id = ?`,
        )
        .get(referenceId) as
        | {
            room_token: string;
            bot_actor_id: string;
            message_id: string;
          }
        | undefined;
      if (
        delivery === undefined ||
        delivery.room_token !== roomToken ||
        delivery.bot_actor_id !== parentBotId ||
        delivery.message_id !== parentMessageId
      ) {
        throw new Error(
          'Receipt clarification reply parent does not match delivery',
        );
      }

      const existing = this.getClarificationResolution(referenceId);
      if (existing !== undefined) {
        if (
          existing.eventId !== request.event_id ||
          existing.roomToken !== roomToken ||
          existing.categoryAlias !== categoryAlias ||
          existing.actorId !== actorId ||
          existing.inboundMessageId !== inboundMessageId ||
          existing.parentBotId !== parentBotId ||
          existing.parentMessageId !== parentMessageId
        ) {
          throw new Error(
            'Receipt clarification was already resolved differently',
          );
        }
        return toItem(this.#requireItem(request.event_id));
      }

      if (this.#isIgnored(request.event_id)) {
        throw new ReceiptCategorizationClarificationNotApplicableError();
      }
      const item = this.#requireItem(request.event_id);
      if (item.status !== 'attention' || item.decision_json === null) {
        throw new ReceiptCategorizationClarificationNotApplicableError();
      }
      const originalDecision = categorizationResultSchema.parse(
        parseJson(item.decision_json),
      ) as ReceiptCategorizationResult;
      if (originalDecision.disposition !== 'review') {
        throw new Error('Receipt attention state is not reclassifiable');
      }
      const source = toSource(this.#requireSource(request.event_id));
      if (
        originalDecision.issueCodes.some(
          (code) =>
            code !== 'classification-incomplete' &&
            code !== 'classification-uncertain',
        ) ||
        item.proposal_json === null
      ) {
        throw new ReceiptCategorizationClarificationNotApplicableError();
      }
      let result: Extract<
        ReceiptCategorizationResult,
        { disposition: 'ready' }
      >;
      try {
        result = resolveReceiptCategorizationClarification(
          source.record,
          receiptCategoryProposalSchema.parse(parseJson(item.proposal_json)),
          originalDecision,
          categoryAlias,
        );
      } catch {
        throw new ReceiptCategorizationClarificationNotApplicableError();
      }
      const resultJson = serialize(
        result,
        'receipt clarification resolution',
        MAX_DECISION_BYTES,
      );

      this.#database
        .prepare(
          `INSERT INTO receipt_categorization_clarification_resolutions (
             reference_id, event_id, room_token, category_alias, actor_id,
             inbound_message_id, parent_bot_id, parent_message_id,
             result_json, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          referenceId,
          request.event_id,
          roomToken,
          categoryAlias,
          actorId,
          inboundMessageId,
          parentBotId,
          parentMessageId,
          resultJson,
          resolvedAt,
        );
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_items
              SET status = 'ready', updated_at = ?
            WHERE event_id = ? AND status = 'attention'`,
        )
        .run(resolvedAt, request.event_id);
      if (updated.changes !== 1) {
        throw new Error(
          'Receipt clarification resolution could not be persisted',
        );
      }
      this.#enqueue(
        'publish-ready-receipt',
        request.event_id,
        {},
        `receipt-categorization:publish:${source.sourceSha256}`,
        resolvedAt,
      );
      this.#appendAudit(
        request.event_id,
        'receipt-categorization.clarification-resolved',
        {
          referenceId,
          categoryAlias,
          actorId,
          inboundMessageId,
          parentBotId,
          parentMessageId,
        },
        resolvedAt,
      );
      return toItem(this.#requireItem(request.event_id));
    })();
  }

  startProviderCall(jobId: number, eventId: string, nowInput: string): void {
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'classify-receipt-items');
      const item = this.#requireItem(eventId);
      if (item.status !== 'observed') {
        throw new Error('Receipt is not awaiting item classification');
      }
      this.#database
        .prepare(
          `INSERT INTO receipt_categorization_provider_calls (
             event_id, started_at
           ) VALUES (?, ?)`,
        )
        .run(eventId, now);
      this.#appendAudit(
        eventId,
        'receipt-categorization.provider-call-started',
        {},
        now,
      );
    })();
  }

  recordProposal(
    jobId: number,
    eventId: string,
    untrustedProposal: ReceiptCategoryProposal,
    untrustedMetadata: XaiStructuredRunMetadata,
    nowInput: string,
  ): void {
    const proposal = receiptCategoryProposalSchema.parse(untrustedProposal);
    const metadata = metadataSchema.parse(
      untrustedMetadata,
    ) as XaiStructuredRunMetadata;
    const proposalJson = serialize(
      proposal,
      'receipt category proposal',
      MAX_PROPOSAL_BYTES,
    );
    const metadataJson = serialize(
      metadata,
      'receipt category metadata',
      MAX_METADATA_BYTES,
    );
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'classify-receipt-items');
      const providerCall = this.#database
        .prepare(
          `SELECT 1 FROM receipt_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .get(eventId);
      if (providerCall === undefined) {
        throw new Error('Receipt provider call marker is missing');
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_items
              SET status = 'planned',
                  proposal_json = ?,
                  model_metadata_json = ?,
                  updated_at = ?
            WHERE event_id = ? AND status = 'observed'`,
        )
        .run(proposalJson, metadataJson, now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Receipt category proposal was already persisted');
      }
      this.#appendAudit(
        eventId,
        'receipt-categorization.model-proposal-persisted',
        {
          zeroDataRetention: metadata.zeroDataRetention,
          costInUsdTicks: metadata.usage.costInUsdTicks,
          itemCount: proposal.items.length,
        },
        now,
      );
      this.#database
        .prepare(
          `DELETE FROM receipt_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .run(eventId);
    })();
  }

  clearProviderCallAndRetry(
    jobId: number,
    eventId: string,
    errorCodeInput: string,
    availableAtInput: string,
    nowInput: string,
  ): void {
    const errorCode = errorCodeSchema.parse(errorCodeInput);
    const availableAt = timestampSchema.parse(availableAtInput);
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'classify-receipt-items');
      const deleted = this.#database
        .prepare(
          `DELETE FROM receipt_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .run(eventId);
      if (deleted.changes !== 1) {
        throw new Error('Receipt provider call marker is not active');
      }
      this.#retryClaimedJob(jobId, errorCode, availableAt);
      this.#appendAudit(
        eventId,
        'receipt-categorization.provider-call-not-sent',
        { availableAt },
        now,
      );
    })();
  }

  recordEvaluation(
    jobId: number,
    eventId: string,
    untrustedResult: ReceiptCategorizationResult,
    clarificationMessageInput: string | undefined,
    nowInput: string,
  ): ReceiptCategorizationItem {
    const result = categorizationResultSchema.parse(
      untrustedResult,
    ) as ReceiptCategorizationResult;
    const clarificationMessage =
      clarificationMessageInput === undefined
        ? undefined
        : z.string().min(1).max(2_000).parse(clarificationMessageInput);
    const now = timestampSchema.parse(nowInput);
    const decisionJson = serialize(
      result,
      'receipt categorization decision',
      MAX_DECISION_BYTES,
    );
    return this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'classify-receipt-items');
      const item = this.#requireItem(eventId);
      if (item.status !== 'planned') {
        throw new Error('Receipt category proposal is not awaiting evaluation');
      }
      const source = this.#requireSource(eventId);
      const status = result.disposition === 'ready' ? 'ready' : 'attention';
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_items
              SET status = ?, decision_json = ?, updated_at = ?
            WHERE event_id = ? AND status = 'planned'
              AND decision_json IS NULL`,
        )
        .run(status, decisionJson, now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Receipt categorization evaluation already exists');
      }
      this.#completeClaimedJob(jobId, now);
      if (result.disposition === 'ready') {
        this.#enqueue(
          'publish-ready-receipt',
          eventId,
          {},
          `receipt-categorization:publish:${source.source_sha256}`,
          now,
        );
      } else if (clarificationMessage !== undefined) {
        const payload = talkPayloadSchema.parse({
          roomToken: source.room_token,
          message: clarificationMessage,
          replyTo: source.message_id,
          referenceId: createReceiptCategorizationReferenceId(eventId),
          silent: false,
        });
        this.#enqueue(
          'send-receipt-categorization-clarification',
          eventId,
          payload,
          `receipt-categorization:clarification:${source.source_sha256}`,
          now,
        );
        this.#recordClarificationRequest(
          eventId,
          payload,
          `receipt-categorization:clarification:${source.source_sha256}`,
          now,
        );
      }
      this.#appendAudit(
        eventId,
        `receipt-categorization.${status}`,
        result,
        now,
      );
      return toItem(this.#requireItem(eventId));
    })();
  }

  recordDeterministicReevaluation(
    eventIdInput: string,
    untrustedResult: Extract<
      ReceiptCategorizationResult,
      { disposition: 'ready' }
    >,
    nowInput: string,
  ): boolean {
    const eventId = identifierSchema.parse(eventIdInput);
    const parsed = categorizationResultSchema.parse(untrustedResult);
    if (parsed.disposition !== 'ready') {
      throw new TypeError('Deterministic reevaluation must be ready');
    }
    const result = parsed as Extract<
      ReceiptCategorizationResult,
      { disposition: 'ready' }
    >;
    const now = timestampSchema.parse(nowInput);
    const decisionJson = serialize(
      result,
      'receipt categorization reevaluation',
      MAX_DECISION_BYTES,
    );
    return this.#database.transaction(() => {
      if (this.#isIgnored(eventId)) {
        return false;
      }
      const item = this.#requireItem(eventId);
      if (item.status !== 'attention' || item.decision_json === null) {
        return false;
      }
      const previous = categorizationResultSchema.parse(
        parseJson(item.decision_json),
      ) as ReceiptCategorizationResult;
      if (!isReceiptCategorizationDeterministicallyReevaluatable(previous)) {
        return false;
      }
      const processingClarification = this.#database
        .prepare(
          `SELECT 1
             FROM receipt_categorization_outbox
            WHERE event_id = ?
              AND kind = 'send-receipt-categorization-clarification'
              AND state = 'processing'`,
        )
        .get(eventId);
      if (processingClarification !== undefined) {
        return false;
      }
      const source = this.#requireSource(eventId);
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_items
              SET status = 'ready', decision_json = ?, updated_at = ?
            WHERE event_id = ? AND status = 'attention'`,
        )
        .run(decisionJson, now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Receipt deterministic reevaluation was not stored');
      }
      this.#database
        .prepare(
          `UPDATE receipt_categorization_outbox
              SET state = 'failed',
                  locked_at = NULL,
                  lease_expires_at = NULL,
                  last_error = 'resolved-by-deterministic-reevaluation'
            WHERE event_id = ?
              AND kind = 'send-receipt-categorization-clarification'
              AND state = 'pending'`,
        )
        .run(eventId);
      this.#enqueue(
        'publish-ready-receipt',
        eventId,
        {},
        `receipt-categorization:publish:${source.source_sha256}`,
        now,
      );
      this.#appendAudit(
        eventId,
        'receipt-categorization.deterministically-reevaluated',
        {
          previousIssueCodes: previous.issueCodes,
          result,
        },
        now,
      );
      return true;
    })();
  }

  getReadyReceipt(
    eventId: string,
  ): ReadyReceiptCategorizationRecord | undefined {
    if (this.#isIgnored(eventId)) {
      return undefined;
    }
    const source = this.#sourceRow(eventId);
    const item = this.#itemRow(eventId);
    if (
      source === undefined ||
      item === undefined ||
      (item.status !== 'ready' && item.status !== 'published') ||
      item.decision_json === null
    ) {
      return undefined;
    }
    const override = this.#database
      .prepare(
        `SELECT result_json
           FROM receipt_categorization_clarification_resolutions
          WHERE event_id = ?`,
      )
      .get(eventId) as { result_json: string } | undefined;
    const decision = categorizationResultSchema.parse(
      override === undefined
        ? parseJson(item.decision_json)
        : parseJson(override.result_json),
    ) as ReceiptCategorizationResult;
    if (decision.disposition !== 'ready') {
      return undefined;
    }
    const parsedSource = toSource(source);
    return {
      schemaVersion: 'ready-receipt-categorization.v1',
      receiptId: parsedSource.eventId,
      idempotencyKey: `receipt-source-sha256:${parsedSource.sourceSha256}`,
      sourceSha256: parsedSource.sourceSha256,
      roomToken: parsedSource.roomToken,
      messageId: parsedSource.messageId,
      receivedAt: parsedSource.receivedAt,
      record: parsedSource.record,
      splits: decision.splits,
      totalMinorUnits: decision.totalMinorUnits,
      status: item.status,
    };
  }

  listReadyReceipts(
    includePublished = false,
    limit = 1_000,
  ): ReadyReceiptCategorizationRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Ready receipt limit is outside safe bounds');
    }
    const rows = this.#database
      .prepare(
        `SELECT source.event_id
           FROM receipt_categorization_sources AS source
          JOIN receipt_categorization_items AS item
             ON item.event_id = source.event_id
          WHERE item.status ${includePublished ? "IN ('ready', 'published')" : "= 'ready'"}
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_categorization_ignores AS ignored
               WHERE ignored.event_id = source.event_id
            )
          ORDER BY source.received_at, source.event_id
          LIMIT ?`,
      )
      .all(limit) as Array<{ event_id: string }>;
    return rows.flatMap((row) => {
      const ready = this.getReadyReceipt(row.event_id);
      return ready === undefined ? [] : [ready];
    });
  }

  markPublished(
    jobId: number,
    eventId: string,
    nowInput: string,
  ): ReceiptCategorizationItem {
    const now = timestampSchema.parse(nowInput);
    return this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'publish-ready-receipt');
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_items
              SET status = 'published', updated_at = ?, published_at = ?
            WHERE event_id = ? AND status = 'ready'`,
        )
        .run(now, now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Ready receipt could not be marked published');
      }
      this.#completeClaimedJob(jobId, now);
      this.#appendAudit(eventId, 'receipt-categorization.published', {}, now);
      return toItem(this.#requireItem(eventId));
    })();
  }

  enqueueFailureNotice(eventId: string, nowInput: string): boolean {
    const now = timestampSchema.parse(nowInput);
    return this.#database.transaction(() =>
      this.#enqueueFailureNotice(eventId, now),
    )();
  }

  completeTalkJob(
    jobId: number,
    eventId: string,
    deliveryInput: {
      referenceId: string;
      roomToken: string;
      botActorId: string;
      messageId: string;
    },
    nowInput: string,
  ): void {
    const referenceId = hashSchema.parse(deliveryInput.referenceId);
    const roomToken = identifierSchema.parse(deliveryInput.roomToken);
    const botActorId = botActorIdSchema.parse(deliveryInput.botActorId);
    const messageId = identifierSchema.parse(deliveryInput.messageId);
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      const job = this.#claimedJob(
        jobId,
        eventId,
        'send-receipt-categorization-clarification',
      );
      const payload = talkPayloadSchema.parse(parseJson(job.payload_json));
      if (payload.referenceId !== referenceId) {
        throw new Error('Receipt clarification reference does not match');
      }
      if (payload.roomToken !== roomToken) {
        throw new Error('Receipt clarification room does not match');
      }
      this.#database
        .prepare(
          `INSERT INTO receipt_categorization_clarification_deliveries (
             reference_id, room_token, bot_actor_id, message_id, delivered_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(reference_id) DO NOTHING`,
        )
        .run(referenceId, roomToken, botActorId, messageId, now);
      const persisted = this.#database
        .prepare(
          `SELECT room_token, bot_actor_id, message_id
             FROM receipt_categorization_clarification_deliveries
            WHERE reference_id = ?`,
        )
        .get(referenceId) as {
        room_token: string;
        bot_actor_id: string;
        message_id: string;
      };
      if (
        persisted.room_token !== roomToken ||
        persisted.bot_actor_id !== botActorId ||
        persisted.message_id !== messageId
      ) {
        throw new Error('Receipt clarification delivery identity changed');
      }
      this.#completeClaimedJob(jobId, now);
      this.#appendAudit(
        eventId,
        this.#requireItem(eventId).status === 'failed'
          ? 'receipt-categorization.failure-notice-delivered'
          : 'receipt-categorization.clarification-delivered',
        { referenceId },
        now,
      );
    })();
  }

  claimNextJob(
    nowInput: string,
    leaseDurationSeconds = 300,
  ): ReceiptCategorizationJob | undefined {
    const now = timestampSchema.parse(nowInput);
    positiveInteger(leaseDurationSeconds, 'leaseDurationSeconds');
    if (leaseDurationSeconds > 3_600) {
      throw new RangeError('leaseDurationSeconds cannot exceed one hour');
    }
    const leaseExpiresAt = new Date(
      new Date(now).valueOf() + leaseDurationSeconds * 1_000,
    ).toISOString();
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT id, idempotency_key, kind, event_id, payload_json,
                  state, attempt_count, lease_expires_at
             FROM receipt_categorization_outbox
            WHERE state = 'pending'
              AND available_at <= ?
              AND NOT EXISTS (
                SELECT 1
                  FROM receipt_categorization_ignores AS ignored
                 WHERE ignored.event_id =
                       receipt_categorization_outbox.event_id
              )
            ORDER BY
              CASE kind
                WHEN 'classify-receipt-items' THEN 0
                WHEN 'publish-ready-receipt' THEN 1
                ELSE 2
              END,
              id
            LIMIT 1`,
        )
        .get(now) as JobRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const claimed = this.#database
        .prepare(
          `UPDATE receipt_categorization_outbox
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  locked_at = ?,
                  lease_expires_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(now, leaseExpiresAt, row.id);
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
        leaseExpiresAt,
      };
    })();
  }

  retryJob(
    jobId: number,
    errorCodeInput: string,
    availableAtInput: string,
  ): void {
    const errorCode = errorCodeSchema.parse(errorCodeInput);
    const availableAt = timestampSchema.parse(availableAtInput);
    const row = this.#database
      .prepare(
        `SELECT kind, event_id
           FROM receipt_categorization_outbox
          WHERE id = ? AND state = 'processing'`,
      )
      .get(jobId) as
      { kind: ReceiptCategorizationJobKind; event_id: string } | undefined;
    if (row?.kind === 'classify-receipt-items') {
      const providerCall = this.#database
        .prepare(
          `SELECT 1
             FROM receipt_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .get(row.event_id);
      if (providerCall !== undefined) {
        throw new Error(
          'Cannot retry receipt classification while a provider call is uncertain',
        );
      }
    }
    this.#retryClaimedJob(jobId, errorCode, availableAt);
  }

  deferTalkJobWithoutAttempt(jobId: number, availableAtInput: string): void {
    const availableAt = timestampSchema.parse(availableAtInput);
    const changed = this.#database
      .prepare(
        `UPDATE receipt_categorization_outbox
            SET state = 'pending',
                attempt_count = attempt_count - 1,
                available_at = ?,
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error = NULL
          WHERE id = ?
            AND kind = 'send-receipt-categorization-clarification'
            AND state = 'processing'
            AND attempt_count > 0`,
      )
      .run(availableAt, jobId);
    if (changed.changes !== 1) {
      throw new Error('Receipt Talk deferral does not own the claimed job');
    }
  }

  /**
   * Durable backpressure for a newer canonical receipt revision while the
   * prior matcher/apply job is still inside its short processing lease.
   * Waiting is not a failed publish attempt and must not exhaust the ordinary
   * dependency retry budget.
   */
  deferPublishJob(
    jobId: number,
    eventId: string,
    availableAtInput: string,
    nowInput: string,
  ): void {
    const availableAt = timestampSchema.parse(availableAtInput);
    const now = timestampSchema.parse(nowInput);
    if (availableAt <= now) {
      throw new RangeError('Deferred receipt publish must be scheduled later');
    }
    this.#database.transaction(() => {
      const job = this.#claimedJob(jobId, eventId, 'publish-ready-receipt');
      const item = this.#requireItem(eventId);
      if (item.status !== 'ready') {
        throw new Error('Receipt categorization item is not ready to publish');
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_outbox
              SET state = 'pending',
                  attempt_count = CASE
                    WHEN attempt_count > 0 THEN attempt_count - 1
                    ELSE 0
                  END,
                  available_at = ?,
                  locked_at = NULL,
                  lease_expires_at = NULL,
                  last_error = 'receipt-match-still-processing'
            WHERE id = ?
              AND event_id = ?
              AND kind = 'publish-ready-receipt'
              AND state = 'processing'`,
        )
        .run(availableAt, jobId, eventId);
      if (updated.changes !== 1) {
        throw new Error('Receipt publish deferral could not be persisted');
      }
      this.#appendAudit(
        eventId,
        'receipt-categorization.publish-deferred',
        { kind: job.kind, availableAt },
        now,
      );
    })();
  }

  deadLetterJob(
    jobId: number,
    eventId: string,
    errorCodeInput: string,
    nowInput: string,
  ): void {
    const errorCode = errorCodeSchema.parse(errorCodeInput);
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      const job = this.#claimedJob(jobId, eventId);
      if (job.kind !== 'send-receipt-categorization-clarification') {
        this.#failClaimedJob(jobId, eventId, errorCode, now);
        return;
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_categorization_outbox
              SET state = 'failed',
                  locked_at = NULL,
                  lease_expires_at = NULL,
                  last_error = ?
            WHERE id = ? AND state = 'processing'`,
        )
        .run(errorCode, jobId);
      if (updated.changes !== 1) {
        throw new Error('Receipt categorization job is not claimed');
      }
      this.#appendAudit(
        eventId,
        'receipt-categorization.job-dead-lettered',
        { kind: job.kind, errorCode },
        now,
      );
    })();
  }

  recoverExpiredJobs(nowInput: string): number {
    const now = timestampSchema.parse(nowInput);
    return this.#database.transaction(() => {
      let recovered = 0;
      const uncertainCalls = this.#database
        .prepare(
          `SELECT provider_call.event_id,
                  outbox.id AS job_id
             FROM receipt_categorization_provider_calls AS provider_call
             JOIN receipt_categorization_outbox AS outbox
               ON outbox.event_id = provider_call.event_id
              AND outbox.kind = 'classify-receipt-items'
            WHERE outbox.state = 'processing'
              AND outbox.lease_expires_at <= ?
            ORDER BY provider_call.event_id`,
        )
        .all(now) as Array<{ event_id: string; job_id: number }>;
      for (const call of uncertainCalls) {
        this.#failClaimedJob(
          call.job_id,
          call.event_id,
          'provider-outcome-unknown',
          now,
        );
        this.#enqueueFailureNotice(call.event_id, now);
        this.#appendAudit(
          call.event_id,
          'receipt-categorization.provider-outcome-unknown',
          {},
          now,
        );
        recovered += 1;
      }

      const interrupted = this.#database
        .prepare(
          `SELECT id, event_id, kind
             FROM receipt_categorization_outbox
            WHERE state = 'processing' AND lease_expires_at <= ?
            ORDER BY id`,
        )
        .all(now) as Array<{
        id: number;
        event_id: string;
        kind: ReceiptCategorizationJobKind;
      }>;
      for (const job of interrupted) {
        const updated = this.#database
          .prepare(
            `UPDATE receipt_categorization_outbox
                SET state = 'pending',
                    available_at = ?,
                    locked_at = NULL,
                    lease_expires_at = NULL,
                    last_error = 'lease-expired'
              WHERE id = ? AND state = 'processing'`,
          )
          .run(now, job.id);
        if (updated.changes !== 1) {
          throw new Error(
            'Expired receipt categorization job changed concurrently',
          );
        }
        this.#appendAudit(
          job.event_id,
          'receipt-categorization.job-recovered',
          { kind: job.kind },
          now,
        );
        recovered += 1;
      }
      return recovered;
    })();
  }

  listAudit(eventId: string): ReceiptCategorizationAuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT id, event_id, action, detail_json, occurred_at
           FROM receipt_categorization_audit_events
          WHERE event_id = ?
          ORDER BY id`,
      )
      .all(eventId) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      action: row.action,
      detail: parseJson(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }

  #sourceRow(eventId: string): SourceRow | undefined {
    return this.#database
      .prepare(
        `SELECT event_id, source_sha256, room_token, message_id,
                received_at, record_json
           FROM receipt_categorization_sources
          WHERE event_id = ?`,
      )
      .get(eventId) as SourceRow | undefined;
  }

  #requireSource(eventId: string): SourceRow {
    const row = this.#sourceRow(eventId);
    if (row === undefined) {
      throw new Error('Receipt categorization source does not exist');
    }
    return row;
  }

  #itemRow(eventId: string): ItemRow | undefined {
    return this.#database
      .prepare(
        `SELECT event_id, status, proposal_json, model_metadata_json,
                decision_json, error_code, created_at, updated_at, published_at
           FROM receipt_categorization_items
          WHERE event_id = ?`,
      )
      .get(eventId) as ItemRow | undefined;
  }

  #requireItem(eventId: string): ItemRow {
    const row = this.#itemRow(eventId);
    if (row === undefined) {
      throw new Error('Receipt categorization item does not exist');
    }
    return row;
  }

  #claimedJob(
    jobId: number,
    eventId: string,
    expectedKind?: ReceiptCategorizationJobKind,
  ): JobRow {
    const row = this.#database
      .prepare(
        `SELECT id, idempotency_key, kind, event_id, payload_json,
                state, attempt_count, lease_expires_at
           FROM receipt_categorization_outbox
          WHERE id = ? AND event_id = ? AND state = 'processing'`,
      )
      .get(jobId, eventId) as JobRow | undefined;
    if (
      row === undefined ||
      (expectedKind !== undefined && row.kind !== expectedKind)
    ) {
      throw new Error('Receipt categorization job is not claimed');
    }
    return row;
  }

  #recordClarificationRequest(
    eventId: string,
    payload: ReceiptCategorizationTalkPayload,
    outboxIdempotencyKey: string,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO receipt_categorization_clarifications (
           reference_id, event_id, room_token,
           outbox_idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        payload.referenceId,
        eventId,
        payload.roomToken,
        outboxIdempotencyKey,
        createdAt,
      );
  }

  #enqueue(
    kind: ReceiptCategorizationJobKind,
    eventId: string,
    payload: unknown,
    idempotencyKey: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO receipt_categorization_outbox (
           idempotency_key, kind, event_id, payload_json, state,
           attempt_count, available_at, created_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        idempotencyKey,
        kind,
        eventId,
        serialize(
          payload,
          'receipt categorization outbox payload',
          MAX_OUTBOX_BYTES,
        ),
        now,
        now,
      );
  }

  #enqueueFailureNotice(eventId: string, now: string): boolean {
    if (this.#isIgnored(eventId)) {
      return false;
    }
    const item = this.#requireItem(eventId);
    if (item.status !== 'failed') {
      throw new Error('Receipt failure notice requires a failed item');
    }
    const source = this.#requireSource(eventId);
    const idempotencyKey = `receipt-categorization:failure:${source.source_sha256}`;
    const existing = this.#database
      .prepare(
        `SELECT 1
           FROM receipt_categorization_outbox
          WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey);
    if (existing !== undefined) {
      return false;
    }
    this.#enqueue(
      'send-receipt-categorization-clarification',
      eventId,
      talkPayloadSchema.parse({
        roomToken: source.room_token,
        message: RECEIPT_CATEGORIZATION_FAILURE_NOTICE,
        replyTo: source.message_id,
        referenceId: createReceiptCategorizationFailureReferenceId(eventId),
        silent: false,
      }),
      idempotencyKey,
      now,
    );
    this.#appendAudit(
      eventId,
      'receipt-categorization.failure-notice-queued',
      {},
      now,
    );
    return true;
  }

  #completeClaimedJob(jobId: number, now: string): void {
    const completed = this.#database
      .prepare(
        `UPDATE receipt_categorization_outbox
            SET state = 'completed',
                locked_at = NULL,
                lease_expires_at = NULL,
                completed_at = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
    if (completed.changes !== 1) {
      throw new Error('Receipt categorization job is not claimed');
    }
  }

  #retryClaimedJob(
    jobId: number,
    errorCode: string,
    availableAt: string,
  ): void {
    const retried = this.#database
      .prepare(
        `UPDATE receipt_categorization_outbox
            SET state = 'pending',
                available_at = ?,
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(availableAt, errorCode, jobId);
    if (retried.changes !== 1) {
      throw new Error('Receipt categorization job is not claimed');
    }
  }

  #failClaimedJob(
    jobId: number,
    eventId: string,
    errorCode: string,
    now: string,
  ): void {
    const item = this.#requireItem(eventId);
    if (
      item.status !== 'observed' &&
      item.status !== 'planned' &&
      item.status !== 'ready'
    ) {
      throw new Error('Receipt categorization item cannot fail');
    }
    const failedItem = this.#database
      .prepare(
        `UPDATE receipt_categorization_items
            SET status = 'failed', error_code = ?, updated_at = ?
          WHERE event_id = ? AND status IN ('observed', 'planned', 'ready')`,
      )
      .run(errorCode, now, eventId);
    if (failedItem.changes !== 1) {
      throw new Error('Receipt categorization item could not be failed');
    }
    const failedJob = this.#database
      .prepare(
        `UPDATE receipt_categorization_outbox
            SET state = 'failed',
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(errorCode, jobId);
    if (failedJob.changes !== 1) {
      throw new Error('Receipt categorization job could not be failed');
    }
    this.#database
      .prepare(
        `DELETE FROM receipt_categorization_provider_calls
          WHERE event_id = ?`,
      )
      .run(eventId);
    this.#appendAudit(
      eventId,
      'receipt-categorization.failed',
      { errorCode },
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
        `INSERT INTO receipt_categorization_audit_events (
           event_id, action, detail_json, occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        eventId,
        action,
        serialize(detail, 'receipt categorization audit', MAX_OUTBOX_BYTES),
        occurredAt,
      );
  }

  #isIgnored(eventId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM receipt_categorization_ignores
            WHERE event_id = ?
            LIMIT 1`,
        )
        .get(eventId) !== undefined
    );
  }
}
