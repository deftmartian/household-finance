import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  transactionCategorizationObservationSchema,
  transactionCategoryProposalSchema,
  type TransactionCategorizationObservation,
  type TransactionCategoryProposal,
} from '../categorization/transaction.js';
import type { XaiStructuredRunMetadata } from '../model/xai-structured-client.js';

const MAX_OBSERVATIONS_PER_SCAN = 500;
const MAX_OBSERVER_BYTES = 16 * 1_024;
const MAX_PROPOSAL_BYTES = 16 * 1_024;
const MAX_METADATA_BYTES = 16 * 1_024;
const MAX_DECISION_BYTES = 8 * 1_024;
const MAX_OUTBOX_BYTES = 8 * 1_024;

export type TransactionCategorizationStatus =
  | 'observed'
  | 'planned'
  | 'ignored'
  | 'attention'
  | 'ready'
  | 'applied'
  | 'failed';

export type TransactionCategorizationIgnoreReason =
  | 'excluded-account'
  | 'split-transaction'
  | 'currently-categorized'
  | 'receipt-owned'
  | 'transfer'
  | 'card-payment'
  | 'debt-payment';

export type TransactionCategorizationAttentionReason =
  | 'category-not-allowed'
  | 'merchant-rule-conflict'
  | 'model-low-confidence'
  | 'apply-conflict';

export type TransactionCategorizationDecisionSource =
  'confirmed-merchant-rule' | 'model' | 'refund-link' | 'special';

export type TransactionCategorizationDecision =
  | {
      disposition: 'apply';
      categoryAlias: string;
      source: TransactionCategorizationDecisionSource;
    }
  | {
      disposition: 'ignore';
      reason: TransactionCategorizationIgnoreReason;
    }
  | {
      disposition: 'clarify';
      reason: TransactionCategorizationAttentionReason;
      question: string;
    };

/**
 * Root's Actual-reader adapter must omit tombstones, starting balances, and
 * split children. Those fields are intentionally not representable here.
 */
export interface TransactionCategorizationObserverRecord {
  schemaVersion: 'transaction-categorization-observer-record.v1';
  transactionId: string;
  importedId: string;
  /**
   * Opaque CAS guard issued by the deterministic ledger reader. This stays
   * outside the model-facing observation and is passed back unchanged when a
   * category update is prepared.
   */
  actualObservationFingerprint: string;
  accountOnBudget: boolean;
  currentCategoryStatus:
    'uncategorized' | 'contract-bound' | 'unbound' | 'split';
  split: boolean;
  observation: TransactionCategorizationObservation;
}

export interface TransactionCategorizationObservedRecord extends TransactionCategorizationObserverRecord {
  id: string;
  fingerprint: string;
  observedAt: string;
}

export interface TransactionCategorizationItem {
  eventId: string;
  status: TransactionCategorizationStatus;
  proposal?: TransactionCategoryProposal;
  modelMetadata?: XaiStructuredRunMetadata;
  decision?: TransactionCategorizationDecision;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionCategorizationScanResult {
  inserted: number;
  duplicates: number;
  refreshed: number;
  requeued: number;
  conflicts: number;
  watermark: string;
}

export interface TransactionCategoryUpdateRequest {
  schemaVersion: 'transaction-category-update-request.v1';
  idempotencyKey: string;
  importedId: string;
  accountAlias: string;
  /**
   * The reader-issued Actual observation fingerprint, not the store's
   * categorization identity fingerprint.
   */
  observationFingerprint: string;
  categoryAlias: string;
}

export interface TransactionCategorizationTalkPayload {
  roomToken: string;
  message: string;
  referenceId: string;
  silent: boolean;
}

export type TransactionCategorizationJobKind =
  | 'classify-transaction'
  | 'apply-transaction-category'
  | 'send-transaction-categorization-clarification';

export interface TransactionCategorizationJob {
  id: number;
  idempotencyKey: string;
  kind: TransactionCategorizationJobKind;
  eventId: string;
  payload: unknown;
  attemptCount: number;
  leaseExpiresAt: string;
}

export interface TransactionCategorizationAuditEvent {
  id: number;
  eventId: string;
  action: string;
  detail: unknown;
  occurredAt: string;
}

export interface TransactionCategorizationClarificationResolution {
  referenceId: string;
  eventId: string;
  roomToken: string;
  categoryAlias: string;
  actorId: string;
  inboundMessageId: string;
  parentBotId: string;
  parentMessageId: string;
  resolvedAt: string;
}

export interface OpenTransactionCategorizationClarification {
  referenceId: string;
  eventId: string;
  roomToken: string;
  botActorId: string;
  parentMessageId: string;
  deliveredAt: string;
  summary: string;
}

interface ObservationRow {
  id: string;
  transaction_id: string;
  imported_id: string;
  fingerprint: string;
  observer_json: string;
  observed_at: string;
}

interface ItemRow {
  event_id: string;
  status: TransactionCategorizationStatus;
  proposal_json: string | null;
  model_metadata_json: string | null;
  decision_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: number;
  idempotency_key: string;
  kind: TransactionCategorizationJobKind;
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
  reason: TransactionCategorizationAttentionReason;
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
  resolved_at: string;
}

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

const observerSchema = z
  .strictObject({
    schemaVersion: z.literal('transaction-categorization-observer-record.v1'),
    transactionId: identifierSchema.max(200),
    importedId: identifierSchema,
    actualObservationFingerprint: hashSchema,
    accountOnBudget: z.boolean(),
    currentCategoryStatus: z.enum([
      'uncategorized',
      'contract-bound',
      'unbound',
      'split',
    ]),
    split: z.boolean(),
    observation: transactionCategorizationObservationSchema,
  })
  .superRefine((value, context) => {
    if (
      value.split !== (value.currentCategoryStatus === 'split') ||
      (value.currentCategoryStatus === 'contract-bound') !==
        (value.observation.currentCategoryAlias !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Categorization observer state is inconsistent',
      });
    }
  });

const decisionSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    disposition: z.literal('apply'),
    categoryAlias: categoryAliasSchema,
    source: z.enum([
      'confirmed-merchant-rule',
      'model',
      'refund-link',
      'special',
    ]),
  }),
  z.strictObject({
    disposition: z.literal('ignore'),
    reason: z.enum([
      'excluded-account',
      'split-transaction',
      'currently-categorized',
      'receipt-owned',
      'transfer',
      'card-payment',
      'debt-payment',
    ]),
  }),
  z.strictObject({
    disposition: z.literal('clarify'),
    reason: z.enum([
      'category-not-allowed',
      'merchant-rule-conflict',
      'model-low-confidence',
      'apply-conflict',
    ]),
    question: z.string().min(1).max(500),
  }),
]);

