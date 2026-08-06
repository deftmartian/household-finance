import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  assertActualTransactionObservation,
  assertActualUpdateUndoIntent,
  assertApprovedActualTransactionEdit,
  type ActualApprovedTransactionEdit,
  type ActualTransactionObservationV1,
  type ActualUpdateUndoIntentV1,
} from '../actual-update/domain.js';
import type {
  UndoExistingActualTransactionResult,
  UpdateExistingActualTransactionRequest,
  UpdateExistingActualTransactionResult,
} from '../actual-update/writer.js';

const identifierSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value === value.trim() &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }),
    { message: 'Identifier contains whitespace or control characters' },
  );
const aliasSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const targetRefSchema = z.string().regex(/^actual-target\/[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const textSchema = z
  .string()
  .max(32_000)
  .refine((value) => !value.includes('\0'));
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, 'Timestamp must be a canonical ISO-8601 UTC instant');

const publicEditablePayeeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preserve') }),
  z.strictObject({
    kind: z.literal('set'),
    payeeAlias: aliasSchema.nullable(),
  }),
]);
const publicEditableNotesSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preserve') }),
  z.strictObject({ kind: z.literal('set'), value: textSchema.nullable() }),
]);
const publicCategorizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('single'),
    categoryAlias: aliasSchema,
  }),
  z.strictObject({
    kind: z.literal('split'),
    splits: z
      .array(
        z.strictObject({
          categoryAlias: aliasSchema,
          amountMinorUnits: z
            .number()
            .int()
            .safe()
            .refine((value) => value !== 0),
          notes: textSchema.nullable(),
        }),
      )
      .min(2)
      .max(100),
  }),
]);
const publicReviewPayeeSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value === value.normalize('NFC').trim(), {
    message: 'Review payee name must be normalized and trimmed',
  });
const publicReviewSummarySchema = z.strictObject({
  date: z.iso.date(),
  amountMinorUnits: z
    .number()
    .int()
    .safe()
    .refine((value) => value !== 0),
  payeeName: publicReviewPayeeSchema.nullable(),
});

export const actualUpdatePublicProposalSchema = z.strictObject({
  schemaVersion: z.literal('actual-update-public-proposal.v2'),
  intentId: identifierSchema,
  idempotencyKey: identifierSchema,
  targetRef: targetRefSchema,
  accountAlias: aliasSchema,
  summary: publicReviewSummarySchema,
  payee: publicEditablePayeeSchema,
  notes: publicEditableNotesSchema,
  categorization: publicCategorizationSchema,
  sourceId: identifierSchema,
  auditId: identifierSchema,
  createdAt: canonicalInstantSchema,
});

export type ActualUpdatePublicProposalV2 = z.infer<
  typeof actualUpdatePublicProposalSchema
>;

export interface ActualUpdateInternalEnvelopePayloadV2 {
  readonly schemaVersion: 'actual-update-internal-payload.v2';
  readonly publicProposal: ActualUpdatePublicProposalV2;
  readonly writerRequest: UpdateExistingActualTransactionRequest;
}

export interface SealedActualUpdateIntentEnvelopeV2 {
  readonly schemaVersion: 'actual-update-envelope.v2';
  readonly keyId: string;
  readonly payload: ActualUpdateInternalEnvelopePayloadV2;
  readonly signatureSha256: string;
}

export type ActualUpdateOperationalStatus =
  | 'awaiting-approval'
  | 'rejected'
  | 'queued'
  | 'claimed'
  | 'applying'
  | 'applied'
  | 'ambiguous'
  | 'failed'
  | 'undo-queued'
  | 'undo-claimed'
  | 'undo-applying'
  | 'undone'
  | 'undo-ambiguous'
  | 'undo-failed';

const actualUpdateOperationalStatuses = new Set<ActualUpdateOperationalStatus>([
  'awaiting-approval',
  'rejected',
  'queued',
  'claimed',
  'applying',
  'applied',
  'ambiguous',
  'failed',
  'undo-queued',
  'undo-claimed',
  'undo-applying',
  'undone',
  'undo-ambiguous',
  'undo-failed',
]);

const targetLockingOperationalStatuses = [
  'awaiting-approval',
  'queued',
  'claimed',
  'applying',
  'ambiguous',
  'undo-queued',
  'undo-claimed',
  'undo-applying',
  'undo-ambiguous',
] as const satisfies readonly ActualUpdateOperationalStatus[];

const laterTargetNonEffectStatuses = [
  'rejected',
  'failed',
  'undone',
] as const satisfies readonly ActualUpdateOperationalStatus[];

export interface ActualUpdateApprovalRecord {
  readonly decision: 'approved' | 'rejected';
  readonly decisionId: string;
  readonly actorId: string;
  readonly reasonCode: string | null;
  readonly decidedAt: string;
}

/**
 * This is the only intent view intended for the finance-bot/Talk layer.
 * It deliberately contains aliases and one opaque target reference, never
 * Actual transaction, imported, category, payee, or account IDs.
 */
export interface ActualUpdatePublicIntent {
  readonly proposal: ActualUpdatePublicProposalV2;
  readonly status: ActualUpdateOperationalStatus;
  readonly approval: ActualUpdateApprovalRecord | null;
  readonly applyAttemptCount: number;
  readonly undoAttemptCount: number;
  readonly lastErrorCode: string | null;
  readonly applyOutcome: {
    readonly status: UpdateExistingActualTransactionResult['status'];
    readonly completedAt: string;
  } | null;
  readonly undoOutcome: {
    readonly status: UndoExistingActualTransactionResult['status'];
    readonly completedAt: string;
  } | null;
  readonly updatedAt: string;
}

export interface ActualUpdateApprovalInput {
  readonly intentId: string;
  readonly decisionId: string;
  readonly actorId: string;
  readonly approvedAt: string;
}

export interface ActualUpdateRejectionInput {
  readonly intentId: string;
  readonly decisionId: string;
  readonly actorId: string;
  readonly reasonCode: string;
  readonly rejectedAt: string;
}

export type ActualUpdateClaimMode = 'apply' | 'reconcile';
export type ActualUpdateUndoClaimMode = 'undo' | 'undo-reconcile';

/**
 * Internal worker data. Do not serialize this into bot replies: it includes
 * the exact Actual identity selected by deterministic matching.
 */
export interface ActualUpdateApplyClaim {
  readonly intentId: string;
  readonly targetRef: string;
  readonly mode: ActualUpdateClaimMode;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
  readonly targetTransactionId: string;
  readonly targetImportedId: string;
  readonly expectedFingerprint: string;
  readonly envelope: SealedActualUpdateIntentEnvelopeV2;
}

/**
 * Internal worker data. The undo intent is produced only by the safe writer
 * after exact readback and is never accepted from a model-facing payload.
 */
export interface ActualUpdateUndoClaim {
  readonly intentId: string;
  readonly targetRef: string;
  readonly mode: ActualUpdateUndoClaimMode;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
  readonly targetTransactionId: string;
  readonly targetImportedId: string;
  readonly expectedFingerprint: string;
  readonly envelope: SealedActualUpdateIntentEnvelopeV2;
  readonly undoIntent: ActualUpdateUndoIntentV1;
}

export interface ActualUpdateUndoRequestInput {
  readonly intentId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly requestedAt: string;
}

export interface ActualUpdateStoreAuditEvent {
  readonly id: number;
  readonly intentId: string;
  readonly action: string;
  readonly detail: unknown;
  readonly occurredAt: string;
}

export interface ActualUpdateLeaseRecoveryResult {
  readonly requeuedApply: number;
  readonly ambiguousApply: number;
  readonly requeuedUndo: number;
  readonly ambiguousUndo: number;
}

export interface ActualUpdateIntentStoreOptions {
  readonly leaseDurationMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

export class ActualUpdateStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualUpdateStoreConflictError';
  }
}

