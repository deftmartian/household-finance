import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  parseSealedReceiptNoteEnvelope,
  type SealedReceiptNoteEnvelopeV1,
} from './auth.js';
import {
  canonicalReceiptNoteOperationJson,
  type ReceiptNoteUpsertPayloadV1,
} from './payload.js';
import { actualReceiptNoteId } from '../receipt-record/index.js';
import type { ReceiptNoteUpsertResult } from './writer.js';

const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, 'Timestamp must be a canonical ISO-8601 UTC instant');
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
  );
const safeErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

export type ReceiptNoteOutboxStatus =
  | 'queued'
  | 'claimed'
  | 'applying'
  | 'reconcile'
  | 'applied'
  | 'ambiguous'
  | 'failed';

export type ReceiptNoteClaimMode = 'apply' | 'reconcile';

export interface ReceiptNoteOutboxPublicItem {
  readonly receiptId: string;
  readonly revision: number;
  readonly idempotencyKey: string;
  readonly expectedPreviousSha256: string | null;
  readonly desiredSha256: string;
  readonly status: ReceiptNoteOutboxStatus;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly outcome: ReceiptNoteUpsertResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReceiptNoteOutboxClaim {
  readonly receiptId: string;
  readonly revision: number;
  readonly mode: ReceiptNoteClaimMode;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
  readonly envelope: SealedReceiptNoteEnvelopeV1;
}

/**
 * Internal producer/recovery view. It contains canonical receipt facts and
 * must not be serialized into model prompts or Talk replies.
 */
export interface ReceiptNoteOutboxLatestInternal {
  readonly payload: ReceiptNoteUpsertPayloadV1;
  readonly status: ReceiptNoteOutboxStatus;
}

export interface ReceiptNoteOutboxOptions {
  readonly leaseDurationMs?: number;
  readonly retryDelaysMs?: readonly number[];
}

export interface ReceiptNoteLeaseRecoveryResult {
  readonly requeuedClaims: number;
  readonly scheduledReconciliations: number;
}

export class ReceiptNoteOutboxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptNoteOutboxConflictError';
  }
}

export class ReceiptNoteOutboxLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptNoteOutboxLeaseError';
  }
}

interface IntentRow {
  receipt_id: string;
  revision: number;
  idempotency_key: string;
  expected_previous_sha256: string | null;
  desired_sha256: string;
  envelope_json: string;
  envelope_sha256: string;
  created_at: string;
}

interface StateRow {
  receipt_id: string;
  revision: number;
  status: ReceiptNoteOutboxStatus;
  attempt_count: number;
  available_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  claim_mode: ReceiptNoteClaimMode | null;
  last_error_code: string | null;
  updated_at: string;
}

interface OutcomeRow {
  receipt_id: string;
  revision: number;
  result_json: string;
  completed_at: string;
}

const receiptNoteOutboxSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS actual_receipt_note_intents (
    receipt_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    idempotency_key TEXT NOT NULL UNIQUE,
    expected_previous_sha256 TEXT CHECK (
      expected_previous_sha256 IS NULL
      OR (
        length(expected_previous_sha256) = 64
        AND expected_previous_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    ),
    desired_sha256 TEXT NOT NULL CHECK (
      length(desired_sha256) = 64
      AND desired_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    envelope_json TEXT NOT NULL,
    envelope_sha256 TEXT NOT NULL CHECK (
      length(envelope_sha256) = 64
      AND envelope_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (receipt_id, revision)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_receipt_note_intents_no_update
  BEFORE UPDATE ON actual_receipt_note_intents
  BEGIN
    SELECT RAISE(ABORT, 'receipt note intents are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_receipt_note_intents_no_delete
  BEFORE DELETE ON actual_receipt_note_intents
  BEGIN
    SELECT RAISE(ABORT, 'receipt note intents are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_receipt_note_state (
    receipt_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued', 'claimed', 'applying', 'reconcile',
        'applied', 'ambiguous', 'failed'
      )
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT,
    lease_token TEXT,
    lease_expires_at TEXT,
    claim_mode TEXT CHECK (
      claim_mode IS NULL OR claim_mode IN ('apply', 'reconcile')
    ),
    last_error_code TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (receipt_id, revision),
    FOREIGN KEY (receipt_id, revision)
      REFERENCES actual_receipt_note_intents(receipt_id, revision),
    CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL AND claim_mode IS NULL)
      OR
      (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND claim_mode IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS actual_receipt_note_outcomes (
    receipt_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (receipt_id, revision),
    FOREIGN KEY (receipt_id, revision)
      REFERENCES actual_receipt_note_intents(receipt_id, revision)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_receipt_note_outcomes_no_update
  BEFORE UPDATE ON actual_receipt_note_outcomes
  BEGIN
    SELECT RAISE(ABORT, 'receipt note outcomes are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_receipt_note_outcomes_no_delete
  BEFORE DELETE ON actual_receipt_note_outcomes
  BEGIN
    SELECT RAISE(ABORT, 'receipt note outcomes are immutable');
  END;

  CREATE TABLE IF NOT EXISTS actual_receipt_note_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (receipt_id, revision)
      REFERENCES actual_receipt_note_intents(receipt_id, revision)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS actual_receipt_note_audit_no_update
  BEFORE UPDATE ON actual_receipt_note_audit
  BEGIN
    SELECT RAISE(ABORT, 'receipt note audit is append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS actual_receipt_note_audit_no_delete
  BEFORE DELETE ON actual_receipt_note_audit
  BEGIN
    SELECT RAISE(ABORT, 'receipt note audit is append-only');
  END;

  CREATE INDEX IF NOT EXISTS actual_receipt_note_state_ready_idx
    ON actual_receipt_note_state(status, available_at, updated_at);
`;

function normalizedInstant(value: string, name: string): string {
  const parsed = canonicalInstantSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${name} must be a canonical ISO-8601 UTC instant`);
  }
  return parsed.data;
}

function envelopeDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function leaseToken(): string {
  return randomBytes(24).toString('hex');
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function resultJson(result: ReceiptNoteUpsertResult): string {
  return canonicalReceiptNoteOperationJson(result);
}

export class ReceiptNoteOutboxStore {
  readonly #database: Database.Database;
  readonly #leaseDurationMs: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(databasePath: string, options: ReceiptNoteOutboxOptions = {}) {
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
      throw new RangeError('Receipt-note lease or retry policy is invalid');
    }
    this.#leaseDurationMs = leaseDurationMs;
    this.#retryDelaysMs = [...retryDelaysMs];
    this.#database = new Database(databasePath);
    this.#database.exec(receiptNoteOutboxSchema);
  }

  close(): void {
    this.#database.close();
  }

  enqueueSealed(envelopeInput: SealedReceiptNoteEnvelopeV1): {
    readonly inserted: boolean;
    readonly item: ReceiptNoteOutboxPublicItem;
  } {
    const envelope = parseSealedReceiptNoteEnvelope(envelopeInput);
    const payload = envelope.payload;
    const envelopeJson = canonicalReceiptNoteOperationJson(envelope);
    const digest = envelopeDigest(envelopeJson);
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT *
             FROM actual_receipt_note_intents
            WHERE (receipt_id = ? AND revision = ?)
               OR idempotency_key = ?
            ORDER BY receipt_id, revision
            LIMIT 1`,
        )
        .get(payload.receiptId, payload.revision, payload.idempotencyKey) as
        IntentRow | undefined;
      if (existing !== undefined) {
        if (
          existing.receipt_id !== payload.receiptId ||
          existing.revision !== payload.revision ||
          existing.idempotency_key !== payload.idempotencyKey ||
          existing.envelope_sha256 !== digest ||
          existing.envelope_json !== envelopeJson
        ) {
          throw new ReceiptNoteOutboxConflictError(
            'Receipt-note identity was reused with different content',
          );
        }
        return {
          inserted: false,
          item: this.#requiredPublicItem(payload.receiptId, payload.revision),
        };
      }
      this.#database
        .prepare(
          `INSERT INTO actual_receipt_note_intents (
             receipt_id, revision, idempotency_key,
             expected_previous_sha256, desired_sha256,
             envelope_json, envelope_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          payload.receiptId,
          payload.revision,
          payload.idempotencyKey,
          payload.expectedPreviousSha256,
          payload.desiredSha256,
          envelopeJson,
          digest,
          payload.createdAt,
        );
      this.#database
        .prepare(
          `INSERT INTO actual_receipt_note_state (
             receipt_id, revision, status, attempt_count, available_at,
             lease_token, lease_expires_at, claim_mode, last_error_code,
             updated_at
           ) VALUES (?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(
          payload.receiptId,
          payload.revision,
          payload.createdAt,
          payload.createdAt,
        );
      this.#appendAudit(
        payload.receiptId,
        payload.revision,
        'receipt-note.queued',
        { desiredSha256: payload.desiredSha256 },
        payload.createdAt,
      );
      return {
        inserted: true,
        item: this.#requiredPublicItem(payload.receiptId, payload.revision),
      };
    })();
  }

  get(
    receiptIdInput: string,
    revisionInput: number,
  ): ReceiptNoteOutboxPublicItem | undefined {
    const receiptId = identifierSchema.parse(receiptIdInput);
    const revision = z.number().int().safe().min(1).parse(revisionInput);
    return this.#publicItem(receiptId, revision);
  }

  getLatestInternal(
    receiptIdInput: string,
  ): ReceiptNoteOutboxLatestInternal | undefined {
    const receiptId = identifierSchema.parse(receiptIdInput);
    const row = this.#database
      .prepare(
        `SELECT intent.envelope_json, state.status
           FROM actual_receipt_note_intents AS intent
           JOIN actual_receipt_note_state AS state
             USING (receipt_id, revision)
          WHERE intent.receipt_id = ?
          ORDER BY intent.revision DESC
          LIMIT 1`,
      )
      .get(receiptId) as
      { envelope_json: string; status: ReceiptNoteOutboxStatus } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      payload: parseSealedReceiptNoteEnvelope(parseJson(row.envelope_json))
        .payload,
      status: row.status,
    };
  }

  listLatestInternal(limitInput = 1_000): ReceiptNoteOutboxLatestInternal[] {
    const limit = z.number().int().safe().min(1).max(10_000).parse(limitInput);
    const rows = this.#database
      .prepare(
        `SELECT intent.envelope_json, state.status
           FROM actual_receipt_note_intents AS intent
           JOIN actual_receipt_note_state AS state
             USING (receipt_id, revision)
          WHERE NOT EXISTS (
            SELECT 1
              FROM actual_receipt_note_intents AS later
             WHERE later.receipt_id = intent.receipt_id
               AND later.revision > intent.revision
          )
          ORDER BY intent.receipt_id
          LIMIT ?`,
      )
      .all(limit + 1) as {
      envelope_json: string;
      status: ReceiptNoteOutboxStatus;
    }[];
    if (rows.length > limit) {
      throw new RangeError('Receipt-note latest-record list exceeds its bound');
    }
    return rows.map((row) => ({
      payload: parseSealedReceiptNoteEnvelope(parseJson(row.envelope_json))
        .payload,
      status: row.status,
    }));
  }

  claimNext(nowInput: string): ReceiptNoteOutboxClaim | undefined {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT state.*, intent.*
             FROM actual_receipt_note_state AS state
             JOIN actual_receipt_note_intents AS intent
               USING (receipt_id, revision)
            WHERE state.status IN ('queued', 'reconcile')
              AND state.available_at IS NOT NULL
              AND state.available_at <= ?
              AND NOT EXISTS (
                SELECT 1
                  FROM actual_receipt_note_intents AS earlier
                  JOIN actual_receipt_note_state AS earlier_state
                    USING (receipt_id, revision)
                 WHERE earlier.receipt_id = intent.receipt_id
                   AND earlier.revision < intent.revision
                   AND earlier_state.status <> 'applied'
              )
            ORDER BY state.available_at, intent.created_at,
                     intent.receipt_id, intent.revision
            LIMIT 1`,
        )
        .get(now) as (StateRow & IntentRow) | undefined;
      if (row === undefined) {
        return undefined;
      }
      const priorStatus = row.status;
      const mode: ReceiptNoteClaimMode =
        priorStatus === 'reconcile' ? 'reconcile' : 'apply';
      const token = leaseToken();
      const expiresAt = new Date(
        Date.parse(now) + this.#leaseDurationMs,
      ).toISOString();
      const updated = this.#database
        .prepare(
          `UPDATE actual_receipt_note_state
              SET status = 'claimed',
                  attempt_count = attempt_count + 1,
                  available_at = NULL,
                  lease_token = ?,
                  lease_expires_at = ?,
                  claim_mode = ?,
                  updated_at = ?
            WHERE receipt_id = ?
              AND revision = ?
              AND status = ?
              AND available_at IS NOT NULL
              AND available_at <= ?`,
        )
        .run(
          token,
          expiresAt,
          mode,
          now,
          row.receipt_id,
          row.revision,
          priorStatus,
          now,
        );
      if (updated.changes !== 1) {
        throw new ReceiptNoteOutboxLeaseError('Receipt-note claim was lost');
      }
      const attemptCount = row.attempt_count + 1;
      this.#appendAudit(
        row.receipt_id,
        row.revision,
        'receipt-note.claimed',
        { mode, attemptCount, leaseExpiresAt: expiresAt },
        now,
      );
      return {
        receiptId: row.receipt_id,
        revision: row.revision,
        mode,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        attemptCount,
        envelope: parseSealedReceiptNoteEnvelope(parseJson(row.envelope_json)),
      };
    })();
  }

  markApplying(
    claim: Pick<
      ReceiptNoteOutboxClaim,
      'receiptId' | 'revision' | 'leaseToken'
    >,
    applyingAtInput: string,
  ): void {
    const applyingAt = normalizedInstant(applyingAtInput, 'applyingAt');
    this.#database.transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE actual_receipt_note_state
              SET status = 'applying', updated_at = ?
            WHERE receipt_id = ?
              AND revision = ?
              AND status = 'claimed'
              AND lease_token = ?
              AND lease_expires_at >= ?`,
        )
        .run(
          applyingAt,
          claim.receiptId,
          claim.revision,
          claim.leaseToken,
          applyingAt,
        );
      if (updated.changes !== 1) {
        throw new ReceiptNoteOutboxLeaseError(
          'Receipt-note lease is missing or expired before mutation',
        );
      }
      this.#appendAudit(
        claim.receiptId,
        claim.revision,
        'receipt-note.applying',
        {},
        applyingAt,
      );
    })();
  }

  complete(
    claim: Pick<
      ReceiptNoteOutboxClaim,
      'receiptId' | 'revision' | 'leaseToken'
    >,
    result: ReceiptNoteUpsertResult,
    completedAtInput: string,
  ): 'recorded' | 'duplicate' {
    const completedAt = normalizedInstant(completedAtInput, 'completedAt');
    const intent = this.#requiredIntent(claim.receiptId, claim.revision);
    if (
      result.receiptId !== claim.receiptId ||
      result.revision !== claim.revision ||
      result.noteId !== actualReceiptNoteId(claim.receiptId) ||
      result.desiredSha256 !== intent.desired_sha256
    ) {
      throw new ReceiptNoteOutboxConflictError(
        'Receipt-note result does not match its intent',
      );
    }
    const serializedResult = resultJson(result);
    return this.#database.transaction(() => {
      const existing = this.#outcome(claim.receiptId, claim.revision);
      if (existing !== undefined) {
        if (
          existing.result_json !== serializedResult ||
          existing.completed_at !== completedAt
        ) {
          throw new ReceiptNoteOutboxConflictError(
            'Receipt-note completion was repeated with different content',
          );
        }
        return 'duplicate' as const;
      }
      const state = this.#requiredState(claim.receiptId, claim.revision);
      const expectedState =
        result.status === 'updated' ||
        (result.status === 'ambiguous' &&
          result.reason === 'post-write-readback-mismatch')
          ? 'applying'
          : 'claimed';
      if (
        state.status !== expectedState ||
        state.lease_token !== claim.leaseToken
      ) {
        throw new ReceiptNoteOutboxLeaseError(
          'Receipt-note completion does not own the active lease',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO actual_receipt_note_outcomes (
             receipt_id, revision, result_json, completed_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(claim.receiptId, claim.revision, serializedResult, completedAt);
      const nextStatus =
        result.status === 'ambiguous' ? 'ambiguous' : 'applied';
      this.#database
        .prepare(
          `UPDATE actual_receipt_note_state
              SET status = ?,
                  available_at = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE receipt_id = ? AND revision = ?`,
        )
        .run(
          nextStatus,
          result.status === 'ambiguous' ? result.reason : null,
          completedAt,
          claim.receiptId,
          claim.revision,
        );
      this.#appendAudit(
        claim.receiptId,
        claim.revision,
        result.status === 'ambiguous'
          ? 'receipt-note.ambiguous'
          : 'receipt-note.applied',
        { resultStatus: result.status },
        completedAt,
      );
      return 'recorded' as const;
    })();
  }

  retrySafeFailure(
    claim: Pick<
      ReceiptNoteOutboxClaim,
      'receiptId' | 'revision' | 'leaseToken' | 'attemptCount'
    >,
    errorCodeInput: string,
    occurredAtInput: string,
  ): void {
    this.#retryOrFinish(
      claim,
      safeErrorCodeSchema.parse(errorCodeInput),
      normalizedInstant(occurredAtInput, 'occurredAt'),
      'queued',
      'failed',
    );
  }

  scheduleReconciliation(
    claim: Pick<
      ReceiptNoteOutboxClaim,
      'receiptId' | 'revision' | 'leaseToken' | 'attemptCount'
    >,
    errorCodeInput: string,
    occurredAtInput: string,
  ): void {
    this.#retryOrFinish(
      claim,
      safeErrorCodeSchema.parse(errorCodeInput),
      normalizedInstant(occurredAtInput, 'occurredAt'),
      'reconcile',
      'ambiguous',
    );
  }

  fail(
    claim: Pick<
      ReceiptNoteOutboxClaim,
      'receiptId' | 'revision' | 'leaseToken'
    >,
    errorCodeInput: string,
    failedAtInput: string,
  ): void {
    const errorCode = safeErrorCodeSchema.parse(errorCodeInput);
    const failedAt = normalizedInstant(failedAtInput, 'failedAt');
    this.#database.transaction(() => {
      const state = this.#requiredState(claim.receiptId, claim.revision);
      if (
        (state.status !== 'claimed' && state.status !== 'applying') ||
        state.lease_token !== claim.leaseToken
      ) {
        throw new ReceiptNoteOutboxLeaseError(
          'Receipt-note failure does not own the active lease',
        );
      }
      this.#database
        .prepare(
          `UPDATE actual_receipt_note_state
              SET status = 'failed',
                  available_at = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE receipt_id = ? AND revision = ?`,
        )
        .run(errorCode, failedAt, claim.receiptId, claim.revision);
      this.#appendAudit(
        claim.receiptId,
        claim.revision,
        'receipt-note.failed',
        { errorCode },
        failedAt,
      );
    })();
  }

  recoverExpiredLeases(nowInput: string): ReceiptNoteLeaseRecoveryResult {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT receipt_id, revision, status, claim_mode
             FROM actual_receipt_note_state
            WHERE status IN ('claimed', 'applying')
              AND lease_expires_at < ?
            ORDER BY receipt_id, revision`,
        )
        .all(now) as Pick<
        StateRow,
        'receipt_id' | 'revision' | 'status' | 'claim_mode'
      >[];
      let requeuedClaims = 0;
      let scheduledReconciliations = 0;
      for (const row of rows) {
        const nextStatus =
          row.status === 'applying' || row.claim_mode === 'reconcile'
            ? 'reconcile'
            : 'queued';
        this.#database
          .prepare(
            `UPDATE actual_receipt_note_state
                SET status = ?,
                    available_at = ?,
                    lease_token = NULL,
                    lease_expires_at = NULL,
                    claim_mode = NULL,
                    last_error_code = 'lease-expired',
                    updated_at = ?
              WHERE receipt_id = ?
                AND revision = ?
                AND status = ?`,
          )
          .run(nextStatus, now, now, row.receipt_id, row.revision, row.status);
        if (nextStatus === 'queued') {
          requeuedClaims += 1;
        } else {
          scheduledReconciliations += 1;
        }
        this.#appendAudit(
          row.receipt_id,
          row.revision,
          'receipt-note.lease-recovered',
          { priorStatus: row.status, nextStatus },
          now,
        );
      }
      return { requeuedClaims, scheduledReconciliations };
    })();
  }

  #retryOrFinish(
    claim: Pick<
      ReceiptNoteOutboxClaim,
      'receiptId' | 'revision' | 'leaseToken' | 'attemptCount'
    >,
    errorCode: string,
    occurredAt: string,
    retryStatus: 'queued' | 'reconcile',
    terminalStatus: 'failed' | 'ambiguous',
  ): void {
    this.#database.transaction(() => {
      const state = this.#requiredState(claim.receiptId, claim.revision);
      const expectedState =
        retryStatus === 'reconcile' ? 'applying' : 'claimed';
      if (
        state.status !== expectedState ||
        state.lease_token !== claim.leaseToken ||
        state.attempt_count !== claim.attemptCount
      ) {
        throw new ReceiptNoteOutboxLeaseError(
          'Receipt-note retry does not own the active lease',
        );
      }
      const delay = this.#retryDelaysMs[claim.attemptCount - 1];
      const exhausted = delay === undefined;
      const nextStatus = exhausted ? terminalStatus : retryStatus;
      const availableAt = exhausted
        ? null
        : new Date(Date.parse(occurredAt) + delay).toISOString();
      this.#database
        .prepare(
          `UPDATE actual_receipt_note_state
              SET status = ?,
                  available_at = ?,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  claim_mode = NULL,
                  last_error_code = ?,
                  updated_at = ?
            WHERE receipt_id = ? AND revision = ?`,
        )
        .run(
          nextStatus,
          availableAt,
          errorCode,
          occurredAt,
          claim.receiptId,
          claim.revision,
        );
      this.#appendAudit(
        claim.receiptId,
        claim.revision,
        exhausted
          ? `receipt-note.${terminalStatus}`
          : `receipt-note.${retryStatus}`,
        {
          errorCode,
          attemptCount: claim.attemptCount,
          availableAt,
        },
        occurredAt,
      );
    })();
  }

  #publicItem(
    receiptId: string,
    revision: number,
  ): ReceiptNoteOutboxPublicItem | undefined {
    const row = this.#database
      .prepare(
        `SELECT intent.*, state.*
           FROM actual_receipt_note_intents AS intent
           JOIN actual_receipt_note_state AS state
             USING (receipt_id, revision)
          WHERE intent.receipt_id = ? AND intent.revision = ?`,
      )
      .get(receiptId, revision) as (IntentRow & StateRow) | undefined;
    if (row === undefined) {
      return undefined;
    }
    const outcome = this.#outcome(receiptId, revision);
    return {
      receiptId: row.receipt_id,
      revision: row.revision,
      idempotencyKey: row.idempotency_key,
      expectedPreviousSha256: row.expected_previous_sha256,
      desiredSha256: row.desired_sha256,
      status: row.status,
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      outcome:
        outcome === undefined
          ? null
          : (parseJson(outcome.result_json) as ReceiptNoteUpsertResult),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #requiredPublicItem(
    receiptId: string,
    revision: number,
  ): ReceiptNoteOutboxPublicItem {
    const item = this.#publicItem(receiptId, revision);
    if (item === undefined) {
      throw new Error('Receipt-note outbox item is missing');
    }
    return item;
  }

  #requiredIntent(receiptId: string, revision: number): IntentRow {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_receipt_note_intents
          WHERE receipt_id = ? AND revision = ?`,
      )
      .get(receiptId, revision) as IntentRow | undefined;
    if (row === undefined) {
      throw new ReceiptNoteOutboxConflictError(
        'Receipt-note intent does not exist',
      );
    }
    return row;
  }

  #requiredState(receiptId: string, revision: number): StateRow {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_receipt_note_state
          WHERE receipt_id = ? AND revision = ?`,
      )
      .get(receiptId, revision) as StateRow | undefined;
    if (row === undefined) {
      throw new ReceiptNoteOutboxConflictError(
        'Receipt-note state does not exist',
      );
    }
    return row;
  }

  #outcome(receiptId: string, revision: number): OutcomeRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM actual_receipt_note_outcomes
          WHERE receipt_id = ? AND revision = ?`,
      )
      .get(receiptId, revision) as OutcomeRow | undefined;
  }

  #appendAudit(
    receiptId: string,
    revision: number,
    action: string,
    detail: unknown,
    occurredAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO actual_receipt_note_audit (
           receipt_id, revision, action, detail_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        receiptId,
        revision,
        action,
        canonicalReceiptNoteOperationJson(detail),
        occurredAt,
      );
  }
}