const modelMetadataSchema = z.strictObject({
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

const updateRequestSchema = z.strictObject({
  schemaVersion: z.literal('transaction-category-update-request.v1'),
  idempotencyKey: z.string().min(1).max(200),
  importedId: identifierSchema,
  accountAlias: categoryAliasSchema,
  observationFingerprint: hashSchema,
  categoryAlias: categoryAliasSchema,
});

const talkPayloadSchema = z.strictObject({
  roomToken: identifierSchema,
  message: z.string().min(1).max(2_000),
  referenceId: hashSchema,
  silent: z.boolean(),
});

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS transaction_categorization_observations (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL UNIQUE,
    imported_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    observer_json TEXT NOT NULL CHECK (
      length(CAST(observer_json AS BLOB)) <= ${String(MAX_OBSERVER_BYTES)}
    ),
    observed_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_observation_no_update
  BEFORE UPDATE OF id, transaction_id, imported_id
    ON transaction_categorization_observations
  WHEN OLD.id <> NEW.id
    OR OLD.transaction_id <> NEW.transaction_id
    OR OLD.imported_id <> NEW.imported_id
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization observation identity is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_observation_no_delete
  BEFORE DELETE ON transaction_categorization_observations
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization observations are immutable');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_observation_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL
      REFERENCES transaction_categorization_observations(id),
    fingerprint TEXT NOT NULL,
    observer_json TEXT NOT NULL CHECK (
      length(CAST(observer_json AS BLOB)) <= ${String(MAX_OBSERVER_BYTES)}
    ),
    observed_at TEXT NOT NULL,
    superseded_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_observation_revision_no_update
  BEFORE UPDATE ON transaction_categorization_observation_revisions
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization observation revisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_observation_revision_no_delete
  BEFORE DELETE ON transaction_categorization_observation_revisions
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization observation revisions are immutable');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_items (
    event_id TEXT PRIMARY KEY
      REFERENCES transaction_categorization_observations(id),
    status TEXT NOT NULL CHECK (
      status IN (
        'observed', 'planned', 'ignored', 'attention',
        'ready', 'applied', 'failed'
      )
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
    CHECK (
      (proposal_json IS NULL AND model_metadata_json IS NULL)
      OR (proposal_json IS NOT NULL AND model_metadata_json IS NOT NULL)
    ),
    CHECK (
      (status = 'observed'
        AND proposal_json IS NULL
        AND decision_json IS NULL
        AND error_code IS NULL)
      OR (status = 'planned'
        AND proposal_json IS NOT NULL
        AND decision_json IS NULL
        AND error_code IS NULL)
      OR (status IN ('ignored', 'attention', 'ready', 'applied')
        AND decision_json IS NOT NULL
        AND error_code IS NULL)
      OR (status = 'failed' AND error_code IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS transaction_categorization_item_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL
      REFERENCES transaction_categorization_observations(id),
    status TEXT NOT NULL,
    proposal_json TEXT,
    model_metadata_json TEXT,
    decision_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_item_revision_no_update
  BEFORE UPDATE ON transaction_categorization_item_revisions
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization item revisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_item_revision_no_delete
  BEFORE DELETE ON transaction_categorization_item_revisions
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization item revisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_status_transition
  BEFORE UPDATE OF status ON transaction_categorization_items
  WHEN NOT (
    (OLD.status = 'observed'
      AND NEW.status IN ('planned', 'ignored', 'attention', 'ready', 'failed'))
    OR (OLD.status = 'planned'
      AND NEW.status IN ('ignored', 'attention', 'ready', 'failed'))
    OR (OLD.status = 'attention' AND NEW.status = 'ready')
    OR (OLD.status = 'ready'
      AND NEW.status IN ('ignored', 'applied', 'attention', 'failed'))
    OR (OLD.status IN ('ignored', 'attention', 'applied', 'failed')
      AND NEW.status = 'observed'
      AND NEW.proposal_json IS NULL
      AND NEW.model_metadata_json IS NULL
      AND NEW.decision_json IS NULL
      AND NEW.error_code IS NULL)
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid transaction categorization status transition');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_proposal_once
  BEFORE UPDATE OF proposal_json, model_metadata_json
    ON transaction_categorization_items
  WHEN NOT (
    (
      OLD.status = 'observed'
      AND NEW.status = 'planned'
      AND OLD.proposal_json IS NULL
      AND OLD.model_metadata_json IS NULL
      AND NEW.proposal_json IS NOT NULL
      AND NEW.model_metadata_json IS NOT NULL
    )
    OR (
      OLD.status IN ('ignored', 'attention', 'applied', 'failed')
      AND NEW.status = 'observed'
      AND NEW.proposal_json IS NULL
      AND NEW.model_metadata_json IS NULL
      AND NEW.decision_json IS NULL
      AND NEW.error_code IS NULL
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization model proposal is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_decision_once
  BEFORE UPDATE OF decision_json ON transaction_categorization_items
  WHEN NOT (
    (
      OLD.decision_json IS NULL
      AND NEW.decision_json IS NOT NULL
      AND NEW.status IN ('ignored', 'attention', 'ready')
    )
    OR (
      OLD.status IN ('ignored', 'attention', 'applied', 'failed')
      AND NEW.status = 'observed'
      AND NEW.proposal_json IS NULL
      AND NEW.model_metadata_json IS NULL
      AND NEW.decision_json IS NULL
      AND NEW.error_code IS NULL
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization decision is immutable');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'classify-transaction',
        'apply-transaction-category',
        'send-transaction-categorization-clarification'
      )
    ),
    event_id TEXT NOT NULL
      REFERENCES transaction_categorization_observations(id),
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

  CREATE INDEX IF NOT EXISTS transaction_categorization_outbox_ready
    ON transaction_categorization_outbox(state, available_at, id);

  CREATE TABLE IF NOT EXISTS transaction_categorization_clarifications (
    reference_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL
      REFERENCES transaction_categorization_observations(id),
    room_token TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (
      reason IN (
        'category-not-allowed',
        'merchant-rule-conflict',
        'model-low-confidence',
        'apply-conflict'
      )
    ),
    outbox_idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_clarification_no_update
  BEFORE UPDATE ON transaction_categorization_clarifications
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization clarifications are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_clarification_no_delete
  BEFORE DELETE ON transaction_categorization_clarifications
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization clarifications are immutable');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_clarification_deliveries (
    reference_id TEXT PRIMARY KEY
      REFERENCES transaction_categorization_clarifications(reference_id),
    room_token TEXT NOT NULL,
    bot_actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    delivered_at TEXT NOT NULL,
    UNIQUE(room_token, message_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_delivery_no_update
  BEFORE UPDATE ON transaction_categorization_clarification_deliveries
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization deliveries are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_delivery_no_delete
  BEFORE DELETE ON transaction_categorization_clarification_deliveries
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization deliveries are immutable');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_clarification_resolutions (
    reference_id TEXT PRIMARY KEY
      REFERENCES transaction_categorization_clarifications(reference_id),
    event_id TEXT NOT NULL
      REFERENCES transaction_categorization_observations(id),
    room_token TEXT NOT NULL,
    category_alias TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL,
    parent_bot_id TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    resolved_at TEXT NOT NULL,
    UNIQUE(event_id),
    UNIQUE(room_token, inbound_message_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_resolution_no_update
  BEFORE UPDATE ON transaction_categorization_clarification_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization resolutions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_resolution_no_delete
  BEFORE DELETE ON transaction_categorization_clarification_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization resolutions are immutable');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_scan_watermark (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    watermark TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS transaction_categorization_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL
      REFERENCES transaction_categorization_observations(id),
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_audit_no_update
  BEFORE UPDATE ON transaction_categorization_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization audit is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS transaction_categorization_audit_no_delete
  BEFORE DELETE ON transaction_categorization_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'transaction categorization audit is append-only');
  END;

  CREATE TABLE IF NOT EXISTS transaction_categorization_provider_calls (
    event_id TEXT PRIMARY KEY
      REFERENCES transaction_categorization_observations(id),
    started_at TEXT NOT NULL
  ) STRICT;
`;

export class TransactionCategorizationWatermarkConflictError extends Error {
  constructor() {
    super('Transaction scan watermark changed before page commit');
    this.name = 'TransactionCategorizationWatermarkConflictError';
  }
}

function json(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function serialized(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new TypeError(`${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(result, 'utf8') > maximumBytes) {
    throw new RangeError(`${name} exceeds its persisted byte limit`);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function observationFingerprint(
  observer: TransactionCategorizationObserverRecord,
): string {
  const observation = observer.observation;
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: observer.schemaVersion,
        transactionId: observer.transactionId,
        importedId: observer.importedId,
        accountOnBudget: observer.accountOnBudget,
        split: observer.split,
        observation: {
          schemaVersion: observation.schemaVersion,
          date: observation.date,
          accountAlias: observation.accountAlias,
          amountMinorUnits: observation.amountMinorUnits,
          direction: observation.direction,
          payeeName: observation.payeeName,
          memo: observation.memo,
          specialKind: observation.specialKind,
          originalRefundCategoryAlias: observation.originalRefundCategoryAlias,
        },
      }),
    )
    .digest('hex');
}

function isActionableObservation(
  observer: TransactionCategorizationObserverRecord,
): boolean {
  return (
    observer.accountOnBudget &&
    !observer.split &&
    observer.currentCategoryStatus === 'uncategorized'
  );
}

function parsedMetadata(value: unknown): XaiStructuredRunMetadata {
  return modelMetadataSchema.parse(value) as XaiStructuredRunMetadata;
}

function parsedObserver(
  value: unknown,
): TransactionCategorizationObserverRecord {
  return observerSchema.parse(value);
}

function parsedDecision(value: unknown): TransactionCategorizationDecision {
  return decisionSchema.parse(value);
}

function toObservation(
  row: ObservationRow,
): TransactionCategorizationObservedRecord {
  return {
    id: row.id,
    ...parsedObserver(json(row.observer_json)),
    fingerprint: row.fingerprint,
    observedAt: row.observed_at,
  };
}

function toItem(row: ItemRow): TransactionCategorizationItem {
  return {
    eventId: row.event_id,
    status: row.status,
    ...(row.proposal_json === null
      ? {}
      : {
          proposal: transactionCategoryProposalSchema.parse(
            json(row.proposal_json),
          ),
        }),
    ...(row.model_metadata_json === null
      ? {}
      : { modelMetadata: parsedMetadata(json(row.model_metadata_json)) }),
    ...(row.decision_json === null
      ? {}
      : { decision: parsedDecision(json(row.decision_json)) }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toClarificationResolution(
  row: ClarificationResolutionRow,
): TransactionCategorizationClarificationResolution {
  return {
    referenceId: row.reference_id,
    eventId: row.event_id,
    roomToken: row.room_token,
    categoryAlias: row.category_alias,
    actorId: row.actor_id,
    inboundMessageId: row.inbound_message_id,
    parentBotId: row.parent_bot_id,
    parentMessageId: row.parent_message_id,
    resolvedAt: row.resolved_at,
  };
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function createTransactionCategorizationReferenceId(
  eventId: string,
  purpose: string,
): string {
  return createHash('sha256')
    .update('transaction-categorization-talk-reply-v1\0')
    .update(eventId)
    .update('\0')
    .update(purpose)
    .digest('hex');
}

export function createTransactionCategoryUpdateRequest(
  observation: TransactionCategorizationObservedRecord,
  categoryAliasInput: string,
): TransactionCategoryUpdateRequest {
  const categoryAlias = categoryAliasSchema.parse(categoryAliasInput);
  const digest = createHash('sha256')
    .update('transaction-category-write.v2\0')
    .update(observation.observation.accountAlias)
    .update('\0')
    .update(observation.importedId)
    .update('\0')
    .update(observation.actualObservationFingerprint)
    .update('\0')
    .update(categoryAlias)
    .digest('hex');
  return updateRequestSchema.parse({
    schemaVersion: 'transaction-category-update-request.v1',
    idempotencyKey: `transaction-category:${digest}`,
    importedId: observation.importedId,
    accountAlias: observation.observation.accountAlias,
    observationFingerprint: observation.actualObservationFingerprint,
    categoryAlias,
  });
}

export class TransactionCategorizationStore {
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

  getWatermark(): string | null {
    const row = this.#database
      .prepare(
        `SELECT watermark
           FROM transaction_categorization_scan_watermark
          WHERE singleton = 1`,
      )
      .get() as { watermark: string } | undefined;
    return row?.watermark ?? null;
  }

  recordScanPage(input: {
    previousWatermark: string | null;
    watermark: string;
    observations: readonly TransactionCategorizationObserverRecord[];
    observedAt: string;
  }): TransactionCategorizationScanResult {
    const previous =
      input.previousWatermark === null
        ? null
        : hashSchema.parse(input.previousWatermark);
    const watermark = hashSchema.parse(input.watermark);
    const observedAt = timestampSchema.parse(input.observedAt);
    if (input.observations.length > MAX_OBSERVATIONS_PER_SCAN) {
      throw new RangeError('Transaction scan page exceeds 500 observations');
    }
    const observations = input.observations.map((value) =>
      parsedObserver(value),
    );

    return this.#database.transaction(() => {
      const persistedWatermark = this.getWatermark();
      if (persistedWatermark !== previous) {
        throw new TransactionCategorizationWatermarkConflictError();
      }
      let inserted = 0;
      let duplicates = 0;
      let refreshed = 0;
      let requeued = 0;
      let conflicts = 0;
      for (const observer of observations) {
        const fingerprint = observationFingerprint(observer);
        const observerJson = serialized(
          observer,
          'transaction observer',
          MAX_OBSERVER_BYTES,
        );
        const existing = this.#database
          .prepare(
            `SELECT *
               FROM transaction_categorization_observations
              WHERE imported_id = ? OR transaction_id = ?
              ORDER BY id
              LIMIT 1`,
          )
          .get(observer.importedId, observer.transactionId) as
          ObservationRow | undefined;
        if (existing !== undefined) {
          if (
            existing.imported_id !== observer.importedId ||
            existing.transaction_id !== observer.transactionId
          ) {
            this.#appendAudit(
              existing.id,
              'transaction-categorization.identity-conflict-isolated',
              {
                incomingImportedIdentityHash: createHash('sha256')
                  .update(observer.importedId)
                  .digest('hex'),
                incomingTransactionIdentityHash: createHash('sha256')
                  .update(observer.transactionId)
                  .digest('hex'),
              },
              observedAt,
            );
            conflicts += 1;
            continue;
          }
          if (existing.observer_json === observerJson) {
            duplicates += 1;
            continue;
          }

          const previousObserver = parsedObserver(json(existing.observer_json));
          this.#database
            .prepare(
              `INSERT INTO transaction_categorization_observation_revisions (
                 event_id, fingerprint, observer_json, observed_at,
                 superseded_at
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              existing.id,
              existing.fingerprint,
              existing.observer_json,
              existing.observed_at,
              observedAt,
            );
          const updatedObservation = this.#database
            .prepare(
              `UPDATE transaction_categorization_observations
                  SET fingerprint = ?,
                      observer_json = ?,
                      observed_at = ?
                WHERE id = ?
                  AND transaction_id = ?
                  AND imported_id = ?`,
            )
            .run(
              fingerprint,
              observerJson,
              observedAt,
              existing.id,
              observer.transactionId,
              observer.importedId,
            );
          if (updatedObservation.changes !== 1) {
            throw new Error(
              'Transaction categorization observation changed concurrently',
            );
          }

          const item = this.#requireItem(existing.id);
          const shouldRequeue =
            item.status === 'attention' ||
            (isActionableObservation(observer) &&
              (item.status === 'ignored' ||
                item.status === 'applied' ||
                item.status === 'failed'));
          if (shouldRequeue) {
            this.#database
              .prepare(
                `INSERT INTO transaction_categorization_item_revisions (
                   event_id, status, proposal_json, model_metadata_json,
                   decision_json, error_code, created_at, updated_at,
                   superseded_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                item.event_id,
                item.status,
                item.proposal_json,
                item.model_metadata_json,
                item.decision_json,
                item.error_code,
                item.created_at,
                item.updated_at,
                observedAt,
              );
            const reset = this.#database
              .prepare(
                `UPDATE transaction_categorization_items
                    SET status = 'observed',
                        proposal_json = NULL,
                        model_metadata_json = NULL,
                        decision_json = NULL,
                        error_code = NULL,
                        updated_at = ?
                  WHERE event_id = ?
                    AND status IN ('ignored', 'attention', 'applied', 'failed')`,
              )
              .run(observedAt, existing.id);
            if (reset.changes !== 1) {
              throw new Error(
                'Transaction categorization revision could not be requeued',
              );
            }
            this.#database
              .prepare(
                `DELETE FROM transaction_categorization_provider_calls
                  WHERE event_id = ?`,
              )
              .run(existing.id);
            this.#enqueue(
              'classify-transaction',
              existing.id,
              {},
              `transaction-categorization:classify:${existing.id}${this.#revisionSuffix(existing.id)}`,
              observedAt,
            );
            requeued += 1;
          }
          this.#appendAudit(
            existing.id,
            'transaction-categorization.observation-refreshed',
            {
              previousFingerprint: existing.fingerprint,
              fingerprint,
              previousActualObservationFingerprint:
                previousObserver.actualObservationFingerprint,
              actualObservationFingerprint:
                observer.actualObservationFingerprint,
              previousCategoryStatus: previousObserver.currentCategoryStatus,
              categoryStatus: observer.currentCategoryStatus,
              requeued: shouldRequeue,
            },
            observedAt,
          );
          refreshed += 1;
          continue;
        }

        const eventId = randomUUID();
        this.#database
          .prepare(
            `INSERT INTO transaction_categorization_observations (
               id, transaction_id, imported_id, fingerprint,
               observer_json, observed_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            eventId,
            observer.transactionId,
            observer.importedId,
            fingerprint,
            observerJson,
            observedAt,
          );
        this.#database
          .prepare(
            `INSERT INTO transaction_categorization_items (
               event_id, status, created_at, updated_at
             ) VALUES (?, 'observed', ?, ?)`,
          )
          .run(eventId, observedAt, observedAt);
        this.#enqueue(
          'classify-transaction',
          eventId,
          {},
          `transaction-categorization:classify:${eventId}`,
          observedAt,
        );
        this.#appendAudit(
          eventId,
          'transaction-categorization.observed',
          {
            fingerprint,
            importedIdentityHash: createHash('sha256')
              .update(observer.importedId)
              .digest('hex'),
          },
          observedAt,
        );
        inserted += 1;
      }

      this.#database
        .prepare(
          `INSERT INTO transaction_categorization_scan_watermark (
             singleton, watermark, updated_at
           ) VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE
             SET watermark = excluded.watermark,
                 updated_at = excluded.updated_at`,
        )
        .run(watermark, observedAt);
      return {
        inserted,
        duplicates,
        refreshed,
        requeued,
        conflicts,
        watermark,
      };
    })();
  }

  getObservation(
    eventId: string,
  ): TransactionCategorizationObservedRecord | undefined {
    const row = this.#observationRow(eventId);
    return row === undefined ? undefined : toObservation(row);
  }

  getByImportedId(
    importedId: string,
  ): TransactionCategorizationObservedRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM transaction_categorization_observations
          WHERE imported_id = ?`,
      )
      .get(importedId) as ObservationRow | undefined;
    return row === undefined ? undefined : toObservation(row);
  }

  getItem(eventId: string): TransactionCategorizationItem | undefined {
    const row = this.#itemRow(eventId);
    return row === undefined ? undefined : toItem(row);
  }

  getClarificationResolution(
    referenceIdInput: string,
  ): TransactionCategorizationClarificationResolution | undefined {
    const referenceId = hashSchema.parse(referenceIdInput);
    const row = this.#database
      .prepare(
        `SELECT reference_id, event_id, room_token, category_alias,
                actor_id, inbound_message_id, parent_bot_id,
                parent_message_id, resolved_at
           FROM transaction_categorization_clarification_resolutions
          WHERE reference_id = ?`,
      )
      .get(referenceId) as ClarificationResolutionRow | undefined;
    return row === undefined ? undefined : toClarificationResolution(row);
  }

  getClarificationDirection(
    referenceIdInput: string,
  ):
    | TransactionCategorizationObservedRecord['observation']['direction']
    | undefined {
    const referenceId = hashSchema.parse(referenceIdInput);
    const row = this.#database
      .prepare(
        `SELECT event_id
           FROM transaction_categorization_clarifications
          WHERE reference_id = ?`,
      )
      .get(referenceId) as { event_id: string } | undefined;
    return row === undefined
      ? undefined
      : this.#requireObservation(row.event_id).observation.direction;
  }

  latestOpenClarification(
    roomTokenInput: string,
    deliveredAtOrBeforeInput?: string,
  ): OpenTransactionCategorizationClarification | undefined {
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
                observation.observer_json
           FROM transaction_categorization_clarifications AS clarification
           JOIN transaction_categorization_clarification_deliveries AS delivery
             ON delivery.reference_id = clarification.reference_id
           JOIN transaction_categorization_observations AS observation
             ON observation.id = clarification.event_id
           JOIN transaction_categorization_items AS item
             ON item.event_id = clarification.event_id
           LEFT JOIN transaction_categorization_clarification_resolutions AS resolution
             ON resolution.reference_id = clarification.reference_id
          WHERE clarification.room_token = ?
            AND (? IS NULL OR delivery.delivered_at <= ?)
            AND resolution.reference_id IS NULL
            AND item.status = 'attention'
            AND clarification.reason <> 'apply-conflict'
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
          observer_json: string;
        }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    const observation = parsedObserver(json(row.observer_json)).observation;
    const payee = observation.payeeName ?? 'an unknown payee';
    return {
      referenceId: row.reference_id,
      eventId: row.event_id,
      roomToken: row.room_token,
      botActorId: row.bot_actor_id,
      parentMessageId: row.message_id,
      deliveredAt: row.delivered_at,
      summary: `Transaction from ${payee} on ${observation.date}`,
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
  }): TransactionCategorizationItem {
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
          `SELECT reference_id, event_id, room_token, reason,
                  outbox_idempotency_key, created_at
             FROM transaction_categorization_clarifications
            WHERE reference_id = ?`,
        )
        .get(referenceId) as ClarificationRequestRow | undefined;
      if (request === undefined) {
        throw new Error('Unknown transaction categorization clarification');
      }
      if (request.room_token !== roomToken) {
        throw new Error('Transaction clarification room does not match');
      }
      if (request.reason === 'apply-conflict') {
        throw new Error(
          'Apply conflicts cannot be resolved as category clarifications',
        );
      }
      const delivered = this.#database
        .prepare(
          `SELECT 1
             FROM transaction_categorization_outbox
            WHERE idempotency_key = ?
              AND kind = 'send-transaction-categorization-clarification'
              AND event_id = ?
              AND state = 'completed'`,
        )
        .get(request.outbox_idempotency_key, request.event_id);
      if (delivered === undefined) {
        throw new Error('Transaction clarification was not delivered');
      }
      const delivery = this.#database
        .prepare(
          `SELECT room_token, bot_actor_id, message_id
             FROM transaction_categorization_clarification_deliveries
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
          'Transaction clarification reply parent does not match delivery',
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
            'Transaction clarification was already resolved differently',
          );
        }
        return toItem(this.#requireItem(request.event_id));
      }

      const item = this.#requireItem(request.event_id);
      if (item.status !== 'attention' || item.decision_json === null) {
        throw new Error(
          'Transaction categorization is not awaiting clarification',
        );
      }
      const decision = parsedDecision(json(item.decision_json));
      if (
        decision.disposition !== 'clarify' ||
        decision.reason === 'apply-conflict'
      ) {
        throw new Error('Transaction attention state is not reclassifiable');
      }
      const observation = this.#requireObservation(request.event_id);
      const updateRequest = createTransactionCategoryUpdateRequest(
        observation,
        categoryAlias,
      );

      this.#database
        .prepare(
          `INSERT INTO transaction_categorization_clarification_resolutions (
             reference_id, event_id, room_token, category_alias, actor_id,
             inbound_message_id, parent_bot_id, parent_message_id, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          resolvedAt,
        );
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_items
              SET status = 'ready', updated_at = ?
            WHERE event_id = ? AND status = 'attention'`,
        )
        .run(resolvedAt, request.event_id);
      if (updated.changes !== 1) {
        throw new Error(
          'Transaction clarification resolution could not be persisted',
        );
      }
      this.#enqueue(
        'apply-transaction-category',
        request.event_id,
        updateRequest,
        `transaction-categorization:apply:${request.event_id}${this.#revisionSuffix(request.event_id)}`,
        resolvedAt,
      );
      this.#appendAudit(
        request.event_id,
        'transaction-categorization.clarification-resolved',
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
      this.#claimedJob(jobId, eventId, 'classify-transaction');
      const item = this.#requireItem(eventId);
      if (item.status !== 'observed') {
        throw new Error('Transaction is not awaiting model classification');
      }
      this.#database
        .prepare(
          `INSERT INTO transaction_categorization_provider_calls (
             event_id, started_at
           ) VALUES (?, ?)`,
        )
        .run(eventId, now);
      this.#appendAudit(
        eventId,
        'transaction-categorization.provider-call-started',
        {},
        now,
      );
    })();
  }

  recordProposal(
    jobId: number,
    eventId: string,
    untrustedProposal: TransactionCategoryProposal,
    untrustedMetadata: XaiStructuredRunMetadata,
    nowInput: string,
  ): void {
    const proposal = transactionCategoryProposalSchema.parse(untrustedProposal);
    const metadata = parsedMetadata(untrustedMetadata);
    const proposalJson = serialized(
      proposal,
      'transaction category proposal',
      MAX_PROPOSAL_BYTES,
    );
    const metadataJson = serialized(
      metadata,
      'transaction categorization model metadata',
      MAX_METADATA_BYTES,
    );
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'classify-transaction');
      const providerCall = this.#database
        .prepare(
          `SELECT 1 FROM transaction_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .get(eventId);
      if (providerCall === undefined) {
        throw new Error('Transaction provider call marker is missing');
      }
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_items
              SET status = 'planned',
                  proposal_json = ?,
                  model_metadata_json = ?,
                  updated_at = ?
            WHERE event_id = ?
              AND status = 'observed'
              AND proposal_json IS NULL`,
        )
        .run(proposalJson, metadataJson, now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Transaction model proposal was already persisted');
      }
      this.#appendAudit(
        eventId,
        'transaction-categorization.model-proposal-persisted',
        {
          disposition: proposal.disposition,
          zeroDataRetention: metadata.zeroDataRetention,
          costInUsdTicks: metadata.usage.costInUsdTicks,
        },
        now,
      );
      this.#database
        .prepare(
          `DELETE FROM transaction_categorization_provider_calls
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
      this.#claimedJob(jobId, eventId, 'classify-transaction');
      const deleted = this.#database
        .prepare(
          `DELETE FROM transaction_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .run(eventId);
      if (deleted.changes !== 1) {
        throw new Error('Transaction provider call marker is not active');
      }
      this.#retryClaimedJob(jobId, errorCode, availableAt);
      this.#appendAudit(
        eventId,
        'transaction-categorization.provider-call-not-sent',
        { retryAt: availableAt },
        now,
      );
    })();
  }

  recordIgnored(
    jobId: number,
    eventId: string,
    reasonInput: TransactionCategorizationIgnoreReason,
    nowInput: string,
  ): TransactionCategorizationItem {
    const decision = decisionSchema.parse({
      disposition: 'ignore',
      reason: reasonInput,
    });
    return this.#recordDecision(
      jobId,
      eventId,
      'ignored',
      decision,
      undefined,
      nowInput,
    );
  }

  recordReady(
    jobId: number,
    eventId: string,
    categoryAliasInput: string,
    sourceInput: TransactionCategorizationDecisionSource,
    nowInput: string,
  ): TransactionCategorizationItem {
    const decision = decisionSchema.parse({
      disposition: 'apply',
      categoryAlias: categoryAliasInput,
      source: sourceInput,
    });
    if (decision.disposition !== 'apply') {
      throw new TypeError('Ready categorization requires an apply decision');
    }
    const observation = this.#requireObservation(eventId);
    const payload = createTransactionCategoryUpdateRequest(
      observation,
      decision.categoryAlias,
    );
    return this.#recordDecision(
      jobId,
      eventId,
      'ready',
      decision,
      {
        kind: 'apply-transaction-category',
        payload,
        idempotencyKey: `transaction-categorization:apply:${eventId}${this.#revisionSuffix(eventId)}`,
      },
      nowInput,
    );
  }

  recordAttentionAndEnqueueClarification(
    jobId: number,
    eventId: string,
    reasonInput: TransactionCategorizationAttentionReason,
    questionInput: string,
    roomTokenInput: string,
    nowInput: string,
  ): TransactionCategorizationItem {
    const question = z.string().min(1).max(500).parse(questionInput);
    const decision = decisionSchema.parse({
      disposition: 'clarify',
      reason: reasonInput,
      question,
    });
    const roomToken = identifierSchema.parse(roomTokenInput);
    const revisionSuffix = this.#revisionSuffix(eventId);
    const payload = talkPayloadSchema.parse({
      roomToken,
      message: question,
      referenceId: createTransactionCategorizationReferenceId(
        eventId,
        `clarification:${reasonInput}${revisionSuffix}`,
      ),
      silent: false,
    });
    return this.#recordDecision(
      jobId,
      eventId,
      'attention',
      decision,
      {
        kind: 'send-transaction-categorization-clarification',
        payload,
        idempotencyKey: `transaction-categorization:clarification:${eventId}${revisionSuffix}`,
      },
      nowInput,
    );
  }

  recordApplied(
    jobId: number,
    eventId: string,
    nowInput: string,
  ): TransactionCategorizationItem {
    const now = timestampSchema.parse(nowInput);
    return this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'apply-transaction-category');
      const item = this.#requireItem(eventId);
      if (item.status !== 'ready') {
        throw new Error('Transaction category is not ready to apply');
      }
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_items
              SET status = 'applied', updated_at = ?
            WHERE event_id = ? AND status = 'ready'`,
        )
        .run(now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Transaction category could not be marked applied');
      }
      this.#completeClaimedJob(jobId, now);
      this.#appendAudit(eventId, 'transaction-categorization.applied', {}, now);
      return toItem(this.#requireItem(eventId));
    })();
  }

  recordReceiptOwned(
    jobId: number,
    eventId: string,
    nowInput: string,
  ): TransactionCategorizationItem {
    const now = timestampSchema.parse(nowInput);
    return this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'apply-transaction-category');
      const item = this.#requireItem(eventId);
      if (item.status !== 'ready') {
        throw new Error('Transaction category is not ready to defer');
      }
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_items
              SET status = 'ignored', updated_at = ?
            WHERE event_id = ? AND status = 'ready'`,
        )
        .run(now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Receipt-owned transaction could not be deferred');
      }
      this.#completeClaimedJob(jobId, now);
      this.#appendAudit(
        eventId,
        'transaction-categorization.receipt-owned',
        {},
        now,
      );
      return toItem(this.#requireItem(eventId));
    })();
  }

  recordApplyConflictAndEnqueueClarification(
    jobId: number,
    eventId: string,
    questionInput: string,
    roomTokenInput: string,
    nowInput: string,
  ): TransactionCategorizationItem {
    const question = z.string().min(1).max(500).parse(questionInput);
    const roomToken = identifierSchema.parse(roomTokenInput);
    const now = timestampSchema.parse(nowInput);
    return this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'apply-transaction-category');
      const item = this.#requireItem(eventId);
      if (item.status !== 'ready') {
        throw new Error('Transaction category is not ready to reconcile');
      }
      const previous = item.decision_json;
      if (previous === null) {
        throw new Error('Ready transaction has no decision');
      }
      const priorDecision = parsedDecision(json(previous));
      const attemptedCategoryAlias =
        priorDecision.disposition === 'apply'
          ? priorDecision.categoryAlias
          : this.#resolvedCategoryAlias(eventId);
      if (attemptedCategoryAlias === undefined) {
        throw new Error('Ready transaction has no effective apply decision');
      }
      const conflictDecision = decisionSchema.parse({
        disposition: 'clarify',
        reason: 'apply-conflict',
        question,
      });
      const revisionSuffix = this.#revisionSuffix(eventId);
      /*
       * The original apply decision remains immutable. Conflict context is
       * stored in the audit and clarification payload.
       */
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_items
              SET status = 'attention', updated_at = ?
            WHERE event_id = ? AND status = 'ready'`,
        )
        .run(now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Transaction apply conflict could not be persisted');
      }
      this.#completeClaimedJob(jobId, now);
      const payload = talkPayloadSchema.parse({
        roomToken,
        message: question,
        referenceId: createTransactionCategorizationReferenceId(
          eventId,
          `clarification:apply-conflict${revisionSuffix}`,
        ),
        silent: false,
      });
      this.#enqueue(
        'send-transaction-categorization-clarification',
        eventId,
        payload,
        `transaction-categorization:apply-conflict:${eventId}${revisionSuffix}`,
        now,
      );
      this.#recordClarificationRequest(
        eventId,
        payload,
        'apply-conflict',
        `transaction-categorization:apply-conflict:${eventId}${revisionSuffix}`,
        now,
      );
      this.#appendAudit(
        eventId,
        'transaction-categorization.apply-conflict',
        {
          attemptedCategoryAlias,
          clarification: conflictDecision,
        },
        now,
      );
      return toItem(this.#requireItem(eventId));
    })();
  }

  claimNextJob(
    nowInput: string,
    leaseDurationSeconds = 300,
  ): TransactionCategorizationJob | undefined {
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
             FROM transaction_categorization_outbox
            WHERE state = 'pending' AND available_at <= ?
            ORDER BY
              CASE kind
                WHEN 'classify-transaction' THEN 0
                WHEN 'apply-transaction-category' THEN 1
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
          `UPDATE transaction_categorization_outbox
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
        payload: json(row.payload_json),
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
    const job = this.#database
      .prepare(
        `SELECT kind, event_id
           FROM transaction_categorization_outbox
          WHERE id = ? AND state = 'processing'`,
      )
      .get(jobId) as
      { kind: TransactionCategorizationJobKind; event_id: string } | undefined;
    if (job?.kind === 'classify-transaction') {
      const providerCall = this.#database
        .prepare(
          `SELECT 1
             FROM transaction_categorization_provider_calls
            WHERE event_id = ?`,
        )
        .get(job.event_id);
      if (providerCall !== undefined) {
        throw new Error(
          'Cannot retry classification while a provider call is uncertain',
        );
      }
    }
    this.#retryClaimedJob(jobId, errorCode, availableAt);
  }

  failClaimedJob(
    jobId: number,
    eventId: string,
    errorCodeInput: string,
    nowInput: string,
  ): void {
    const errorCode = errorCodeSchema.parse(errorCodeInput);
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId);
      this.#failClaimedJob(jobId, eventId, errorCode, now);
    })();
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
        'send-transaction-categorization-clarification',
      );
      const payload = talkPayloadSchema.parse(json(job.payload_json));
      if (payload.referenceId !== referenceId) {
        throw new Error('Categorization Talk reference does not match');
      }
      if (payload.roomToken !== roomToken) {
        throw new Error('Categorization Talk room does not match');
      }
      this.#database
        .prepare(
          `INSERT INTO transaction_categorization_clarification_deliveries (
             reference_id, room_token, bot_actor_id, message_id, delivered_at
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(reference_id) DO NOTHING`,
        )
        .run(referenceId, roomToken, botActorId, messageId, now);
      const persisted = this.#database
        .prepare(
          `SELECT room_token, bot_actor_id, message_id
             FROM transaction_categorization_clarification_deliveries
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
        throw new Error('Categorization Talk delivery identity changed');
      }
      this.#completeClaimedJob(jobId, now);
      this.#appendAudit(
        eventId,
        'transaction-categorization.clarification-delivered',
        { referenceId },
        now,
      );
    })();
  }

  deadLetterTalkJob(
    jobId: number,
    eventId: string,
    errorCodeInput: string,
    nowInput: string,
  ): void {
    const errorCode = errorCodeSchema.parse(errorCodeInput);
    const now = timestampSchema.parse(nowInput);
    this.#database.transaction(() => {
      this.#claimedJob(
        jobId,
        eventId,
        'send-transaction-categorization-clarification',
      );
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_outbox
              SET state = 'failed',
                  locked_at = NULL,
                  lease_expires_at = NULL,
                  last_error = ?
            WHERE id = ? AND state = 'processing'`,
        )
        .run(errorCode, jobId);
      if (updated.changes !== 1) {
        throw new Error('Categorization Talk job is not claimed');
      }
      this.#appendAudit(
        eventId,
        'transaction-categorization.clarification-dead-lettered',
        { errorCode },
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
             FROM transaction_categorization_provider_calls AS provider_call
             JOIN transaction_categorization_outbox AS outbox
               ON outbox.event_id = provider_call.event_id
              AND outbox.kind = 'classify-transaction'
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
        this.#appendAudit(
          call.event_id,
          'transaction-categorization.provider-outcome-unknown',
          {},
          now,
        );
        recovered += 1;
      }

      const interrupted = this.#database
        .prepare(
          `SELECT id, event_id, kind
             FROM transaction_categorization_outbox
            WHERE state = 'processing'
              AND lease_expires_at <= ?
            ORDER BY id`,
        )
        .all(now) as Array<{
        id: number;
        event_id: string;
        kind: TransactionCategorizationJobKind;
      }>;
      for (const job of interrupted) {
        const updated = this.#database
          .prepare(
            `UPDATE transaction_categorization_outbox
                SET state = 'pending',
                    available_at = ?,
                    locked_at = NULL,
                    lease_expires_at = NULL,
                    last_error = 'lease-expired'
              WHERE id = ? AND state = 'processing'`,
          )
          .run(now, job.id);
        if (updated.changes !== 1) {
          throw new Error('Expired categorization job changed concurrently');
        }
        this.#appendAudit(
          job.event_id,
          'transaction-categorization.job-recovered',
          { kind: job.kind },
          now,
        );
        recovered += 1;
      }
      return recovered;
    })();
  }

  listAudit(eventId: string): TransactionCategorizationAuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT id, event_id, action, detail_json, occurred_at
           FROM transaction_categorization_audit_events
          WHERE event_id = ?
          ORDER BY id`,
      )
      .all(eventId) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      action: row.action,
      detail: json(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }

  #recordDecision(
    jobId: number,
    eventId: string,
    targetStatus: 'ignored' | 'attention' | 'ready',
    decision: TransactionCategorizationDecision,
    outbox:
      | {
          kind: Exclude<
            TransactionCategorizationJobKind,
            'classify-transaction'
          >;
          payload: unknown;
          idempotencyKey: string;
        }
      | undefined,
    nowInput: string,
  ): TransactionCategorizationItem {
    const now = timestampSchema.parse(nowInput);
    const decisionJson = serialized(
      decision,
      'transaction categorization decision',
      MAX_DECISION_BYTES,
    );
    return this.#database.transaction(() => {
      this.#claimedJob(jobId, eventId, 'classify-transaction');
      const item = this.#requireItem(eventId);
      if (item.status !== 'observed' && item.status !== 'planned') {
        throw new Error('Transaction is not awaiting a decision');
      }
      const updated = this.#database
        .prepare(
          `UPDATE transaction_categorization_items
              SET status = ?, decision_json = ?, updated_at = ?
            WHERE event_id = ?
              AND status IN ('observed', 'planned')
              AND decision_json IS NULL`,
        )
        .run(targetStatus, decisionJson, now, eventId);
      if (updated.changes !== 1) {
        throw new Error('Transaction categorization decision already exists');
      }
      this.#completeClaimedJob(jobId, now);
      if (outbox !== undefined) {
        this.#enqueue(
          outbox.kind,
          eventId,
          outbox.payload,
          outbox.idempotencyKey,
          now,
        );
        if (
          outbox.kind === 'send-transaction-categorization-clarification' &&
          decision.disposition === 'clarify'
        ) {
          this.#recordClarificationRequest(
            eventId,
            talkPayloadSchema.parse(outbox.payload),
            decision.reason,
            outbox.idempotencyKey,
            now,
          );
        }
      }
      this.#appendAudit(
        eventId,
        `transaction-categorization.${targetStatus}`,
        decision,
        now,
      );
      return toItem(this.#requireItem(eventId));
    })();
  }

  #failClaimedJob(
    jobId: number,
    eventId: string,
    errorCode: string,
    now: string,
  ): void {
    const job = this.#claimedJob(jobId, eventId);
    if (job.kind === 'send-transaction-categorization-clarification') {
      throw new Error('Talk jobs must be dead-lettered separately');
    }
    const item = this.#requireItem(eventId);
    if (
      item.status === 'ignored' ||
      item.status === 'attention' ||
      item.status === 'applied' ||
      item.status === 'failed'
    ) {
      throw new Error('Transaction categorization is already terminal');
    }
    const updatedItem = this.#database
      .prepare(
        `UPDATE transaction_categorization_items
            SET status = 'failed', error_code = ?, updated_at = ?
          WHERE event_id = ?
            AND status IN ('observed', 'planned', 'ready')`,
      )
      .run(errorCode, now, eventId);
    const updatedJob = this.#database
      .prepare(
        `UPDATE transaction_categorization_outbox
            SET state = 'failed',
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(errorCode, jobId);
    if (updatedItem.changes !== 1 || updatedJob.changes !== 1) {
      throw new Error('Categorization job could not fail atomically');
    }
    this.#database
      .prepare(
        `DELETE FROM transaction_categorization_provider_calls
          WHERE event_id = ?`,
      )
      .run(eventId);
    this.#appendAudit(
      eventId,
      'transaction-categorization.failed',
      { errorCode },
      now,
    );
  }

  #completeClaimedJob(jobId: number, now: string): void {
    const updated = this.#database
      .prepare(
        `UPDATE transaction_categorization_outbox
            SET state = 'completed',
                completed_at = ?,
                locked_at = NULL,
                lease_expires_at = NULL
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
    if (updated.changes !== 1) {
      throw new Error('Categorization job is not claimed');
    }
  }

  #retryClaimedJob(
    jobId: number,
    errorCode: string,
    availableAt: string,
  ): void {
    const updated = this.#database
      .prepare(
        `UPDATE transaction_categorization_outbox
            SET state = 'pending',
                available_at = ?,
                locked_at = NULL,
                lease_expires_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(availableAt, errorCode, jobId);
    if (updated.changes !== 1) {
      throw new Error('Categorization job is not claimed');
    }
  }

  #claimedJob(
    jobId: number,
    eventId: string,
    expectedKind?: TransactionCategorizationJobKind,
  ): JobRow {
    const row = this.#database
      .prepare(
        `SELECT id, idempotency_key, kind, event_id, payload_json,
                state, attempt_count, lease_expires_at
           FROM transaction_categorization_outbox
          WHERE id = ? AND event_id = ? AND state = 'processing'
            ${expectedKind === undefined ? '' : 'AND kind = ?'}`,
      )
      .get(
        jobId,
        eventId,
        ...(expectedKind === undefined ? [] : [expectedKind]),
      ) as JobRow | undefined;
    if (row === undefined) {
      throw new Error('Categorization job is not claimed');
    }
    return row;
  }

  #recordClarificationRequest(
    eventId: string,
    payload: TransactionCategorizationTalkPayload,
    reason: TransactionCategorizationAttentionReason,
    outboxIdempotencyKey: string,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO transaction_categorization_clarifications (
           reference_id, event_id, room_token, reason,
           outbox_idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        payload.referenceId,
        eventId,
        payload.roomToken,
        reason,
        outboxIdempotencyKey,
        createdAt,
      );
  }

  #resolvedCategoryAlias(eventId: string): string | undefined {
    const row = this.#database
      .prepare(
        `SELECT category_alias
           FROM transaction_categorization_clarification_resolutions
          WHERE event_id = ?`,
      )
      .get(eventId) as { category_alias: string } | undefined;
    return row?.category_alias;
  }

  #enqueue(
    kind: TransactionCategorizationJobKind,
    eventId: string,
    payload: unknown,
    idempotencyKey: string,
    now: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO transaction_categorization_outbox (
           idempotency_key, kind, event_id, payload_json, state,
           available_at, created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        idempotencyKey,
        kind,
        eventId,
        serialized(payload, 'categorization outbox payload', MAX_OUTBOX_BYTES),
        now,
        now,
      );
  }

  #revisionSuffix(eventId: string): string {
    const row = this.#database
      .prepare(
        `SELECT id
           FROM transaction_categorization_observation_revisions
          WHERE event_id = ?
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get(eventId) as { id: number } | undefined;
    return row === undefined ? '' : `:revision:${String(row.id)}`;
  }

  #observationRow(eventId: string): ObservationRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM transaction_categorization_observations
          WHERE id = ?`,
      )
      .get(eventId) as ObservationRow | undefined;
  }

  #requireObservation(
    eventId: string,
  ): TransactionCategorizationObservedRecord {
    const row = this.#observationRow(eventId);
    if (row === undefined) {
      throw new Error('Unknown transaction categorization observation');
    }
    return toObservation(row);
  }

  #itemRow(eventId: string): ItemRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM transaction_categorization_items
          WHERE event_id = ?`,
      )
      .get(eventId) as ItemRow | undefined;
  }

  #requireItem(eventId: string): ItemRow {
    const row = this.#itemRow(eventId);
    if (row === undefined) {
      throw new Error('Unknown transaction categorization item');
    }
    return row;
  }

  #appendAudit(
    eventId: string,
    action: string,
    detail: unknown,
    occurredAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO transaction_categorization_audit_events (
           event_id, action, detail_json, occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        eventId,
        action,
        serialized(detail, 'categorization audit detail', 16 * 1_024),
        occurredAt,
      );
  }
}