export class ActualUpdateLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualUpdateLeaseError';
  }
}

interface IntentRow {
  intent_id: string;
  idempotency_key: string;
  target_ref: string;
  account_alias: string;
  source_id: string;
  audit_id: string;
  target_transaction_id: string;
  target_imported_id: string;
  expected_fingerprint: string;
  public_json: string;
  envelope_json: string;
  envelope_sha256: string;
  created_at: string;
}

interface StateRow {
  intent_id: string;
  status: ActualUpdateOperationalStatus;
  apply_attempt_count: number;
  undo_attempt_count: number;
  available_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  claim_mode: ActualUpdateClaimMode | ActualUpdateUndoClaimMode | null;
  last_error_code: string | null;
  updated_at: string;
}

interface DecisionRow {
  intent_id: string;
  decision_id: string;
  decision: 'approved' | 'rejected';
  actor_id: string;
  reason_code: string | null;
  decided_at: string;
}

interface ApplyOutcomeRow {
  intent_id: string;
  result_json: string;
  undo_intent_json: string | null;
  completed_at: string;
}

interface UndoOutcomeRow {
  intent_id: string;
  result_json: string;
  completed_at: string;
}

interface AuditRow {
  id: number;
  intent_id: string;
  action: string;
  detail_json: string;
  occurred_at: string;
}

const actualUpdateStoreSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS actual_update_intents (
    intent_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    target_ref TEXT NOT NULL,
    account_alias TEXT NOT NULL,
    source_id TEXT NOT NULL,
    audit_id TEXT NOT NULL,
    target_transaction_id TEXT NOT NULL,
    target_imported_id TEXT NOT NULL,
    expected_fingerprint TEXT NOT NULL,
    public_json TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    envelope_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_update_intents_no_update
  BEFORE UPDATE ON actual_update_intents
  BEGIN
    SELECT RAISE(ABORT, 'actual update intents are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_update_intents_no_delete
  BEFORE DELETE ON actual_update_intents
  BEGIN
    SELECT RAISE(ABORT, 'actual update intents are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_update_decisions (
    intent_id TEXT PRIMARY KEY REFERENCES actual_update_intents(intent_id),
    decision_id TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    actor_id TEXT NOT NULL,
    reason_code TEXT,
    decided_at TEXT NOT NULL,
    CHECK (
      (decision = 'approved' AND reason_code IS NULL)
      OR
      (decision = 'rejected' AND reason_code IS NOT NULL)
    )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_update_decisions_no_update
  BEFORE UPDATE ON actual_update_decisions
  BEGIN
    SELECT RAISE(ABORT, 'actual update decisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_update_decisions_no_delete
  BEFORE DELETE ON actual_update_decisions
  BEGIN
    SELECT RAISE(ABORT, 'actual update decisions are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_update_state (
    intent_id TEXT PRIMARY KEY REFERENCES actual_update_intents(intent_id),
    status TEXT NOT NULL CHECK (
      status IN (
        'awaiting-approval', 'rejected', 'queued', 'claimed', 'applying',
        'applied', 'ambiguous', 'failed', 'undo-queued', 'undo-claimed',
        'undo-applying', 'undone', 'undo-ambiguous', 'undo-failed'
      )
    ),
    apply_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (apply_attempt_count >= 0),
    undo_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (undo_attempt_count >= 0),
    available_at TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    claim_mode TEXT CHECK (
      claim_mode IS NULL
      OR claim_mode IN ('apply', 'reconcile', 'undo', 'undo-reconcile')
    ),
    last_error_code TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL AND claim_mode IS NULL)
      OR
      (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND claim_mode IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS actual_update_apply_outcomes (
    intent_id TEXT PRIMARY KEY REFERENCES actual_update_intents(intent_id),
    result_json TEXT NOT NULL,
    undo_intent_json TEXT,
    completed_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_update_apply_outcomes_no_update
  BEFORE UPDATE ON actual_update_apply_outcomes
  BEGIN
    SELECT RAISE(ABORT, 'actual update outcomes are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_update_apply_outcomes_no_delete
  BEFORE DELETE ON actual_update_apply_outcomes
  BEGIN
    SELECT RAISE(ABORT, 'actual update outcomes are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_update_undo_requests (
    intent_id TEXT PRIMARY KEY REFERENCES actual_update_intents(intent_id),
    request_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    requested_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_update_undo_requests_no_update
  BEFORE UPDATE ON actual_update_undo_requests
  BEGIN
    SELECT RAISE(ABORT, 'actual update undo requests are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_update_undo_requests_no_delete
  BEFORE DELETE ON actual_update_undo_requests
  BEGIN
    SELECT RAISE(ABORT, 'actual update undo requests are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_update_undo_outcomes (
    intent_id TEXT PRIMARY KEY REFERENCES actual_update_intents(intent_id),
    result_json TEXT NOT NULL,
    completed_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_update_undo_outcomes_no_update
  BEFORE UPDATE ON actual_update_undo_outcomes
  BEGIN
    SELECT RAISE(ABORT, 'actual update undo outcomes are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_update_undo_outcomes_no_delete
  BEFORE DELETE ON actual_update_undo_outcomes
  BEGIN
    SELECT RAISE(ABORT, 'actual update undo outcomes are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_update_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id TEXT NOT NULL REFERENCES actual_update_intents(intent_id),
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_update_audit_no_update
  BEFORE UPDATE ON actual_update_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'actual update audit events are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_update_audit_no_delete
  BEFORE DELETE ON actual_update_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'actual update audit events are append-only');
  END;

  CREATE INDEX IF NOT EXISTS actual_update_state_due
  ON actual_update_state(status, available_at, updated_at);
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

function normalizedInstant(value: string, name: string): string {
  const parsed = canonicalInstantSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${name} must be a canonical ISO-8601 UTC instant`);
  }
  return parsed.data;
}

function identifier(value: string, name: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed.data;
}

function errorCode(value: string): string {
  const parsed = safeErrorCodeSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError('errorCode must be a lowercase kebab-case token');
  }
  return parsed.data;
}

function envelopeDigest(envelopeJson: string): string {
  return createHash('sha256').update(envelopeJson, 'utf8').digest('hex');
}

function assertPublicMatchesWriter(
  proposal: ActualUpdatePublicProposalV2,
  edit: ActualApprovedTransactionEdit,
): void {
  if (
    proposal.payee.kind !== edit.payee.kind ||
    proposal.notes.kind !== edit.notes.kind ||
    proposal.categorization.kind !== edit.categorization.kind
  ) {
    throw new TypeError(
      'Public aliases do not describe the signed writer edit',
    );
  }
  if (
    proposal.payee.kind === 'set' &&
    edit.payee.kind === 'set' &&
    (proposal.payee.payeeAlias === null) !== (edit.payee.value === null)
  ) {
    throw new TypeError('Public payee alias does not match the writer edit');
  }
  if (
    proposal.notes.kind === 'set' &&
    edit.notes.kind === 'set' &&
    proposal.notes.value !== edit.notes.value
  ) {
    throw new TypeError('Public notes do not match the writer edit');
  }
  if (
    proposal.categorization.kind === 'split' &&
    edit.categorization.kind === 'split'
  ) {
    const internalSplits = edit.categorization.splits;
    if (
      proposal.categorization.splits.length !== internalSplits.length ||
      proposal.categorization.splits.some((line, index) => {
        const internal = internalSplits[index];
        return (
          internal === undefined ||
          line.amountMinorUnits !== internal.amountMinorUnits ||
          line.notes !== (internal.notes ?? null)
        );
      })
    ) {
      throw new TypeError('Public split aliases do not match the writer edit');
    }
  }
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => stringsIn(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap((item) => stringsIn(item));
  }
  return [];
}

function assertPublicContainsNoRawActualIds(
  proposal: ActualUpdatePublicProposalV2,
  request: UpdateExistingActualTransactionRequest,
): void {
  const observed = request.observed;
  const rawIds = new Set<string>([
    observed.transactionId,
    observed.accountId,
    ...(observed.importedId === null ? [] : [observed.importedId]),
    ...(observed.transferId === null ? [] : [observed.transferId]),
    ...(observed.parentId === null ? [] : [observed.parentId]),
    ...(observed.editable.payeeId === null ? [] : [observed.editable.payeeId]),
    ...(observed.editable.categorization.kind === 'single'
      ? observed.editable.categorization.categoryId === null
        ? []
        : [observed.editable.categorization.categoryId]
      : observed.editable.categorization.splits.flatMap((line) => [
          line.lineId,
          ...(line.categoryId === null ? [] : [line.categoryId]),
          ...(line.payeeId === null ? [] : [line.payeeId]),
        ])),
    ...(request.edit.payee.kind === 'set' && request.edit.payee.value !== null
      ? [request.edit.payee.value]
      : []),
    ...(request.edit.categorization.kind === 'single'
      ? [request.edit.categorization.categoryId]
      : request.edit.categorization.splits.map((line) => line.categoryId)),
  ]);
  const publicStrings = stringsIn(proposal);
  if (
    [...rawIds].some((rawId) =>
      publicStrings.some(
        (publicValue) =>
          publicValue === rawId ||
          (rawId.length >= 8 && publicValue.includes(rawId)),
      ),
    )
  ) {
    throw new TypeError(
      'Public Actual update payload contains a raw Actual identifier',
    );
  }
}

export function parseActualUpdateInternalPayload(
  value: unknown,
): ActualUpdateInternalEnvelopePayloadV2 {
  const parsed = z
    .strictObject({
      schemaVersion: z.literal('actual-update-internal-payload.v2'),
      publicProposal: actualUpdatePublicProposalSchema,
      writerRequest: z.strictObject({
        idempotencyKey: identifierSchema,
        observed: z.unknown(),
        edit: z.unknown(),
      }),
    })
    .parse(value);
  const writerRequest =
    parsed.writerRequest as unknown as UpdateExistingActualTransactionRequest;
  assertActualTransactionObservation(writerRequest.observed);
  if (writerRequest.observed.importedId === null) {
    throw new TypeError('An update intent must target an imported transaction');
  }
  const categories =
    writerRequest.edit.categorization.kind === 'single'
      ? [writerRequest.edit.categorization.categoryId]
      : writerRequest.edit.categorization.splits.map((line) => line.categoryId);
  assertApprovedActualTransactionEdit(
    writerRequest.edit,
    writerRequest.observed.amountMinorUnits,
    new Set(categories),
  );
  if (parsed.publicProposal.idempotencyKey !== writerRequest.idempotencyKey) {
    throw new TypeError(
      'Public and internal idempotency keys must be identical',
    );
  }
  assertPublicMatchesWriter(parsed.publicProposal, writerRequest.edit);
  assertPublicContainsNoRawActualIds(parsed.publicProposal, writerRequest);
  return structuredClone({
    schemaVersion: 'actual-update-internal-payload.v2',
    publicProposal: parsed.publicProposal,
    writerRequest,
  });
}

export function parseSealedActualUpdateEnvelope(
  value: unknown,
): SealedActualUpdateIntentEnvelopeV2 {
  const envelope = z
    .strictObject({
      schemaVersion: z.literal('actual-update-envelope.v2'),
      keyId: identifierSchema,
      payload: z.unknown(),
      signatureSha256: sha256Schema,
    })
    .parse(value);
  return {
    schemaVersion: 'actual-update-envelope.v2',
    keyId: envelope.keyId,
    payload: parseActualUpdateInternalPayload(envelope.payload),
    signatureSha256: envelope.signatureSha256,
  };
}

function parseApplyResult(
  value: unknown,
): UpdateExistingActualTransactionResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Actual update result must be an object');
  }
  if (
    Object.keys(value).some(
      (key) => key !== 'status' && key !== 'applied' && key !== 'undoIntent',
    )
  ) {
    throw new TypeError('Actual update result contains an unapproved field');
  }
  const result = value as Partial<UpdateExistingActualTransactionResult>;
  if (
    result.status !== 'unchanged' &&
    result.status !== 'already-applied' &&
    result.status !== 'updated'
  ) {
    throw new TypeError('Actual update result status is invalid');
  }
  assertActualTransactionObservation(
    result.applied as ActualTransactionObservationV1,
  );
  if (
    (result.status === 'unchanged' && result.undoIntent !== null) ||
    (result.status !== 'unchanged' &&
      (result.undoIntent === null || result.undoIntent === undefined))
  ) {
    throw new TypeError('Actual update result has an invalid undo intent');
  }
  if (result.undoIntent !== null && result.undoIntent !== undefined) {
    assertActualUpdateUndoIntent(result.undoIntent);
  }
  return structuredClone(result as UpdateExistingActualTransactionResult);
}

function parseUndoResult(value: unknown): UndoExistingActualTransactionResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Actual undo result must be an object');
  }
  if (
    Object.keys(value).some((key) => key !== 'status' && key !== 'restored')
  ) {
    throw new TypeError('Actual undo result contains an unapproved field');
  }
  const result = value as Partial<UndoExistingActualTransactionResult>;
  if (result.status !== 'undone' && result.status !== 'already-undone') {
    throw new TypeError('Actual undo result status is invalid');
  }
  assertActualTransactionObservation(
    result.restored as ActualTransactionObservationV1,
  );
  return structuredClone(result as UndoExistingActualTransactionResult);
}

function leaseToken(): string {
  return `actual-update-lease_${randomBytes(32).toString('base64url')}`;
}

export class ActualUpdateIntentStore {
  readonly #database: Database.Database;
  readonly #leaseDurationMs: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(
    databasePath: string,
    options: ActualUpdateIntentStoreOptions = {},
  ) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    const leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1_000;
    const retryDelaysMs = options.retryDelaysMs ?? [
      5_000,
      30_000,
      2 * 60_000,
      10 * 60_000,
      60 * 60_000,
      6 * 60 * 60_000,
      24 * 60 * 60_000,
    ];
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > 60 * 60_000 ||
      retryDelaysMs.length === 0 ||
      retryDelaysMs.some(
        (delay) =>
          !Number.isSafeInteger(delay) ||
          delay < 0 ||
          delay > 7 * 24 * 60 * 60_000,
      )
    ) {
      throw new RangeError('Actual update lease or retry policy is invalid');
    }
    this.#leaseDurationMs = leaseDurationMs;
    this.#retryDelaysMs = [...retryDelaysMs];
    this.#database = new Database(databasePath);
    this.#database.exec(actualUpdateStoreSchema);
  }

  close(): void {
    this.#database.close();
  }

  /**
   * Internal ingress only. Normal integration should call
   * ActualUpdateWorkflow.enqueue(), which seals the payload before persistence.
   */
  createSealedIntent(envelopeInput: SealedActualUpdateIntentEnvelopeV2): {
    readonly inserted: boolean;
    readonly intent: ActualUpdatePublicIntent;
  } {
    const envelope = parseSealedActualUpdateEnvelope(envelopeInput);
    const proposal = envelope.payload.publicProposal;
    const observed = envelope.payload.writerRequest.observed;
    if (observed.importedId === null) {
      throw new TypeError('Actual update target must have an imported ID');
    }
    const publicJson = serializeJson(proposal, 'public Actual update proposal');
    const envelopeJson = serializeJson(
      envelope,
      'sealed Actual update envelope',
    );
    const digest = envelopeDigest(envelopeJson);

    return this.#database.transaction(
      (): {
        readonly inserted: boolean;
        readonly intent: ActualUpdatePublicIntent;
      } => {
        const existing = this.#database
          .prepare(
            `SELECT *
             FROM actual_update_intents
            WHERE intent_id = ? OR idempotency_key = ?
            ORDER BY intent_id
            LIMIT 1`,
          )
          .get(proposal.intentId, proposal.idempotencyKey) as
          IntentRow | undefined;
        if (existing !== undefined) {
          if (
            existing.intent_id !== proposal.intentId ||
            existing.idempotency_key !== proposal.idempotencyKey ||
            existing.envelope_sha256 !== digest ||
            existing.envelope_json !== envelopeJson
          ) {
            throw new ActualUpdateStoreConflictError(
              'Actual update intent identity was reused with different content',
            );
          }
          const intent = this.#getPublicIntent(proposal.intentId);
          if (intent === undefined) {
            throw new Error('Existing Actual update state is missing');
          }
          return { inserted: false, intent };
        }

        if (this.#hasTargetLock(proposal.targetRef, proposal.intentId)) {
          throw new ActualUpdateStoreConflictError(
            'Another update for this transaction is still in progress',
          );
        }

        this.#database
          .prepare(
            `INSERT INTO actual_update_intents (
             intent_id, idempotency_key, target_ref, account_alias,
             source_id, audit_id,
             target_transaction_id, target_imported_id, expected_fingerprint,
             public_json, envelope_json, envelope_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            proposal.intentId,
            proposal.idempotencyKey,
            proposal.targetRef,
            proposal.accountAlias,
            proposal.sourceId,
            proposal.auditId,
            observed.transactionId,
            observed.importedId,
            observed.fullFingerprint,
            publicJson,
            envelopeJson,
            digest,
            proposal.createdAt,
          );
        this.#database
          .prepare(
            `INSERT INTO actual_update_state (
             intent_id, status, apply_attempt_count, undo_attempt_count,
             available_at, lease_token, lease_expires_at, claim_mode,
             last_error_code, updated_at
           ) VALUES (?, 'awaiting-approval', 0, 0, NULL, NULL, NULL, NULL, NULL, ?)`,
          )
          .run(proposal.intentId, proposal.createdAt);
        this.#appendAudit(
          proposal.intentId,
          'actual-update.intent-created',
          {
            targetRef: proposal.targetRef,
            accountAlias: proposal.accountAlias,
            sourceId: proposal.sourceId,
            auditId: proposal.auditId,
          },
          proposal.createdAt,
        );
        const intent = this.#getPublicIntent(proposal.intentId);
        if (intent === undefined) {
          throw new Error('Actual update intent was not persisted');
        }
        return { inserted: true, intent };
      },
    )();
  }

  getPublicIntent(intentIdInput: string): ActualUpdatePublicIntent | undefined {
    return this.#getPublicIntent(identifier(intentIdInput, 'intentId'));
  }

  listPublicIntentsByStatus(
    status: ActualUpdateOperationalStatus,
    maximum = 100,
    order: 'oldest' | 'newest' = 'oldest',
    offset = 0,
  ): readonly ActualUpdatePublicIntent[] {
    if (!actualUpdateOperationalStatuses.has(status)) {
      throw new TypeError('Actual update status is invalid');
    }
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1_000) {
      throw new RangeError('maximum must be from 0 to 1000');
    }
    if (order !== 'oldest' && order !== 'newest') {
      throw new TypeError('Actual update intent order is invalid');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('Actual update intent offset must be nonnegative');
    }
    const direction = order === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.#database
      .prepare(
        `SELECT state.intent_id
           FROM actual_update_state AS state
           JOIN actual_update_intents AS intent
             ON intent.intent_id = state.intent_id
          WHERE state.status = ?
          ORDER BY intent.created_at ${direction}, state.intent_id ${direction}
          LIMIT ? OFFSET ?`,
      )
      .all(status, maximum, offset) as { intent_id: string }[];
    return rows.map((row) => this.#requiredPublicIntent(row.intent_id));
  }

  approve(input: ActualUpdateApprovalInput): {
    readonly outcome: 'recorded' | 'duplicate';
    readonly intent: ActualUpdatePublicIntent;
  } {
    const intentId = identifier(input.intentId, 'intentId');
    const decisionId = identifier(input.decisionId, 'decisionId');
    const actorId = identifier(input.actorId, 'actorId');
    const approvedAt = normalizedInstant(input.approvedAt, 'approvedAt');
    return this.#database.transaction(
      (): {
        readonly outcome: 'recorded' | 'duplicate';
        readonly intent: ActualUpdatePublicIntent;
      } => {
        if (this.#getIntentRow(intentId) === undefined) {
          throw new ActualUpdateStoreConflictError(
            'Actual update intent does not exist',
          );
        }
        const existing = this.#getDecisionRow(intentId, decisionId);
        if (existing !== undefined) {
          if (
            existing.intent_id !== intentId ||
            existing.decision_id !== decisionId ||
            existing.decision !== 'approved' ||
            existing.actor_id !== actorId ||
            existing.decided_at !== approvedAt
          ) {
            throw new ActualUpdateStoreConflictError(
              'Actual update decision identity was reused with different content',
            );
          }
          const publicIntent = this.#requiredPublicIntent(intentId);
          return { outcome: 'duplicate', intent: publicIntent };
        }
        const state = this.#requiredStateRow(intentId);
        if (state.status !== 'awaiting-approval') {
          throw new ActualUpdateStoreConflictError(
            `Cannot approve an intent in ${state.status} state`,
          );
        }
        this.#database
          .prepare(
            `INSERT INTO actual_update_decisions (
             intent_id, decision_id, decision, actor_id, reason_code, decided_at
           ) VALUES (?, ?, 'approved', ?, NULL, ?)`,
          )
          .run(intentId, decisionId, actorId, approvedAt);
        this.#database
          .prepare(
            `UPDATE actual_update_state
              SET status = 'queued',
                  available_at = ?,
                  last_error_code = NULL,
                  updated_at = ?
            WHERE intent_id = ? AND status = 'awaiting-approval'`,
          )
          .run(approvedAt, approvedAt, intentId);
        this.#appendAudit(
          intentId,
          'actual-update.approved',
          {
            decisionId,
            actorId,
          },
          approvedAt,
        );
        return {
          outcome: 'recorded',
          intent: this.#requiredPublicIntent(intentId),
        };
      },
    )();
  }

  reject(input: ActualUpdateRejectionInput): {
    readonly outcome: 'recorded' | 'duplicate';
    readonly intent: ActualUpdatePublicIntent;
  } {
    const intentId = identifier(input.intentId, 'intentId');
    const decisionId = identifier(input.decisionId, 'decisionId');
    const actorId = identifier(input.actorId, 'actorId');
    const reason = errorCode(input.reasonCode);
    const rejectedAt = normalizedInstant(input.rejectedAt, 'rejectedAt');
    return this.#database.transaction(
      (): {
        readonly outcome: 'recorded' | 'duplicate';
        readonly intent: ActualUpdatePublicIntent;
      } => {
        if (this.#getIntentRow(intentId) === undefined) {
          throw new ActualUpdateStoreConflictError(
            'Actual update intent does not exist',
          );
        }
        const existing = this.#getDecisionRow(intentId, decisionId);
        if (existing !== undefined) {
          if (
            existing.intent_id !== intentId ||
            existing.decision_id !== decisionId ||
            existing.decision !== 'rejected' ||
            existing.actor_id !== actorId ||
            existing.reason_code !== reason ||
            existing.decided_at !== rejectedAt
          ) {
            throw new ActualUpdateStoreConflictError(
              'Actual update decision identity was reused with different content',
            );
          }
          return {
            outcome: 'duplicate',
            intent: this.#requiredPublicIntent(intentId),
          };
        }
        const state = this.#requiredStateRow(intentId);
        if (state.status !== 'awaiting-approval') {
          throw new ActualUpdateStoreConflictError(
            `Cannot reject an intent in ${state.status} state`,
          );
        }
        this.#database
          .prepare(
            `INSERT INTO actual_update_decisions (
             intent_id, decision_id, decision, actor_id, reason_code, decided_at
           ) VALUES (?, ?, 'rejected', ?, ?, ?)`,
          )
          .run(intentId, decisionId, actorId, reason, rejectedAt);
        this.#database
          .prepare(
            `UPDATE actual_update_state
              SET status = 'rejected',
                  available_at = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE intent_id = ? AND status = 'awaiting-approval'`,
          )
          .run(reason, rejectedAt, intentId);
        this.#appendAudit(
          intentId,
          'actual-update.rejected',
          { decisionId, actorId, reasonCode: reason },
          rejectedAt,
        );
        return {
          outcome: 'recorded',
          intent: this.#requiredPublicIntent(intentId),
        };
      },
    )();
  }

  claimNextApply(nowInput: string): ActualUpdateApplyClaim | undefined {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(
      (): ActualUpdateApplyClaim | undefined => {
        const row = this.#database
          .prepare(
            `SELECT state.*, intent.*
             FROM actual_update_state AS state
             JOIN actual_update_intents AS intent
               ON intent.intent_id = state.intent_id
             JOIN actual_update_decisions AS decision
               ON decision.intent_id = state.intent_id
            WHERE state.status IN ('queued', 'ambiguous')
              AND decision.decision = 'approved'
              AND state.available_at IS NOT NULL
              AND state.available_at <= ?
            ORDER BY state.available_at, intent.created_at, intent.intent_id
            LIMIT 1`,
          )
          .get(now) as (StateRow & IntentRow) | undefined;
        if (row === undefined) {
          return undefined;
        }
        const mode: ActualUpdateClaimMode =
          row.status === 'queued' ? 'apply' : 'reconcile';
        const token = leaseToken();
        const expiresAt = new Date(
          Date.parse(now) + this.#leaseDurationMs,
        ).toISOString();
        const updated = this.#database
          .prepare(
            `UPDATE actual_update_state
              SET status = 'claimed',
                  apply_attempt_count = apply_attempt_count + 1,
                  available_at = NULL,
                  lease_token = ?,
                  lease_expires_at = ?,
                  claim_mode = ?,
                  updated_at = ?
            WHERE intent_id = ?
              AND status = ?
              AND available_at IS NOT NULL
              AND available_at <= ?`,
          )
          .run(token, expiresAt, mode, now, row.intent_id, row.status, now);
        if (updated.changes !== 1) {
          throw new ActualUpdateLeaseError('Actual update claim was lost');
        }
        const attemptCount = row.apply_attempt_count + 1;
        this.#appendAudit(
          row.intent_id,
          'actual-update.apply-claimed',
          { mode, attemptCount, leaseExpiresAt: expiresAt },
          now,
        );
        return {
          intentId: row.intent_id,
          targetRef: row.target_ref,
          mode,
          leaseToken: token,
          leaseExpiresAt: expiresAt,
          attemptCount,
          targetTransactionId: row.target_transaction_id,
          targetImportedId: row.target_imported_id,
          expectedFingerprint: row.expected_fingerprint,
          envelope: parseSealedActualUpdateEnvelope(
            parseJson(row.envelope_json),
          ),
        };
      },
    )();
  }

  markApplyApplying(
    intentIdInput: string,
    leaseTokenInput: string,
    applyingAtInput: string,
  ): void {
    const intentId = identifier(intentIdInput, 'intentId');
    const token = identifier(leaseTokenInput, 'leaseToken');
    const applyingAt = normalizedInstant(applyingAtInput, 'applyingAt');
    this.#database.transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'applying', updated_at = ?
            WHERE intent_id = ?
              AND status = 'claimed'
              AND lease_token = ?
              AND lease_expires_at >= ?
              AND claim_mode IN ('apply', 'reconcile')`,
        )
        .run(applyingAt, intentId, token, applyingAt);
      if (updated.changes !== 1) {
        throw new ActualUpdateLeaseError(
          'Apply lease is missing, expired, or not claimable',
        );
      }
      this.#appendAudit(
        intentId,
        'actual-update.apply-started',
        {},
        applyingAt,
      );
    })();
  }

  completeApply(
    intentIdInput: string,
    leaseTokenInput: string,
    resultInput: UpdateExistingActualTransactionResult,
    completedAtInput: string,
  ): 'recorded' | 'duplicate' {
    const intentId = identifier(intentIdInput, 'intentId');
    const token = identifier(leaseTokenInput, 'leaseToken');
    const result = parseApplyResult(resultInput);
    const completedAt = normalizedInstant(completedAtInput, 'completedAt');
    const resultJson = serializeJson(result, 'Actual update result');
    const undoJson =
      result.undoIntent === null
        ? null
        : serializeJson(result.undoIntent, 'Actual update undo intent');
    return this.#database.transaction((): 'recorded' | 'duplicate' => {
      const intent = this.#getIntentRow(intentId);
      if (intent === undefined) {
        throw new ActualUpdateStoreConflictError(
          'Actual update intent does not exist',
        );
      }
      this.#assertApplyResultMatchesIntent(result, intent);
      const existing = this.#getApplyOutcomeRow(intentId);
      if (existing !== undefined) {
        if (
          existing.result_json !== resultJson ||
          existing.undo_intent_json !== undoJson ||
          existing.completed_at !== completedAt
        ) {
          throw new ActualUpdateStoreConflictError(
            'Actual update completion was repeated with different content',
          );
        }
        return 'duplicate';
      }
      const state = this.#requiredStateRow(intentId);
      if (
        state.status !== 'applying' ||
        state.lease_token !== token ||
        (state.claim_mode !== 'apply' && state.claim_mode !== 'reconcile')
      ) {
        throw new ActualUpdateLeaseError(
          'Apply completion does not own the active applying lease',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO actual_update_apply_outcomes (
             intent_id, result_json, undo_intent_json, completed_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(intentId, resultJson, undoJson, completedAt);
      this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'applied',
                  available_at = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = NULL,
                  updated_at = ?
            WHERE intent_id = ?`,
        )
        .run(completedAt, intentId);
      this.#appendAudit(
        intentId,
        'actual-update.apply-completed',
        {
          resultStatus: result.status,
          hasUndoIntent: result.undoIntent !== null,
          readbackFingerprint: result.applied.fullFingerprint,
        },
        completedAt,
      );
      return 'recorded';
    })();
  }

  markApplyAmbiguous(
    intentIdInput: string,
    leaseTokenInput: string,
    errorCodeInput: string,
    occurredAtInput: string,
  ): void {
    this.#markAmbiguous({
      intentId: identifier(intentIdInput, 'intentId'),
      leaseToken: identifier(leaseTokenInput, 'leaseToken'),
      errorCode: errorCode(errorCodeInput),
      occurredAt: normalizedInstant(occurredAtInput, 'occurredAt'),
      operation: 'apply',
    });
  }

  failApply(
    intentIdInput: string,
    leaseTokenInput: string,
    errorCodeInput: string,
    failedAtInput: string,
  ): void {
    const intentId = identifier(intentIdInput, 'intentId');
    const token = identifier(leaseTokenInput, 'leaseToken');
    const failure = errorCode(errorCodeInput);
    const failedAt = normalizedInstant(failedAtInput, 'failedAt');
    this.#database.transaction(() => {
      const state = this.#requiredStateRow(intentId);
      if (
        (state.status !== 'claimed' && state.status !== 'applying') ||
        state.lease_token !== token ||
        (state.claim_mode !== 'apply' && state.claim_mode !== 'reconcile')
      ) {
        throw new ActualUpdateLeaseError(
          'Apply failure does not own the active lease',
        );
      }
      this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'failed',
                  available_at = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE intent_id = ?`,
        )
        .run(failure, failedAt, intentId);
      this.#appendAudit(
        intentId,
        'actual-update.apply-failed',
        { errorCode: failure },
        failedAt,
      );
    })();
  }

  getApplyOutcome(
    intentIdInput: string,
  ): UpdateExistingActualTransactionResult | undefined {
    const row = this.#getApplyOutcomeRow(identifier(intentIdInput, 'intentId'));
    return row === undefined
      ? undefined
      : parseApplyResult(parseJson(row.result_json));
  }

  requestUndo(input: ActualUpdateUndoRequestInput): {
    readonly outcome: 'recorded' | 'duplicate';
    readonly intent: ActualUpdatePublicIntent;
  } {
    const intentId = identifier(input.intentId, 'intentId');
    const requestId = identifier(input.requestId, 'requestId');
    const actorId = identifier(input.actorId, 'actorId');
    const requestedAt = normalizedInstant(input.requestedAt, 'requestedAt');
    return this.#database.transaction(
      (): {
        readonly outcome: 'recorded' | 'duplicate';
        readonly intent: ActualUpdatePublicIntent;
      } => {
        const existing = this.#database
          .prepare(
            `SELECT intent_id, request_id, actor_id, requested_at
             FROM actual_update_undo_requests
            WHERE intent_id = ? OR request_id = ?
            ORDER BY intent_id
            LIMIT 1`,
          )
          .get(intentId, requestId) as
          | {
              intent_id: string;
              request_id: string;
              actor_id: string;
              requested_at: string;
            }
          | undefined;
        if (existing !== undefined) {
          if (
            existing.intent_id !== intentId ||
            existing.request_id !== requestId ||
            existing.actor_id !== actorId ||
            existing.requested_at !== requestedAt
          ) {
            throw new ActualUpdateStoreConflictError(
              'Undo request identity was reused with different content',
            );
          }
          return {
            outcome: 'duplicate',
            intent: this.#requiredPublicIntent(intentId),
          };
        }
        const intent = this.#getIntentRow(intentId);
        if (intent === undefined) {
          throw new ActualUpdateStoreConflictError(
            'Actual update intent does not exist',
          );
        }
        const state = this.#requiredStateRow(intentId);
        if (state.status !== 'applied') {
          throw new ActualUpdateStoreConflictError(
            `Cannot queue undo from ${state.status} state`,
          );
        }
        const outcome = this.#getApplyOutcomeRow(intentId);
        if (outcome?.undo_intent_json === null || outcome === undefined) {
          throw new ActualUpdateStoreConflictError(
            'This outcome made no mutation and has no undo intent',
          );
        }
        if (this.#hasTargetLock(intent.target_ref, intentId)) {
          throw new ActualUpdateStoreConflictError(
            'Another update for this transaction is still in progress',
          );
        }
        if (this.#hasLaterTargetEffect(intent.target_ref, intentId)) {
          throw new ActualUpdateStoreConflictError(
            'A later update for this transaction prevents undoing this one',
          );
        }
        this.#database
          .prepare(
            `INSERT INTO actual_update_undo_requests (
             intent_id, request_id, actor_id, requested_at
           ) VALUES (?, ?, ?, ?)`,
          )
          .run(intentId, requestId, actorId, requestedAt);
        this.#database
          .prepare(
            `UPDATE actual_update_state
              SET status = 'undo-queued',
                  available_at = ?,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = NULL,
                  updated_at = ?
            WHERE intent_id = ? AND status = 'applied'`,
          )
          .run(requestedAt, requestedAt, intentId);
        this.#appendAudit(
          intentId,
          'actual-update.undo-requested',
          { requestId, actorId },
          requestedAt,
        );
        return {
          outcome: 'recorded',
          intent: this.#requiredPublicIntent(intentId),
        };
      },
    )();
  }

  claimNextUndo(nowInput: string): ActualUpdateUndoClaim | undefined {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT state.*, intent.*, outcome.undo_intent_json
             FROM actual_update_state AS state
             JOIN actual_update_intents AS intent
               ON intent.intent_id = state.intent_id
             JOIN actual_update_apply_outcomes AS outcome
               ON outcome.intent_id = state.intent_id
            WHERE state.status IN ('undo-queued', 'undo-ambiguous')
              AND state.available_at IS NOT NULL
              AND state.available_at <= ?
              AND outcome.undo_intent_json IS NOT NULL
            ORDER BY state.available_at, intent.created_at, intent.intent_id
            LIMIT 1`,
        )
        .get(now) as
        (StateRow & IntentRow & { undo_intent_json: string }) | undefined;
      if (row === undefined) {
        return undefined;
      }
      const mode: ActualUpdateUndoClaimMode =
        row.status === 'undo-queued' ? 'undo' : 'undo-reconcile';
      const token = leaseToken();
      const expiresAt = new Date(
        Date.parse(now) + this.#leaseDurationMs,
      ).toISOString();
      const updated = this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'undo-claimed',
                  undo_attempt_count = undo_attempt_count + 1,
                  available_at = NULL,
                  lease_token = ?,
                  lease_expires_at = ?,
                  claim_mode = ?,
                  updated_at = ?
            WHERE intent_id = ?
              AND status = ?
              AND available_at IS NOT NULL
              AND available_at <= ?`,
        )
        .run(token, expiresAt, mode, now, row.intent_id, row.status, now);
      if (updated.changes !== 1) {
        throw new ActualUpdateLeaseError('Actual undo claim was lost');
      }
      const attemptCount = row.undo_attempt_count + 1;
      this.#appendAudit(
        row.intent_id,
        'actual-update.undo-claimed',
        { mode, attemptCount, leaseExpiresAt: expiresAt },
        now,
      );
      return {
        intentId: row.intent_id,
        targetRef: row.target_ref,
        mode,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        attemptCount,
        targetTransactionId: row.target_transaction_id,
        targetImportedId: row.target_imported_id,
        expectedFingerprint: row.expected_fingerprint,
        envelope: parseSealedActualUpdateEnvelope(parseJson(row.envelope_json)),
        undoIntent: this.#parseUndoIntent(row.undo_intent_json),
      };
    })();
  }

  markUndoApplying(
    intentIdInput: string,
    leaseTokenInput: string,
    applyingAtInput: string,
  ): void {
    const intentId = identifier(intentIdInput, 'intentId');
    const token = identifier(leaseTokenInput, 'leaseToken');
    const applyingAt = normalizedInstant(applyingAtInput, 'applyingAt');
    this.#database.transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'undo-applying', updated_at = ?
            WHERE intent_id = ?
              AND status = 'undo-claimed'
              AND lease_token = ?
              AND lease_expires_at >= ?
              AND claim_mode IN ('undo', 'undo-reconcile')`,
        )
        .run(applyingAt, intentId, token, applyingAt);
      if (updated.changes !== 1) {
        throw new ActualUpdateLeaseError(
          'Undo lease is missing, expired, or not claimable',
        );
      }
      this.#appendAudit(intentId, 'actual-update.undo-started', {}, applyingAt);
    })();
  }

  completeUndo(
    intentIdInput: string,
    leaseTokenInput: string,
    resultInput: UndoExistingActualTransactionResult,
    completedAtInput: string,
  ): 'recorded' | 'duplicate' {
    const intentId = identifier(intentIdInput, 'intentId');
    const token = identifier(leaseTokenInput, 'leaseToken');
    const result = parseUndoResult(resultInput);
    const completedAt = normalizedInstant(completedAtInput, 'completedAt');
    const resultJson = serializeJson(result, 'Actual undo result');
    return this.#database.transaction(() => {
      const intent = this.#getIntentRow(intentId);
      if (intent === undefined) {
        throw new ActualUpdateStoreConflictError(
          'Actual update intent does not exist',
        );
      }
      if (
        result.restored.transactionId !== intent.target_transaction_id ||
        result.restored.importedId !== intent.target_imported_id ||
        result.restored.fullFingerprint !== intent.expected_fingerprint
      ) {
        throw new ActualUpdateStoreConflictError(
          'Undo readback does not equal the exact original target',
        );
      }
      const existing = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_undo_outcomes
            WHERE intent_id = ?`,
        )
        .get(intentId) as UndoOutcomeRow | undefined;
      if (existing !== undefined) {
        if (
          existing.result_json !== resultJson ||
          existing.completed_at !== completedAt
        ) {
          throw new ActualUpdateStoreConflictError(
            'Actual undo completion was repeated with different content',
          );
        }
        return 'duplicate';
      }
      const state = this.#requiredStateRow(intentId);
      if (
        state.status !== 'undo-applying' ||
        state.lease_token !== token ||
        (state.claim_mode !== 'undo' && state.claim_mode !== 'undo-reconcile')
      ) {
        throw new ActualUpdateLeaseError(
          'Undo completion does not own the active applying lease',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO actual_update_undo_outcomes (
             intent_id, result_json, completed_at
           ) VALUES (?, ?, ?)`,
        )
        .run(intentId, resultJson, completedAt);
      this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'undone',
                  available_at = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = NULL,
                  updated_at = ?
            WHERE intent_id = ?`,
        )
        .run(completedAt, intentId);
      this.#appendAudit(
        intentId,
        'actual-update.undo-completed',
        {
          resultStatus: result.status,
          readbackFingerprint: result.restored.fullFingerprint,
        },
        completedAt,
      );
      return 'recorded';
    })();
  }

  markUndoAmbiguous(
    intentIdInput: string,
    leaseTokenInput: string,
    errorCodeInput: string,
    occurredAtInput: string,
  ): void {
    this.#markAmbiguous({
      intentId: identifier(intentIdInput, 'intentId'),
      leaseToken: identifier(leaseTokenInput, 'leaseToken'),
      errorCode: errorCode(errorCodeInput),
      occurredAt: normalizedInstant(occurredAtInput, 'occurredAt'),
      operation: 'undo',
    });
  }

  failUndo(
    intentIdInput: string,
    leaseTokenInput: string,
    errorCodeInput: string,
    failedAtInput: string,
  ): void {
    const intentId = identifier(intentIdInput, 'intentId');
    const token = identifier(leaseTokenInput, 'leaseToken');
    const failure = errorCode(errorCodeInput);
    const failedAt = normalizedInstant(failedAtInput, 'failedAt');
    this.#database.transaction(() => {
      const state = this.#requiredStateRow(intentId);
      if (
        (state.status !== 'undo-claimed' && state.status !== 'undo-applying') ||
        state.lease_token !== token ||
        (state.claim_mode !== 'undo' && state.claim_mode !== 'undo-reconcile')
      ) {
        throw new ActualUpdateLeaseError(
          'Undo failure does not own the active lease',
        );
      }
      this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = 'undo-failed',
                  available_at = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE intent_id = ?`,
        )
        .run(failure, failedAt, intentId);
      this.#appendAudit(
        intentId,
        'actual-update.undo-failed',
        { errorCode: failure },
        failedAt,
      );
    })();
  }

  getUndoOutcome(
    intentIdInput: string,
  ): UndoExistingActualTransactionResult | undefined {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_undo_outcomes
          WHERE intent_id = ?`,
      )
      .get(identifier(intentIdInput, 'intentId')) as UndoOutcomeRow | undefined;
    return row === undefined
      ? undefined
      : parseUndoResult(parseJson(row.result_json));
  }

  recoverExpiredLeases(nowInput: string): ActualUpdateLeaseRecoveryResult {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const expired = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_state
            WHERE lease_expires_at IS NOT NULL
              AND lease_expires_at < ?
              AND status IN (
                'claimed', 'applying', 'undo-claimed', 'undo-applying'
              )
            ORDER BY lease_expires_at, intent_id`,
        )
        .all(now) as StateRow[];
      const result = {
        requeuedApply: 0,
        ambiguousApply: 0,
        requeuedUndo: 0,
        ambiguousUndo: 0,
      };
      for (const state of expired) {
        if (state.status === 'claimed' && state.claim_mode === 'apply') {
          this.#recoverToDueState(
            state,
            'queued',
            now,
            'lease-expired-before-apply',
          );
          result.requeuedApply += 1;
          continue;
        }
        if (
          (state.status === 'claimed' && state.claim_mode === 'reconcile') ||
          state.status === 'applying'
        ) {
          this.#recoverToDueState(
            state,
            'ambiguous',
            now,
            'lease-expired-after-apply-boundary',
            this.#retryAvailableAt(state.apply_attempt_count, now),
          );
          result.ambiguousApply += 1;
          continue;
        }
        if (state.status === 'undo-claimed' && state.claim_mode === 'undo') {
          this.#recoverToDueState(
            state,
            'undo-queued',
            now,
            'lease-expired-before-undo',
          );
          result.requeuedUndo += 1;
          continue;
        }
        if (
          (state.status === 'undo-claimed' &&
            state.claim_mode === 'undo-reconcile') ||
          state.status === 'undo-applying'
        ) {
          this.#recoverToDueState(
            state,
            'undo-ambiguous',
            now,
            'lease-expired-after-undo-boundary',
            this.#retryAvailableAt(state.undo_attempt_count, now),
          );
          result.ambiguousUndo += 1;
          continue;
        }
        throw new Error('Expired Actual update lease has an invalid mode');
      }
      return result;
    })();
  }

  listAuditEvents(intentIdInput: string): ActualUpdateStoreAuditEvent[] {
    const intentId = identifier(intentIdInput, 'intentId');
    const rows = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_audit_events
          WHERE intent_id = ?
          ORDER BY id`,
      )
      .all(intentId) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      intentId: row.intent_id,
      action: row.action,
      detail: parseJson(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }

  #markAmbiguous(input: {
    readonly intentId: string;
    readonly leaseToken: string;
    readonly errorCode: string;
    readonly occurredAt: string;
    readonly operation: 'apply' | 'undo';
  }): void {
    this.#database.transaction(() => {
      const state = this.#requiredStateRow(input.intentId);
      const expectedStatus =
        input.operation === 'apply' ? 'applying' : 'undo-applying';
      const allowedModes =
        input.operation === 'apply'
          ? new Set(['apply', 'reconcile'])
          : new Set(['undo', 'undo-reconcile']);
      if (
        state.status !== expectedStatus ||
        state.lease_token !== input.leaseToken ||
        state.claim_mode === null ||
        !allowedModes.has(state.claim_mode)
      ) {
        throw new ActualUpdateLeaseError(
          `${input.operation} ambiguity does not own the active applying lease`,
        );
      }
      const attemptCount =
        input.operation === 'apply'
          ? state.apply_attempt_count
          : state.undo_attempt_count;
      const availableAt = this.#retryAvailableAt(
        attemptCount,
        input.occurredAt,
      );
      const status =
        input.operation === 'apply' ? 'ambiguous' : 'undo-ambiguous';
      this.#database
        .prepare(
          `UPDATE actual_update_state
              SET status = ?,
                  available_at = ?,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE intent_id = ?`,
        )
        .run(
          status,
          availableAt,
          input.errorCode,
          input.occurredAt,
          input.intentId,
        );
      this.#appendAudit(
        input.intentId,
        `actual-update.${input.operation}-ambiguous`,
        {
          errorCode: input.errorCode,
          attemptCount,
          nextAttemptAt: availableAt,
          manualReconciliationRequired: availableAt === null,
        },
        input.occurredAt,
      );
    })();
  }

  #recoverToDueState(
    state: StateRow,
    status: 'queued' | 'ambiguous' | 'undo-queued' | 'undo-ambiguous',
    now: string,
    reason: string,
    availableAt: string | null = now,
  ): void {
    const updated = this.#database
      .prepare(
        `UPDATE actual_update_state
            SET status = ?,
                available_at = ?,
                lease_token = NULL,
                lease_expires_at = NULL,
                claim_mode = NULL,
                last_error_code = ?,
                updated_at = ?
          WHERE intent_id = ?
            AND status = ?
            AND lease_token = ?`,
      )
      .run(
        status,
        availableAt,
        reason,
        now,
        state.intent_id,
        state.status,
        state.lease_token,
      );
    if (updated.changes !== 1) {
      throw new ActualUpdateLeaseError(
        'Expired Actual update lease changed during recovery',
      );
    }
    this.#appendAudit(
      state.intent_id,
      'actual-update.lease-recovered',
      {
        fromStatus: state.status,
        toStatus: status,
        reason,
        nextAttemptAt: availableAt,
        manualReconciliationRequired:
          status.includes('ambiguous') && availableAt === null,
      },
      now,
    );
  }

  #retryAvailableAt(attemptCount: number, occurredAt: string): string | null {
    const delay =
      attemptCount <= this.#retryDelaysMs.length
        ? this.#retryDelaysMs[Math.max(0, attemptCount - 1)]
        : undefined;
    return delay === undefined
      ? null
      : new Date(Date.parse(occurredAt) + delay).toISOString();
  }

  #assertApplyResultMatchesIntent(
    result: UpdateExistingActualTransactionResult,
    intent: IntentRow,
  ): void {
    if (
      result.applied.transactionId !== intent.target_transaction_id ||
      result.applied.importedId !== intent.target_imported_id
    ) {
      throw new ActualUpdateStoreConflictError(
        'Actual update readback belongs to a different target',
      );
    }
    if (result.undoIntent !== null) {
      const undo = result.undoIntent;
      if (
        undo.transactionId !== intent.target_transaction_id ||
        undo.importedId !== intent.target_imported_id ||
        undo.original.fullFingerprint !== intent.expected_fingerprint ||
        undo.expectedApplied.fullFingerprint !== result.applied.fullFingerprint
      ) {
        throw new ActualUpdateStoreConflictError(
          'Actual update undo intent is not bound to the exact result',
        );
      }
    } else if (result.applied.fullFingerprint !== intent.expected_fingerprint) {
      throw new ActualUpdateStoreConflictError(
        'An unchanged result does not equal the original observation',
      );
    }
  }

  #getIntentRow(intentId: string): IntentRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM actual_update_intents
          WHERE intent_id = ?`,
      )
      .get(intentId) as IntentRow | undefined;
  }

  #hasTargetLock(targetRef: string, excludedIntentId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM actual_update_intents AS intent
             JOIN actual_update_state AS state
               ON state.intent_id = intent.intent_id
            WHERE intent.target_ref = ?
              AND intent.intent_id <> ?
              AND state.status IN (${targetLockingOperationalStatuses
                .map(() => '?')
                .join(', ')})
            LIMIT 1`,
        )
        .get(
          targetRef,
          excludedIntentId,
          ...targetLockingOperationalStatuses,
        ) !== undefined
    );
  }

  #hasLaterTargetEffect(targetRef: string, intentId: string): boolean {
    const created = this.#database
      .prepare(
        `SELECT id
           FROM actual_update_audit_events
          WHERE intent_id = ?
            AND action = 'actual-update.intent-created'
          ORDER BY id
          LIMIT 1`,
      )
      .get(intentId) as { readonly id: number } | undefined;
    if (created === undefined) {
      throw new ActualUpdateStoreConflictError(
        'Actual update creation history is missing',
      );
    }
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM actual_update_intents AS later
             JOIN actual_update_state AS state
               ON state.intent_id = later.intent_id
             LEFT JOIN actual_update_audit_events AS later_created
               ON later_created.intent_id = later.intent_id
              AND later_created.action = 'actual-update.intent-created'
            WHERE later.target_ref = ?
              AND (later_created.id IS NULL OR later_created.id > ?)
              AND state.status NOT IN (${laterTargetNonEffectStatuses
                .map(() => '?')
                .join(', ')})
            LIMIT 1`,
        )
        .get(targetRef, created.id, ...laterTargetNonEffectStatuses) !==
      undefined
    );
  }

  #getStateRow(intentId: string): StateRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM actual_update_state
          WHERE intent_id = ?`,
      )
      .get(intentId) as StateRow | undefined;
  }

  #requiredStateRow(intentId: string): StateRow {
    const state = this.#getStateRow(intentId);
    if (state === undefined) {
      throw new ActualUpdateStoreConflictError(
        'Actual update state does not exist',
      );
    }
    return state;
  }

  #getDecisionRow(
    intentId: string,
    decisionId?: string,
  ): DecisionRow | undefined {
    if (decisionId === undefined) {
      return this.#database
        .prepare(
          `SELECT *
             FROM actual_update_decisions
            WHERE intent_id = ?`,
        )
        .get(intentId) as DecisionRow | undefined;
    }
    return this.#database
      .prepare(
        `SELECT *
           FROM actual_update_decisions
          WHERE intent_id = ? OR decision_id = ?
          ORDER BY intent_id
          LIMIT 1`,
      )
      .get(intentId, decisionId) as DecisionRow | undefined;
  }

  #getApplyOutcomeRow(intentId: string): ApplyOutcomeRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM actual_update_apply_outcomes
          WHERE intent_id = ?`,
      )
      .get(intentId) as ApplyOutcomeRow | undefined;
  }

  #parseUndoIntent(value: string): ActualUpdateUndoIntentV1 {
    const parsed = parseJson(value) as ActualUpdateUndoIntentV1;
    assertActualUpdateUndoIntent(parsed);
    return structuredClone(parsed);
  }

  #getPublicIntent(intentId: string): ActualUpdatePublicIntent | undefined {
    const intent = this.#getIntentRow(intentId);
    const state = this.#getStateRow(intentId);
    if (intent === undefined || state === undefined) {
      return undefined;
    }
    const proposal = actualUpdatePublicProposalSchema.parse(
      parseJson(intent.public_json),
    );
    const decision = this.#getDecisionRow(intentId);
    const applyOutcome = this.#getApplyOutcomeRow(intentId);
    const undoOutcome = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_undo_outcomes
          WHERE intent_id = ?`,
      )
      .get(intentId) as UndoOutcomeRow | undefined;
    return {
      proposal,
      status: state.status,
      approval:
        decision === undefined
          ? null
          : {
              decision: decision.decision,
              decisionId: decision.decision_id,
              actorId: decision.actor_id,
              reasonCode: decision.reason_code,
              decidedAt: decision.decided_at,
            },
      applyAttemptCount: state.apply_attempt_count,
      undoAttemptCount: state.undo_attempt_count,
      lastErrorCode: state.last_error_code,
      applyOutcome:
        applyOutcome === undefined
          ? null
          : {
              status: parseApplyResult(parseJson(applyOutcome.result_json))
                .status,
              completedAt: applyOutcome.completed_at,
            },
      undoOutcome:
        undoOutcome === undefined
          ? null
          : {
              status: parseUndoResult(parseJson(undoOutcome.result_json))
                .status,
              completedAt: undoOutcome.completed_at,
            },
      updatedAt: state.updated_at,
    };
  }

  #requiredPublicIntent(intentId: string): ActualUpdatePublicIntent {
    const intent = this.#getPublicIntent(intentId);
    if (intent === undefined) {
      throw new ActualUpdateStoreConflictError(
        'Actual update intent does not exist',
      );
    }
    return intent;
  }

  #appendAudit(
    intentId: string,
    action: string,
    detail: unknown,
    occurredAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO actual_update_audit_events (
           intent_id, action, detail_json, occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        intentId,
        identifier(action, 'audit action'),
        serializeJson(detail, 'Actual update audit detail'),
        occurredAt,
      );
  }
}
