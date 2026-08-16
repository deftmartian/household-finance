import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import Database from 'better-sqlite3';
import { z } from 'zod';

import {
  applyHouseholdContextMutation,
  householdContextMutationSchema,
  type HouseholdContextMutation,
} from '../context/mutation.js';
import {
  householdProfileSchema,
  type HouseholdProfile,
} from '../context/profile.js';

export const HOUSEHOLD_CONTEXT_MUTATION_MAX_BYTES = 64 * 1024;
export const HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

export type HouseholdContextMutationStatus =
  'pending' | 'processing' | 'applied' | 'conflict' | 'failed';

export interface HouseholdContextMutationRecordInput {
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  mutation: HouseholdContextMutation;
}

export interface HouseholdContextMutationRecord {
  id: string;
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  mutation: HouseholdContextMutation;
  mutationSha256: string;
  resultReplyEnabled: boolean;
  createdAt: string;
}

export interface HouseholdContextMutationItem {
  eventId: string;
  status: HouseholdContextMutationStatus;
  beforeSnapshot?: HouseholdProfile;
  afterSnapshot?: HouseholdProfile;
  beforeSnapshotSha256?: string;
  afterSnapshotSha256?: string;
  observedRevision?: number;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdContextUndoIntentInput {
  idempotencyKey: string;
  originalEventId: string;
  actorId: string;
  messageId: string;
  requestedAt: string;
}

export interface HouseholdContextUndoIntent {
  id: string;
  idempotencyKey: string;
  originalEventId: string;
  actorId: string;
  messageId: string;
  requestedAt: string;
  status: HouseholdContextMutationStatus;
  expectedSnapshot: HouseholdProfile;
  priorSnapshot: HouseholdProfile;
  targetSnapshot?: HouseholdProfile;
  expectedSnapshotSha256: string;
  priorSnapshotSha256: string;
  targetSnapshotSha256?: string;
  observedRevision?: number;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdContextTalkReplyPayload {
  roomToken: string;
  message: string;
  replyTo: string;
  referenceId: string;
  silent: boolean;
}

export type HouseholdContextOutboxKind =
  | 'send-context-mutation-acknowledgement'
  | 'apply-context-mutation'
  | 'send-context-mutation-result'
  | 'send-context-undo-acknowledgement'
  | 'apply-context-undo'
  | 'send-context-undo-result';

export interface HouseholdContextOutboxJob {
  id: number;
  idempotencyKey: string;
  kind: HouseholdContextOutboxKind;
  eventId: string;
  undoIntentId?: string;
  payload: unknown;
  attemptCount: number;
}

export interface HouseholdContextPreparedApply {
  mode: 'write' | 'already-applied';
  targetProfile: HouseholdProfile;
  expectedProfileSha256: string;
  targetProfileSha256: string;
}

export interface HouseholdContextAuditEvent {
  id: number;
  subject: 'mutation' | 'undo';
  subjectId: string;
  action: string;
  detail: unknown;
  occurredAt: string;
}

interface MutationRow {
  id: string;
  idempotency_key: string;
  backend_url: string;
  room_token: string;
  mutation_json: string;
  mutation_sha256: string;
  result_reply_enabled: number;
  created_at: string;
}

interface MutationItemRow {
  event_id: string;
  status: HouseholdContextMutationStatus;
  before_snapshot_json: string | null;
  after_snapshot_json: string | null;
  before_snapshot_sha256: string | null;
  after_snapshot_sha256: string | null;
  observed_revision: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface UndoRow {
  id: string;
  idempotency_key: string;
  original_event_id: string;
  actor_id: string;
  message_id: string;
  requested_at: string;
  status: HouseholdContextMutationStatus;
  expected_snapshot_json: string;
  prior_snapshot_json: string;
  target_snapshot_json: string | null;
  expected_snapshot_sha256: string;
  prior_snapshot_sha256: string;
  target_snapshot_sha256: string | null;
  observed_revision: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  id: number;
  idempotency_key: string;
  kind: HouseholdContextOutboxKind;
  event_id: string;
  undo_intent_id: string | null;
  payload_json: string;
  attempt_count: number;
}

interface ClaimedOutboxRow extends OutboxRow {
  state: 'processing';
}

interface AuditRow {
  id: number;
  subject_kind: 'mutation' | 'undo';
  subject_id: string;
  action: string;
  detail_json: string;
  occurred_at: string;
}

const identifierSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim());
const mutationIdSchema = z.uuid();
const timestampSchema = z.iso.datetime({ offset: true });
const safeErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const mutationRecordInputSchema = z.strictObject({
  idempotencyKey: identifierSchema,
  backendUrl: z.url(),
  roomToken: identifierSchema,
  mutation: householdContextMutationSchema,
});

const undoIntentInputSchema = z.strictObject({
  idempotencyKey: identifierSchema,
  originalEventId: z.uuid(),
  actorId: identifierSchema.max(200),
  messageId: identifierSchema.max(200),
  requestedAt: timestampSchema,
});

const talkReplyPayloadSchema = z.strictObject({
  roomToken: identifierSchema,
  message: z.string().min(1).max(2_000),
  replyTo: identifierSchema,
  referenceId: sha256Schema,
  silent: z.boolean(),
});

const contextSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS household_context_mutations (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    backend_url TEXT NOT NULL,
    room_token TEXT NOT NULL,
    mutation_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    mutation_json TEXT NOT NULL CHECK (
      length(CAST(mutation_json AS BLOB)) <= ${String(HOUSEHOLD_CONTEXT_MUTATION_MAX_BYTES)}
    ),
    mutation_sha256 TEXT NOT NULL CHECK (
      length(mutation_sha256) = 64
      AND mutation_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    result_reply_enabled INTEGER NOT NULL DEFAULT 1 CHECK (
      result_reply_enabled IN (0, 1)
    ),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS household_context_mutation_items (
    event_id TEXT PRIMARY KEY REFERENCES household_context_mutations(id),
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'processing', 'applied', 'conflict', 'failed')
    ),
    before_snapshot_json TEXT CHECK (
      before_snapshot_json IS NULL
      OR length(CAST(before_snapshot_json AS BLOB)) <= ${String(HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES)}
    ),
    after_snapshot_json TEXT CHECK (
      after_snapshot_json IS NULL
      OR length(CAST(after_snapshot_json AS BLOB)) <= ${String(HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES)}
    ),
    before_snapshot_sha256 TEXT CHECK (
      before_snapshot_sha256 IS NULL
      OR (
        length(before_snapshot_sha256) = 64
        AND before_snapshot_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    ),
    after_snapshot_sha256 TEXT CHECK (
      after_snapshot_sha256 IS NULL
      OR (
        length(after_snapshot_sha256) = 64
        AND after_snapshot_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    ),
    observed_revision INTEGER CHECK (
      observed_revision IS NULL OR observed_revision >= 0
    ),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (
        before_snapshot_json IS NULL
        AND after_snapshot_json IS NULL
        AND before_snapshot_sha256 IS NULL
        AND after_snapshot_sha256 IS NULL
      )
      OR (
        before_snapshot_json IS NOT NULL
        AND after_snapshot_json IS NOT NULL
        AND before_snapshot_sha256 IS NOT NULL
        AND after_snapshot_sha256 IS NOT NULL
      )
    ),
    CHECK (
      (status IN ('conflict', 'failed') AND error_code IS NOT NULL)
      OR (status NOT IN ('conflict', 'failed') AND error_code IS NULL)
    ),
    CHECK (
      (status = 'conflict' AND observed_revision IS NOT NULL)
      OR (status <> 'conflict' AND observed_revision IS NULL)
    ),
    CHECK (
      status <> 'applied'
      OR (
        before_snapshot_json IS NOT NULL
        AND after_snapshot_json IS NOT NULL
      )
    )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS household_context_mutation_transitions
  BEFORE UPDATE OF status ON household_context_mutation_items
  WHEN NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (
      OLD.status = 'processing'
      AND NEW.status IN ('pending', 'applied', 'conflict', 'failed')
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid household context mutation transition');
  END;

  CREATE TRIGGER IF NOT EXISTS household_context_mutation_snapshots_once
  BEFORE UPDATE OF
    before_snapshot_json,
    after_snapshot_json,
    before_snapshot_sha256,
    after_snapshot_sha256
  ON household_context_mutation_items
  WHEN NOT (
    OLD.status = 'processing'
    AND NEW.status = 'processing'
    AND OLD.before_snapshot_json IS NULL
    AND OLD.after_snapshot_json IS NULL
    AND OLD.before_snapshot_sha256 IS NULL
    AND OLD.after_snapshot_sha256 IS NULL
    AND NEW.before_snapshot_json IS NOT NULL
    AND NEW.after_snapshot_json IS NOT NULL
    AND NEW.before_snapshot_sha256 IS NOT NULL
    AND NEW.after_snapshot_sha256 IS NOT NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'household context snapshots are immutable');
  END;

  CREATE TABLE IF NOT EXISTS household_context_undo_intents (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    original_event_id TEXT NOT NULL UNIQUE
      REFERENCES household_context_mutations(id),
    actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'processing', 'applied', 'conflict', 'failed')
    ),
    expected_snapshot_json TEXT NOT NULL CHECK (
      length(CAST(expected_snapshot_json AS BLOB)) <= ${String(HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES)}
    ),
    prior_snapshot_json TEXT NOT NULL CHECK (
      length(CAST(prior_snapshot_json AS BLOB)) <= ${String(HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES)}
    ),
    target_snapshot_json TEXT CHECK (
      target_snapshot_json IS NULL
      OR length(CAST(target_snapshot_json AS BLOB)) <= ${String(HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES)}
    ),
    expected_snapshot_sha256 TEXT NOT NULL CHECK (
      length(expected_snapshot_sha256) = 64
      AND expected_snapshot_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    prior_snapshot_sha256 TEXT NOT NULL CHECK (
      length(prior_snapshot_sha256) = 64
      AND prior_snapshot_sha256 NOT GLOB '*[^a-f0-9]*'
    ),
    target_snapshot_sha256 TEXT CHECK (
      target_snapshot_sha256 IS NULL
      OR (
        length(target_snapshot_sha256) = 64
        AND target_snapshot_sha256 NOT GLOB '*[^a-f0-9]*'
      )
    ),
    observed_revision INTEGER CHECK (
      observed_revision IS NULL OR observed_revision >= 0
    ),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(actor_id, message_id),
    CHECK (
      (target_snapshot_json IS NULL AND target_snapshot_sha256 IS NULL)
      OR (
        target_snapshot_json IS NOT NULL
        AND target_snapshot_sha256 IS NOT NULL
      )
    ),
    CHECK (
      (status IN ('conflict', 'failed') AND error_code IS NOT NULL)
      OR (status NOT IN ('conflict', 'failed') AND error_code IS NULL)
    ),
    CHECK (
      (status = 'conflict' AND observed_revision IS NOT NULL)
      OR (status <> 'conflict' AND observed_revision IS NULL)
    ),
    CHECK (status <> 'applied' OR target_snapshot_json IS NOT NULL)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS household_context_undo_transitions
  BEFORE UPDATE OF status ON household_context_undo_intents
  WHEN NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (
      OLD.status = 'processing'
      AND NEW.status IN ('pending', 'applied', 'conflict', 'failed')
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'invalid household context undo transition');
  END;

  CREATE TRIGGER IF NOT EXISTS household_context_undo_authority_immutable
  BEFORE UPDATE OF
    expected_snapshot_json,
    prior_snapshot_json,
    expected_snapshot_sha256,
    prior_snapshot_sha256
  ON household_context_undo_intents
  BEGIN
    SELECT RAISE(ABORT, 'household context undo authority is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS household_context_undo_target_once
  BEFORE UPDATE OF target_snapshot_json, target_snapshot_sha256
  ON household_context_undo_intents
  WHEN NOT (
    OLD.status = 'processing'
    AND NEW.status = 'processing'
    AND OLD.target_snapshot_json IS NULL
    AND OLD.target_snapshot_sha256 IS NULL
    AND NEW.target_snapshot_json IS NOT NULL
    AND NEW.target_snapshot_sha256 IS NOT NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'household context undo target is immutable');
  END;

  CREATE TABLE IF NOT EXISTS household_context_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'send-context-mutation-acknowledgement',
        'apply-context-mutation',
        'send-context-mutation-result',
        'send-context-undo-acknowledgement',
        'apply-context-undo',
        'send-context-undo-result'
      )
    ),
    event_id TEXT NOT NULL REFERENCES household_context_mutations(id),
    undo_intent_id TEXT REFERENCES household_context_undo_intents(id),
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'processing', 'completed', 'failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT NOT NULL,
    locked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK (
      (
        kind IN (
          'send-context-mutation-acknowledgement',
          'apply-context-mutation',
          'send-context-mutation-result'
        )
        AND undo_intent_id IS NULL
      )
      OR (
        kind IN (
          'send-context-undo-acknowledgement',
          'apply-context-undo',
          'send-context-undo-result'
        )
        AND undo_intent_id IS NOT NULL
      )
    ),
    CHECK (
      (state = 'processing' AND locked_at IS NOT NULL)
      OR (state <> 'processing' AND locked_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS household_context_outbox_ready
    ON household_context_outbox(state, available_at, id);

  CREATE TABLE IF NOT EXISTS household_context_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('mutation', 'undo')),
    subject_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;
`;

function serializeJson(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError(`${name} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new RangeError(`${name} exceeds its persisted byte limit`);
  }
  return serialized;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createReplyReferenceId(
  idempotencyKey: string,
  purpose: string,
): string {
  return createHash('sha256')
    .update('household-context-talk-reply-v1\0')
    .update(idempotencyKey)
    .update('\0')
    .update(purpose)
    .digest('hex');
}

function serializeProfile(profile: HouseholdProfile): {
  profile: HouseholdProfile;
  json: string;
  hash: string;
} {
  const parsed = householdProfileSchema.parse(profile);
  const json = serializeJson(
    parsed,
    'household context snapshot',
    HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES,
  );
  return { profile: parsed, json, hash: sha256(json) };
}

function profileFromJson(value: string): HouseholdProfile {
  return householdProfileSchema.parse(parseJson(value));
}

function mutationFromJson(value: string): HouseholdContextMutation {
  return householdContextMutationSchema.parse(parseJson(value));
}

function sameJson(left: string, right: string): boolean {
  return left === right;
}

function toMutationRecord(row: MutationRow): HouseholdContextMutationRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    backendUrl: row.backend_url,
    roomToken: row.room_token,
    mutation: mutationFromJson(row.mutation_json),
    mutationSha256: row.mutation_sha256,
    resultReplyEnabled: row.result_reply_enabled === 1,
    createdAt: row.created_at,
  };
}

function toMutationItem(row: MutationItemRow): HouseholdContextMutationItem {
  return {
    eventId: row.event_id,
    status: row.status,
    ...(row.before_snapshot_json === null
      ? {}
      : { beforeSnapshot: profileFromJson(row.before_snapshot_json) }),
    ...(row.after_snapshot_json === null
      ? {}
      : { afterSnapshot: profileFromJson(row.after_snapshot_json) }),
    ...(row.before_snapshot_sha256 === null
      ? {}
      : { beforeSnapshotSha256: row.before_snapshot_sha256 }),
    ...(row.after_snapshot_sha256 === null
      ? {}
      : { afterSnapshotSha256: row.after_snapshot_sha256 }),
    ...(row.observed_revision === null
      ? {}
      : { observedRevision: row.observed_revision }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUndoIntent(row: UndoRow): HouseholdContextUndoIntent {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    originalEventId: row.original_event_id,
    actorId: row.actor_id,
    messageId: row.message_id,
    requestedAt: row.requested_at,
    status: row.status,
    expectedSnapshot: profileFromJson(row.expected_snapshot_json),
    priorSnapshot: profileFromJson(row.prior_snapshot_json),
    ...(row.target_snapshot_json === null
      ? {}
      : { targetSnapshot: profileFromJson(row.target_snapshot_json) }),
    expectedSnapshotSha256: row.expected_snapshot_sha256,
    priorSnapshotSha256: row.prior_snapshot_sha256,
    ...(row.target_snapshot_sha256 === null
      ? {}
      : { targetSnapshotSha256: row.target_snapshot_sha256 }),
    ...(row.observed_revision === null
      ? {}
      : { observedRevision: row.observed_revision }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class HouseholdContextIdentityConflictError extends Error {
  constructor() {
    super('Household context identity is already bound to different input');
    this.name = 'HouseholdContextIdentityConflictError';
  }
}

export class HouseholdContextSnapshotConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly observedRevision: number,
  ) {
    super('Household context no longer equals the prepared snapshot');
    this.name = 'HouseholdContextSnapshotConflictError';
  }
}

export class HouseholdContextSnapshotMissingError extends Error {
  constructor() {
    super('Applied household context mutation has no immutable snapshots');
    this.name = 'HouseholdContextSnapshotMissingError';
  }
}

function restoredCollection<T>(
  current: readonly T[],
  expected: readonly T[],
  prior: readonly T[],
  key: string,
  keyOf: (value: T) => string,
): T[] | undefined {
  const currentIndex = current.findIndex((value) => keyOf(value) === key);
  const expectedValue = expected.find((value) => keyOf(value) === key);
  const currentValue = currentIndex < 0 ? undefined : current[currentIndex];
  if (!isDeepStrictEqual(currentValue, expectedValue)) {
    return undefined;
  }

  const restored = [...current];
  const priorIndex = prior.findIndex((value) => keyOf(value) === key);
  const priorValue = priorIndex < 0 ? undefined : prior[priorIndex];
  if (priorValue === undefined) {
    if (currentIndex >= 0) {
      restored.splice(currentIndex, 1);
    }
    return restored;
  }
  if (currentIndex >= 0) {
    restored[currentIndex] = priorValue;
    return restored;
  }
  restored.splice(Math.min(priorIndex, restored.length), 0, priorValue);
  return restored;
}

function restoredPolicies<K extends keyof HouseholdProfile['policies']>(
  current: HouseholdProfile['policies'],
  expected: HouseholdProfile['policies'],
  prior: HouseholdProfile['policies'],
  key: K,
): HouseholdProfile['policies'] | undefined {
  if (!isDeepStrictEqual(current[key], expected[key])) {
    return undefined;
  }
  const restored: HouseholdProfile['policies'] = structuredClone(current);
  if (prior[key] === undefined) {
    delete restored[key];
  } else {
    Object.assign(restored, { [key]: structuredClone(prior[key]) });
  }
  return restored;
}

function undoTargetProfile(
  current: HouseholdProfile,
  expected: HouseholdProfile,
  prior: HouseholdProfile,
  mutation: HouseholdContextMutation,
  appliedAt: string,
): HouseholdProfile | undefined {
  const next = structuredClone(current);
  const operation = mutation.operation;
  switch (operation.kind) {
    case 'upsert-member': {
      const restored = restoredCollection(
        current.members,
        expected.members,
        prior.members,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.members = restored;
      break;
    }
    case 'upsert-dependant': {
      const restored = restoredCollection(
        current.dependants,
        expected.dependants,
        prior.dependants,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.dependants = restored;
      break;
    }
    case 'upsert-income-cadence': {
      const restored = restoredCollection(
        current.incomeCadences,
        expected.incomeCadences,
        prior.incomeCadences,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.incomeCadences = restored;
      break;
    }
    case 'upsert-obligation': {
      const restored = restoredCollection(
        current.obligations,
        expected.obligations,
        prior.obligations,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.obligations = restored;
      break;
    }
    case 'upsert-savings-goal': {
      const restored = restoredCollection(
        current.savingsGoals,
        expected.savingsGoals,
        prior.savingsGoals,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.savingsGoals = restored;
      break;
    }
    case 'upsert-account-role': {
      const restored = restoredCollection(
        current.accountRoles,
        expected.accountRoles,
        prior.accountRoles,
        operation.value.alias,
        (value) => value.alias,
      );
      if (restored === undefined) return undefined;
      next.accountRoles = restored;
      break;
    }
    case 'upsert-merchant-rule': {
      const restored = restoredCollection(
        current.merchantRules,
        expected.merchantRules,
        prior.merchantRules,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.merchantRules = restored;
      break;
    }
    case 'upsert-transaction-rule': {
      const restored = restoredCollection(
        current.transactionRules,
        expected.transactionRules,
        prior.transactionRules,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.transactionRules = restored;
      break;
    }
    case 'upsert-exceptional-expense': {
      const restored = restoredCollection(
        current.exceptionalExpenses,
        expected.exceptionalExpenses,
        prior.exceptionalExpenses,
        operation.value.id,
        (value) => value.id,
      );
      if (restored === undefined) return undefined;
      next.exceptionalExpenses = restored;
      break;
    }
    case 'set-money-policy':
    case 'set-risk-policy':
    case 'set-text-policy':
    case 'remove-policy': {
      const restored = restoredPolicies(
        current.policies,
        expected.policies,
        prior.policies,
        operation.policy,
      );
      if (restored === undefined) return undefined;
      next.policies = restored;
      break;
    }
    case 'remove-record': {
      switch (operation.collection) {
        case 'members': {
          const restored = restoredCollection(
            current.members,
            expected.members,
            prior.members,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.members = restored;
          break;
        }
        case 'dependants': {
          const restored = restoredCollection(
            current.dependants,
            expected.dependants,
            prior.dependants,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.dependants = restored;
          break;
        }
        case 'incomeCadences': {
          const restored = restoredCollection(
            current.incomeCadences,
            expected.incomeCadences,
            prior.incomeCadences,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.incomeCadences = restored;
          break;
        }
        case 'obligations': {
          const restored = restoredCollection(
            current.obligations,
            expected.obligations,
            prior.obligations,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.obligations = restored;
          break;
        }
        case 'savingsGoals': {
          const restored = restoredCollection(
            current.savingsGoals,
            expected.savingsGoals,
            prior.savingsGoals,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.savingsGoals = restored;
          break;
        }
        case 'accountRoles': {
          const restored = restoredCollection(
            current.accountRoles,
            expected.accountRoles,
            prior.accountRoles,
            operation.key,
            (value) => value.alias,
          );
          if (restored === undefined) return undefined;
          next.accountRoles = restored;
          break;
        }
        case 'merchantRules': {
          const restored = restoredCollection(
            current.merchantRules,
            expected.merchantRules,
            prior.merchantRules,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.merchantRules = restored;
          break;
        }
        case 'transactionRules': {
          const restored = restoredCollection(
            current.transactionRules,
            expected.transactionRules,
            prior.transactionRules,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.transactionRules = restored;
          break;
        }
        case 'exceptionalExpenses': {
          const restored = restoredCollection(
            current.exceptionalExpenses,
            expected.exceptionalExpenses,
            prior.exceptionalExpenses,
            operation.key,
            (value) => value.id,
          );
          if (restored === undefined) return undefined;
          next.exceptionalExpenses = restored;
          break;
        }
      }
      break;
    }
  }
  if (!Number.isSafeInteger(current.revision + 1)) {
    throw new RangeError('Household context revision is exhausted');
  }
  next.revision = current.revision + 1;
  next.updatedAt = appliedAt;
  const parsed = householdProfileSchema.safeParse(next);
  return parsed.success ? parsed.data : undefined;
}

export class HouseholdContextStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new Database(databasePath);
    this.#database.exec(contextSchema);
  }

  close(): void {
    this.#database.close();
  }

  recordMutation(
    input: HouseholdContextMutationRecordInput,
    options: {
      readonly enqueueAcknowledgement?: boolean;
      readonly enqueueResultReply?: boolean;
    } = {},
  ): {
    record: HouseholdContextMutationRecord;
    inserted: boolean;
  } {
    const parsed = mutationRecordInputSchema.parse(input);
    const mutationJson = serializeJson(
      parsed.mutation,
      'household context mutation',
      HOUSEHOLD_CONTEXT_MUTATION_MAX_BYTES,
    );
    const mutationHash = sha256(mutationJson);
    return this.#database.transaction(() => {
      const existing = this.#findExistingMutation(
        parsed.idempotencyKey,
        parsed.mutation.mutationId,
      );
      if (existing !== undefined) {
        if (
          existing.idempotency_key !== parsed.idempotencyKey ||
          existing.mutation_sha256 !== mutationHash ||
          existing.backend_url !== parsed.backendUrl ||
          existing.room_token !== parsed.roomToken ||
          existing.result_reply_enabled !==
            (options.enqueueResultReply === false ? 0 : 1)
        ) {
          throw new HouseholdContextIdentityConflictError();
        }
        return { record: toMutationRecord(existing), inserted: false };
      }

      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO household_context_mutations (
             id, idempotency_key, backend_url, room_token, mutation_id,
             actor_id, message_id, requested_at, mutation_json,
             mutation_sha256, result_reply_enabled, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.idempotencyKey,
          parsed.backendUrl,
          parsed.roomToken,
          parsed.mutation.mutationId,
          parsed.mutation.actorId,
          parsed.mutation.messageId,
          parsed.mutation.requestedAt,
          mutationJson,
          mutationHash,
          options.enqueueResultReply === false ? 0 : 1,
          parsed.mutation.requestedAt,
        );
      this.#database
        .prepare(
          `INSERT INTO household_context_mutation_items (
             event_id, status, created_at, updated_at
           ) VALUES (?, 'pending', ?, ?)`,
        )
        .run(id, parsed.mutation.requestedAt, parsed.mutation.requestedAt);
      if (options.enqueueAcknowledgement !== false) {
        const acknowledgementReferenceId = createReplyReferenceId(
          parsed.idempotencyKey,
          'mutation-acknowledged',
        );
        this.#enqueue(
          'send-context-mutation-acknowledgement',
          id,
          undefined,
          {
            roomToken: parsed.roomToken,
            message: 'Got it — I’m saving that household detail now.',
            replyTo: parsed.mutation.messageId,
            referenceId: acknowledgementReferenceId,
            silent: false,
          },
          `context-talk-reply:${parsed.idempotencyKey}:acknowledged`,
          parsed.mutation.requestedAt,
        );
      }
      this.#enqueue(
        'apply-context-mutation',
        id,
        undefined,
        {},
        `apply-context-mutation:${parsed.idempotencyKey}`,
        parsed.mutation.requestedAt,
      );
      this.#appendAudit(
        'mutation',
        id,
        'context.mutation-recorded',
        {
          mutationId: parsed.mutation.mutationId,
          operation: parsed.mutation.operation.kind,
          actorId: parsed.mutation.actorId,
          messageId: parsed.mutation.messageId,
          requestedAt: parsed.mutation.requestedAt,
          mutationSha256: mutationHash,
        },
        parsed.mutation.requestedAt,
      );

      return {
        record: {
          id,
          idempotencyKey: parsed.idempotencyKey,
          backendUrl: parsed.backendUrl,
          roomToken: parsed.roomToken,
          mutation: parsed.mutation,
          mutationSha256: mutationHash,
          resultReplyEnabled: options.enqueueResultReply !== false,
          createdAt: parsed.mutation.requestedAt,
        },
        inserted: true,
      };
    })();
  }

  getMutation(eventId: string): HouseholdContextMutationRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM household_context_mutations WHERE id = ?')
      .get(eventId) as MutationRow | undefined;
    return row === undefined ? undefined : toMutationRecord(row);
  }

  hasPendingFirstResponse(roomTokenInput: string): boolean {
    const roomToken = identifierSchema.parse(roomTokenInput);
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM household_context_outbox AS outbox
             JOIN household_context_mutations AS mutation
               ON mutation.id = outbox.event_id
            WHERE mutation.room_token = ?
              AND outbox.kind IN (
                'send-context-mutation-acknowledgement',
                'send-context-undo-acknowledgement'
              )
              AND outbox.state IN ('pending', 'processing')
            LIMIT 1`,
        )
        .get(roomToken) !== undefined
    );
  }

  getMutationByMutationId(
    mutationId: string,
  ): HouseholdContextMutationRecord | undefined {
    const normalizedMutationId = mutationIdSchema.parse(mutationId);
    const row = this.#database
      .prepare(
        'SELECT * FROM household_context_mutations WHERE mutation_id = ?',
      )
      .get(normalizedMutationId) as MutationRow | undefined;
    return row === undefined ? undefined : toMutationRecord(row);
  }

  listMutationsForMessage(
    backendUrl: string,
    roomToken: string,
    actorId: string,
    messageId: string,
  ): readonly HouseholdContextMutationRecord[] {
    const normalizedBackendUrl = z.url().parse(backendUrl);
    const normalizedRoomToken = identifierSchema.parse(roomToken);
    const normalizedActorId = identifierSchema.max(200).parse(actorId);
    const normalizedMessageId = identifierSchema.max(200).parse(messageId);
    const rows = this.#database
      .prepare(
        `SELECT *
           FROM household_context_mutations
          WHERE backend_url = ?
            AND room_token = ?
            AND actor_id = ?
            AND message_id = ?
          ORDER BY created_at, id`,
      )
      .all(
        normalizedBackendUrl,
        normalizedRoomToken,
        normalizedActorId,
        normalizedMessageId,
      ) as MutationRow[];
    return rows.map(toMutationRecord);
  }

  getMutationItem(eventId: string): HouseholdContextMutationItem | undefined {
    const row = this.#database
      .prepare(
        'SELECT * FROM household_context_mutation_items WHERE event_id = ?',
      )
      .get(eventId) as MutationItemRow | undefined;
    return row === undefined ? undefined : toMutationItem(row);
  }

  findLatestUndoableMutation(
    roomToken: string,
  ): HouseholdContextMutationRecord | undefined {
    const normalizedRoomToken = identifierSchema.parse(roomToken);
    const row = this.#database
      .prepare(
        `SELECT mutation.*
           FROM household_context_mutations AS mutation
           JOIN household_context_mutation_items AS item
             ON item.event_id = mutation.id
           LEFT JOIN household_context_undo_intents AS undo
             ON undo.original_event_id = mutation.id
          WHERE mutation.room_token = ?
            AND item.status = 'applied'
            AND undo.id IS NULL
          ORDER BY item.updated_at DESC, mutation.id DESC
          LIMIT 1`,
      )
      .get(normalizedRoomToken) as MutationRow | undefined;
    return row === undefined ? undefined : toMutationRecord(row);
  }

  latestAppliedMutationAtOrBefore(
    roomToken: string,
    requestedAt: string,
  ): HouseholdContextMutationRecord | undefined {
    const normalizedRoomToken = identifierSchema.parse(roomToken);
    const normalizedRequestedAt = timestampSchema.parse(requestedAt);
    const row = this.#database
      .prepare(
        `SELECT mutation.*
           FROM household_context_mutations AS mutation
           JOIN household_context_mutation_items AS item
             ON item.event_id = mutation.id
           LEFT JOIN household_context_undo_intents AS undo
             ON undo.original_event_id = mutation.id
          WHERE mutation.room_token = ?
            AND mutation.requested_at <= ?
            AND item.status = 'applied'
            AND undo.id IS NULL
          ORDER BY mutation.requested_at DESC,
                   CAST(
                     json_extract(item.after_snapshot_json, '$.revision')
                     AS INTEGER
                   ) DESC,
                   mutation.id DESC
          LIMIT 1`,
      )
      .get(normalizedRoomToken, normalizedRequestedAt) as
      MutationRow | undefined;
    return row === undefined ? undefined : toMutationRecord(row);
  }

  prepareMutationApply(
    eventId: string,
    currentProfile: HouseholdProfile,
    appliedAt: string,
  ): HouseholdContextPreparedApply {
    timestampSchema.parse(appliedAt);
    const current = serializeProfile(currentProfile);
    return this.#database.transaction((): HouseholdContextPreparedApply => {
      const record = this.#requiredMutation(eventId);
      const item = this.#requiredMutationItem(eventId);
      if (item.status !== 'processing') {
        throw new Error('Household context mutation is not claimed');
      }

      if (
        item.before_snapshot_json !== null &&
        item.after_snapshot_json !== null &&
        item.before_snapshot_sha256 !== null &&
        item.after_snapshot_sha256 !== null
      ) {
        if (
          sameJson(current.json, item.after_snapshot_json) &&
          current.hash === item.after_snapshot_sha256
        ) {
          return {
            mode: 'already-applied',
            targetProfile: profileFromJson(item.after_snapshot_json),
            expectedProfileSha256: item.before_snapshot_sha256,
            targetProfileSha256: item.after_snapshot_sha256,
          };
        }
        if (
          !sameJson(current.json, item.before_snapshot_json) ||
          current.hash !== item.before_snapshot_sha256
        ) {
          const expected = profileFromJson(item.before_snapshot_json);
          throw new HouseholdContextSnapshotConflictError(
            expected.revision,
            current.profile.revision,
          );
        }
        return {
          mode: 'write',
          targetProfile: profileFromJson(item.after_snapshot_json),
          expectedProfileSha256: item.before_snapshot_sha256,
          targetProfileSha256: item.after_snapshot_sha256,
        };
      }

      const mutation = mutationFromJson(record.mutation_json);
      const after = serializeProfile(
        applyHouseholdContextMutation(current.profile, mutation, appliedAt),
      );
      const updated = this.#database
        .prepare(
          `UPDATE household_context_mutation_items
              SET before_snapshot_json = ?,
                  after_snapshot_json = ?,
                  before_snapshot_sha256 = ?,
                  after_snapshot_sha256 = ?,
                  updated_at = ?
            WHERE event_id = ?
              AND status = 'processing'
              AND before_snapshot_json IS NULL
              AND after_snapshot_json IS NULL`,
        )
        .run(
          current.json,
          after.json,
          current.hash,
          after.hash,
          appliedAt,
          eventId,
        );
      if (updated.changes !== 1) {
        throw new Error('Household context snapshots could not be prepared');
      }
      this.#appendAudit(
        'mutation',
        eventId,
        'context.mutation-snapshots-prepared',
        {
          beforeRevision: current.profile.revision,
          afterRevision: after.profile.revision,
          beforeSnapshotSha256: current.hash,
          afterSnapshotSha256: after.hash,
        },
        appliedAt,
      );
      return {
        mode: 'write',
        targetProfile: after.profile,
        expectedProfileSha256: current.hash,
        targetProfileSha256: after.hash,
      };
    })();
  }

  recordUndoIntent(
    input: HouseholdContextUndoIntentInput,
    options: { readonly enqueueAcknowledgement?: boolean } = {},
  ): {
    intent: HouseholdContextUndoIntent;
    inserted: boolean;
  } {
    const parsed = undoIntentInputSchema.parse(input);
    return this.#database.transaction(() => {
      const original = this.#requiredMutation(parsed.originalEventId);
      const item = this.#requiredMutationItem(parsed.originalEventId);
      if (
        item.status !== 'applied' ||
        item.before_snapshot_json === null ||
        item.after_snapshot_json === null ||
        item.before_snapshot_sha256 === null ||
        item.after_snapshot_sha256 === null
      ) {
        throw new HouseholdContextSnapshotMissingError();
      }

      const existing = this.#database
        .prepare(
          `SELECT *
             FROM household_context_undo_intents
            WHERE idempotency_key = ?
               OR original_event_id = ?
               OR (actor_id = ? AND message_id = ?)
            ORDER BY id
            LIMIT 1`,
        )
        .get(
          parsed.idempotencyKey,
          parsed.originalEventId,
          parsed.actorId,
          parsed.messageId,
        ) as UndoRow | undefined;
      if (existing !== undefined) {
        if (
          existing.idempotency_key !== parsed.idempotencyKey ||
          existing.original_event_id !== parsed.originalEventId ||
          existing.actor_id !== parsed.actorId ||
          existing.message_id !== parsed.messageId ||
          existing.requested_at !== parsed.requestedAt
        ) {
          throw new HouseholdContextIdentityConflictError();
        }
        return { intent: toUndoIntent(existing), inserted: false };
      }

      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO household_context_undo_intents (
             id, idempotency_key, original_event_id, actor_id, message_id,
             requested_at, status, expected_snapshot_json,
             prior_snapshot_json, expected_snapshot_sha256,
             prior_snapshot_sha256, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parsed.idempotencyKey,
          parsed.originalEventId,
          parsed.actorId,
          parsed.messageId,
          parsed.requestedAt,
          item.after_snapshot_json,
          item.before_snapshot_json,
          item.after_snapshot_sha256,
          item.before_snapshot_sha256,
          parsed.requestedAt,
          parsed.requestedAt,
        );
      if (options.enqueueAcknowledgement !== false) {
        const acknowledgementReferenceId = createReplyReferenceId(
          parsed.idempotencyKey,
          'undo-acknowledged',
        );
        this.#enqueue(
          'send-context-undo-acknowledgement',
          original.id,
          id,
          {
            roomToken: original.room_token,
            message:
              'Got it — I’m checking the latest saved household change now.',
            replyTo: parsed.messageId,
            referenceId: acknowledgementReferenceId,
            silent: false,
          },
          `context-undo-talk-reply:${parsed.idempotencyKey}:acknowledged`,
          parsed.requestedAt,
        );
      }
      this.#enqueue(
        'apply-context-undo',
        original.id,
        id,
        {},
        `apply-context-undo:${parsed.idempotencyKey}`,
        parsed.requestedAt,
      );
      this.#appendAudit(
        'undo',
        id,
        'context.undo-recorded',
        {
          originalEventId: original.id,
          actorId: parsed.actorId,
          messageId: parsed.messageId,
          requestedAt: parsed.requestedAt,
          expectedSnapshotSha256: item.after_snapshot_sha256,
          priorSnapshotSha256: item.before_snapshot_sha256,
        },
        parsed.requestedAt,
      );
      return {
        intent: this.#requiredUndo(id),
        inserted: true,
      };
    })();
  }

  getUndoIntent(undoIntentId: string): HouseholdContextUndoIntent | undefined {
    const row = this.#database
      .prepare('SELECT * FROM household_context_undo_intents WHERE id = ?')
      .get(undoIntentId) as UndoRow | undefined;
    return row === undefined ? undefined : toUndoIntent(row);
  }

  prepareUndoApply(
    undoIntentId: string,
    currentProfile: HouseholdProfile,
    appliedAt: string,
  ): HouseholdContextPreparedApply {
    timestampSchema.parse(appliedAt);
    const current = serializeProfile(currentProfile);
    return this.#database.transaction((): HouseholdContextPreparedApply => {
      const undo = this.#requiredUndoRow(undoIntentId);
      if (undo.status !== 'processing') {
        throw new Error('Household context undo is not claimed');
      }
      const expected = profileFromJson(undo.expected_snapshot_json);
      const prior = profileFromJson(undo.prior_snapshot_json);
      const original = mutationFromJson(
        this.#requiredMutation(undo.original_event_id).mutation_json,
      );

      if (
        undo.target_snapshot_json !== null &&
        undo.target_snapshot_sha256 !== null
      ) {
        const persistedTarget = profileFromJson(undo.target_snapshot_json);
        if (
          sameJson(current.json, undo.target_snapshot_json) &&
          current.hash === undo.target_snapshot_sha256
        ) {
          return {
            mode: 'already-applied',
            targetProfile: persistedTarget,
            expectedProfileSha256: current.hash,
            targetProfileSha256: undo.target_snapshot_sha256,
          };
        }
        const recomputed = undoTargetProfile(
          current.profile,
          expected,
          prior,
          original,
          persistedTarget.updatedAt,
        );
        if (recomputed === undefined) {
          throw new HouseholdContextSnapshotConflictError(
            expected.revision,
            current.profile.revision,
          );
        }
        const recomputedTarget = serializeProfile(recomputed);
        if (
          !sameJson(recomputedTarget.json, undo.target_snapshot_json) ||
          recomputedTarget.hash !== undo.target_snapshot_sha256
        ) {
          throw new HouseholdContextSnapshotConflictError(
            expected.revision,
            current.profile.revision,
          );
        }
        return {
          mode: 'write',
          targetProfile: persistedTarget,
          expectedProfileSha256: current.hash,
          targetProfileSha256: undo.target_snapshot_sha256,
        };
      }

      const targetValue = undoTargetProfile(
        current.profile,
        expected,
        prior,
        original,
        appliedAt,
      );
      if (targetValue === undefined) {
        throw new HouseholdContextSnapshotConflictError(
          expected.revision,
          current.profile.revision,
        );
      }
      const target = serializeProfile(targetValue);
      const updated = this.#database
        .prepare(
          `UPDATE household_context_undo_intents
              SET target_snapshot_json = ?,
                  target_snapshot_sha256 = ?,
                  updated_at = ?
            WHERE id = ?
              AND status = 'processing'
              AND target_snapshot_json IS NULL`,
        )
        .run(target.json, target.hash, appliedAt, undoIntentId);
      if (updated.changes !== 1) {
        throw new Error('Household context undo target could not be prepared');
      }
      this.#appendAudit(
        'undo',
        undoIntentId,
        'context.undo-target-prepared',
        {
          expectedRevision: current.profile.revision,
          targetRevision: target.profile.revision,
          expectedSnapshotSha256: current.hash,
          targetSnapshotSha256: target.hash,
        },
        appliedAt,
      );
      return {
        mode: 'write',
        targetProfile: target.profile,
        expectedProfileSha256: current.hash,
        targetProfileSha256: target.hash,
      };
    })();
  }

  claimNextOutbox(now: string): HouseholdContextOutboxJob | undefined {
    timestampSchema.parse(now);
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT id, idempotency_key, kind, event_id, undo_intent_id,
                  payload_json, attempt_count
             FROM household_context_outbox
            WHERE state = 'pending' AND available_at <= ?
            ORDER BY
              CASE kind
                WHEN 'send-context-mutation-acknowledgement' THEN 0
                WHEN 'send-context-undo-acknowledgement' THEN 0
                WHEN 'apply-context-mutation' THEN 1
                WHEN 'apply-context-undo' THEN 1
                ELSE 2
              END,
              id
            LIMIT 1`,
        )
        .get(now) as OutboxRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const claimed = this.#database
        .prepare(
          `UPDATE household_context_outbox
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  locked_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(now, row.id);
      if (claimed.changes !== 1) {
        return undefined;
      }
      if (row.kind === 'apply-context-mutation') {
        this.#transitionMutation(row.event_id, 'pending', 'processing', now);
      } else if (row.kind === 'apply-context-undo') {
        if (row.undo_intent_id === null) {
          throw new Error('Context undo outbox job has no intent');
        }
        this.#transitionUndo(row.undo_intent_id, 'pending', 'processing', now);
      }
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        kind: row.kind,
        eventId: row.event_id,
        ...(row.undo_intent_id === null
          ? {}
          : { undoIntentId: row.undo_intent_id }),
        payload: parseJson(row.payload_json),
        attemptCount: row.attempt_count + 1,
      };
    })();
  }

  completeMutationAppliedAndEnqueueResult(
    jobId: number,
    eventId: string,
    reply: HouseholdContextTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#completeTerminalAndEnqueueResult({
      jobId,
      eventId,
      status: 'applied',
      reply,
      replyIdempotencyKey,
      now,
    });
  }

  completeMutationConflictAndEnqueueResult(
    jobId: number,
    eventId: string,
    observedRevision: number,
    reply: HouseholdContextTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#completeTerminalAndEnqueueResult({
      jobId,
      eventId,
      status: 'conflict',
      observedRevision,
      errorCode: 'revision-conflict',
      reply,
      replyIdempotencyKey,
      now,
    });
  }

  failMutationAndEnqueueResult(
    jobId: number,
    eventId: string,
    errorCode: string,
    reply: HouseholdContextTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#completeTerminalAndEnqueueResult({
      jobId,
      eventId,
      status: 'failed',
      errorCode,
      reply,
      replyIdempotencyKey,
      now,
    });
  }

  completeUndoAppliedAndEnqueueResult(
    jobId: number,
    undoIntentId: string,
    reply: HouseholdContextTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#completeUndoTerminalAndEnqueueResult({
      jobId,
      undoIntentId,
      status: 'applied',
      reply,
      replyIdempotencyKey,
      now,
    });
  }

  completeUndoConflictAndEnqueueResult(
    jobId: number,
    undoIntentId: string,
    observedRevision: number,
    reply: HouseholdContextTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#completeUndoTerminalAndEnqueueResult({
      jobId,
      undoIntentId,
      status: 'conflict',
      observedRevision,
      errorCode: 'revision-conflict',
      reply,
      replyIdempotencyKey,
      now,
    });
  }

  failUndoAndEnqueueResult(
    jobId: number,
    undoIntentId: string,
    errorCode: string,
    reply: HouseholdContextTalkReplyPayload,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#completeUndoTerminalAndEnqueueResult({
      jobId,
      undoIntentId,
      status: 'failed',
      errorCode,
      reply,
      replyIdempotencyKey,
      now,
    });
  }

  retryOutbox(jobId: number, errorCode: string, availableAt: string): void {
    safeErrorCodeSchema.parse(errorCode);
    timestampSchema.parse(availableAt);
    this.#database.transaction(() => {
      const row = this.#requiredClaimedOutbox(jobId);
      if (row.kind === 'apply-context-mutation') {
        this.#transitionMutation(
          row.event_id,
          'processing',
          'pending',
          availableAt,
        );
      } else if (row.kind === 'apply-context-undo') {
        if (row.undo_intent_id === null) {
          throw new Error('Context undo outbox job has no intent');
        }
        this.#transitionUndo(
          row.undo_intent_id,
          'processing',
          'pending',
          availableAt,
        );
      }
      const updated = this.#database
        .prepare(
          `UPDATE household_context_outbox
              SET state = 'pending',
                  available_at = ?,
                  locked_at = NULL,
                  last_error = ?
            WHERE id = ? AND state = 'processing'`,
        )
        .run(availableAt, errorCode, jobId);
      if (updated.changes !== 1) {
        throw new Error('Household context outbox job is not claimed');
      }
    })();
  }

  completeTalkReplyOutbox(
    jobId: number,
    referenceId: string,
    now: string,
  ): void {
    sha256Schema.parse(referenceId);
    timestampSchema.parse(now);
    this.#database.transaction(() => {
      const row = this.#requiredClaimedOutbox(jobId);
      if (!row.kind.startsWith('send-context-')) {
        throw new Error('Household context outbox job is not a Talk reply');
      }
      this.#completeClaimedOutbox(jobId, now);
      this.#appendAudit(
        row.undo_intent_id === null ? 'mutation' : 'undo',
        row.undo_intent_id ?? row.event_id,
        'context.talk-reply-delivered',
        { kind: row.kind, referenceId },
        now,
      );
    })();
  }

  completeOutbox(jobId: number, now: string): void {
    timestampSchema.parse(now);
    const row = this.#requiredClaimedOutbox(jobId);
    if (!row.kind.startsWith('send-context-')) {
      throw new Error(
        'Apply jobs require an atomic household context terminal transition',
      );
    }
    this.#completeClaimedOutbox(jobId, now);
  }

  deadLetterTalkReplyOutbox(
    jobId: number,
    errorCode: string,
    now: string,
  ): void {
    safeErrorCodeSchema.parse(errorCode);
    timestampSchema.parse(now);
    this.#database.transaction(() => {
      const row = this.#requiredClaimedOutbox(jobId);
      if (!row.kind.startsWith('send-context-')) {
        throw new Error('Household context outbox job is not a Talk reply');
      }
      const updated = this.#database
        .prepare(
          `UPDATE household_context_outbox
              SET state = 'failed', locked_at = NULL, last_error = ?
            WHERE id = ? AND state = 'processing'`,
        )
        .run(errorCode, jobId);
      if (updated.changes !== 1) {
        throw new Error('Household context Talk reply is not claimed');
      }
      this.#appendAudit(
        row.undo_intent_id === null ? 'mutation' : 'undo',
        row.undo_intent_id ?? row.event_id,
        'context.talk-reply-dead-lettered',
        { kind: row.kind, errorCode },
        now,
      );
    })();
  }

  recoverInterruptedOutbox(now: string): number {
    timestampSchema.parse(now);
    return this.#database.transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT id, idempotency_key, kind, event_id, undo_intent_id,
                  payload_json, attempt_count, state
             FROM household_context_outbox
            WHERE state = 'processing'
            ORDER BY id`,
        )
        .all() as ClaimedOutboxRow[];
      for (const row of rows) {
        if (row.kind === 'apply-context-mutation') {
          this.#transitionMutation(row.event_id, 'processing', 'pending', now);
          const item = this.#requiredMutationItem(row.event_id);
          this.#appendAudit(
            'mutation',
            row.event_id,
            'context.mutation-processing-recovered',
            { snapshotsPrepared: item.before_snapshot_json !== null },
            now,
          );
        } else if (row.kind === 'apply-context-undo') {
          if (row.undo_intent_id === null) {
            throw new Error('Context undo outbox job has no intent');
          }
          this.#transitionUndo(
            row.undo_intent_id,
            'processing',
            'pending',
            now,
          );
          const undo = this.#requiredUndoRow(row.undo_intent_id);
          this.#appendAudit(
            'undo',
            row.undo_intent_id,
            'context.undo-processing-recovered',
            { targetPrepared: undo.target_snapshot_json !== null },
            now,
          );
        }
        const updated = this.#database
          .prepare(
            `UPDATE household_context_outbox
                SET state = 'pending', available_at = ?, locked_at = NULL
              WHERE id = ? AND state = 'processing'`,
          )
          .run(now, row.id);
        if (updated.changes !== 1) {
          throw new Error(
            'Interrupted household context outbox job could not be recovered',
          );
        }
      }
      return rows.length;
    })();
  }

  listMutationAudit(eventId: string): HouseholdContextAuditEvent[] {
    return this.#listAudit('mutation', eventId);
  }

  listUndoAudit(undoIntentId: string): HouseholdContextAuditEvent[] {
    return this.#listAudit('undo', undoIntentId);
  }

  #completeTerminalAndEnqueueResult(input: {
    jobId: number;
    eventId: string;
    status: 'applied' | 'conflict' | 'failed';
    observedRevision?: number;
    errorCode?: string;
    reply: HouseholdContextTalkReplyPayload;
    replyIdempotencyKey: string;
    now: string;
  }): void {
    timestampSchema.parse(input.now);
    if (input.errorCode !== undefined) {
      safeErrorCodeSchema.parse(input.errorCode);
    }
    if (
      input.observedRevision !== undefined &&
      (!Number.isSafeInteger(input.observedRevision) ||
        input.observedRevision < 0)
    ) {
      throw new RangeError('observedRevision must be non-negative');
    }
    const reply = talkReplyPayloadSchema.parse(input.reply);
    this.#database.transaction(() => {
      const job = this.#requiredClaimedOutbox(input.jobId);
      if (
        job.kind !== 'apply-context-mutation' ||
        job.event_id !== input.eventId
      ) {
        throw new Error('Claimed job is not this context mutation apply');
      }
      const record = this.#requiredMutation(input.eventId);
      if (
        reply.roomToken !== record.room_token ||
        reply.replyTo !== mutationFromJson(record.mutation_json).messageId
      ) {
        throw new Error('Context mutation result reply routing is invalid');
      }
      const item = this.#requiredMutationItem(input.eventId);
      if (
        input.status === 'applied' &&
        (item.before_snapshot_json === null ||
          item.after_snapshot_json === null)
      ) {
        throw new HouseholdContextSnapshotMissingError();
      }
      const transitioned = this.#database
        .prepare(
          `UPDATE household_context_mutation_items
              SET status = ?,
                  observed_revision = ?,
                  error_code = ?,
                  updated_at = ?
            WHERE event_id = ? AND status = 'processing'`,
        )
        .run(
          input.status,
          input.observedRevision ?? null,
          input.errorCode ?? null,
          input.now,
          input.eventId,
        );
      if (transitioned.changes !== 1) {
        throw new Error('Household context mutation is not processing');
      }
      this.#completeClaimedOutbox(input.jobId, input.now);
      if (record.result_reply_enabled === 1) {
        this.#enqueue(
          'send-context-mutation-result',
          input.eventId,
          undefined,
          reply,
          input.replyIdempotencyKey,
          input.now,
        );
      }
      this.#appendAudit(
        'mutation',
        input.eventId,
        `context.mutation-${input.status}`,
        {
          ...(input.observedRevision === undefined
            ? {}
            : { observedRevision: input.observedRevision }),
          ...(input.errorCode === undefined
            ? {}
            : { errorCode: input.errorCode }),
          beforeSnapshotSha256: item.before_snapshot_sha256,
          afterSnapshotSha256: item.after_snapshot_sha256,
        },
        input.now,
      );
    })();
  }

  #completeUndoTerminalAndEnqueueResult(input: {
    jobId: number;
    undoIntentId: string;
    status: 'applied' | 'conflict' | 'failed';
    observedRevision?: number;
    errorCode?: string;
    reply: HouseholdContextTalkReplyPayload;
    replyIdempotencyKey: string;
    now: string;
  }): void {
    timestampSchema.parse(input.now);
    if (input.errorCode !== undefined) {
      safeErrorCodeSchema.parse(input.errorCode);
    }
    if (
      input.observedRevision !== undefined &&
      (!Number.isSafeInteger(input.observedRevision) ||
        input.observedRevision < 0)
    ) {
      throw new RangeError('observedRevision must be non-negative');
    }
    const reply = talkReplyPayloadSchema.parse(input.reply);
    this.#database.transaction(() => {
      const job = this.#requiredClaimedOutbox(input.jobId);
      if (
        job.kind !== 'apply-context-undo' ||
        job.undo_intent_id !== input.undoIntentId
      ) {
        throw new Error('Claimed job is not this context undo apply');
      }
      const undo = this.#requiredUndoRow(input.undoIntentId);
      const original = this.#requiredMutation(undo.original_event_id);
      if (
        reply.roomToken !== original.room_token ||
        reply.replyTo !== undo.message_id
      ) {
        throw new Error('Context undo result reply routing is invalid');
      }
      if (input.status === 'applied' && undo.target_snapshot_json === null) {
        throw new HouseholdContextSnapshotMissingError();
      }
      const transitioned = this.#database
        .prepare(
          `UPDATE household_context_undo_intents
              SET status = ?,
                  observed_revision = ?,
                  error_code = ?,
                  updated_at = ?
            WHERE id = ? AND status = 'processing'`,
        )
        .run(
          input.status,
          input.observedRevision ?? null,
          input.errorCode ?? null,
          input.now,
          input.undoIntentId,
        );
      if (transitioned.changes !== 1) {
        throw new Error('Household context undo is not processing');
      }
      this.#completeClaimedOutbox(input.jobId, input.now);
      this.#enqueue(
        'send-context-undo-result',
        original.id,
        input.undoIntentId,
        reply,
        input.replyIdempotencyKey,
        input.now,
      );
      this.#appendAudit(
        'undo',
        input.undoIntentId,
        `context.undo-${input.status}`,
        {
          ...(input.observedRevision === undefined
            ? {}
            : { observedRevision: input.observedRevision }),
          ...(input.errorCode === undefined
            ? {}
            : { errorCode: input.errorCode }),
          expectedSnapshotSha256: undo.expected_snapshot_sha256,
          priorSnapshotSha256: undo.prior_snapshot_sha256,
          targetSnapshotSha256: undo.target_snapshot_sha256,
        },
        input.now,
      );
    })();
  }

  #findExistingMutation(
    idempotencyKey: string,
    mutationId: string,
  ): MutationRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM household_context_mutations
          WHERE idempotency_key = ?
             OR mutation_id = ?
          ORDER BY id
          LIMIT 1`,
      )
      .get(idempotencyKey, mutationId) as MutationRow | undefined;
  }

  #requiredMutation(eventId: string): MutationRow {
    const row = this.#database
      .prepare('SELECT * FROM household_context_mutations WHERE id = ?')
      .get(eventId) as MutationRow | undefined;
    if (row === undefined) {
      throw new Error('Unknown household context mutation');
    }
    return row;
  }

  #requiredMutationItem(eventId: string): MutationItemRow {
    const row = this.#database
      .prepare(
        'SELECT * FROM household_context_mutation_items WHERE event_id = ?',
      )
      .get(eventId) as MutationItemRow | undefined;
    if (row === undefined) {
      throw new Error('Unknown household context mutation state');
    }
    return row;
  }

  #requiredUndoRow(undoIntentId: string): UndoRow {
    const row = this.#database
      .prepare('SELECT * FROM household_context_undo_intents WHERE id = ?')
      .get(undoIntentId) as UndoRow | undefined;
    if (row === undefined) {
      throw new Error('Unknown household context undo intent');
    }
    return row;
  }

  #requiredUndo(undoIntentId: string): HouseholdContextUndoIntent {
    return toUndoIntent(this.#requiredUndoRow(undoIntentId));
  }

  #requiredClaimedOutbox(jobId: number): ClaimedOutboxRow {
    const row = this.#database
      .prepare(
        `SELECT id, idempotency_key, kind, event_id, undo_intent_id,
                payload_json, attempt_count, state
           FROM household_context_outbox
          WHERE id = ? AND state = 'processing'`,
      )
      .get(jobId) as ClaimedOutboxRow | undefined;
    if (row === undefined) {
      throw new Error('Household context outbox job is not claimed');
    }
    return row;
  }

  #transitionMutation(
    eventId: string,
    from: HouseholdContextMutationStatus,
    to: HouseholdContextMutationStatus,
    now: string,
  ): void {
    const updated = this.#database
      .prepare(
        `UPDATE household_context_mutation_items
            SET status = ?, updated_at = ?
          WHERE event_id = ? AND status = ?`,
      )
      .run(to, now, eventId, from);
    if (updated.changes !== 1) {
      throw new Error('Household context mutation state transition failed');
    }
  }

  #transitionUndo(
    undoIntentId: string,
    from: HouseholdContextMutationStatus,
    to: HouseholdContextMutationStatus,
    now: string,
  ): void {
    const updated = this.#database
      .prepare(
        `UPDATE household_context_undo_intents
            SET status = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
      )
      .run(to, now, undoIntentId, from);
    if (updated.changes !== 1) {
      throw new Error('Household context undo state transition failed');
    }
  }

  #completeClaimedOutbox(jobId: number, now: string): void {
    const updated = this.#database
      .prepare(
        `UPDATE household_context_outbox
            SET state = 'completed', completed_at = ?, locked_at = NULL
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
    if (updated.changes !== 1) {
      throw new Error('Household context outbox job is not claimed');
    }
  }

  #enqueue(
    kind: HouseholdContextOutboxKind,
    eventId: string,
    undoIntentId: string | undefined,
    payload: unknown,
    idempotencyKey: string,
    now: string,
  ): void {
    const checkedPayload = kind.startsWith('send-context-')
      ? talkReplyPayloadSchema.parse(payload)
      : payload;
    const payloadJson = serializeJson(
      checkedPayload,
      'household context outbox payload',
      16 * 1024,
    );
    const inserted = this.#database
      .prepare(
        `INSERT INTO household_context_outbox (
           idempotency_key, kind, event_id, undo_intent_id, payload_json,
           state, available_at, created_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        idempotencyKey,
        kind,
        eventId,
        undoIntentId ?? null,
        payloadJson,
        now,
        now,
      );
    if (inserted.changes === 1) {
      return;
    }
    const existing = this.#database
      .prepare(
        `SELECT kind, event_id, undo_intent_id, payload_json
           FROM household_context_outbox
          WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as
      | {
          kind: HouseholdContextOutboxKind;
          event_id: string;
          undo_intent_id: string | null;
          payload_json: string;
        }
      | undefined;
    if (
      existing === undefined ||
      existing.kind !== kind ||
      existing.event_id !== eventId ||
      existing.undo_intent_id !== (undoIntentId ?? null) ||
      existing.payload_json !== payloadJson
    ) {
      throw new HouseholdContextIdentityConflictError();
    }
  }

  #appendAudit(
    subject: 'mutation' | 'undo',
    subjectId: string,
    action: string,
    detail: unknown,
    occurredAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO household_context_audit_events (
           subject_kind, subject_id, action, detail_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        subject,
        subjectId,
        action,
        serializeJson(detail, 'household context audit detail', 32 * 1024),
        occurredAt,
      );
  }

  #listAudit(
    subject: 'mutation' | 'undo',
    subjectId: string,
  ): HouseholdContextAuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT id, subject_kind, subject_id, action, detail_json, occurred_at
           FROM household_context_audit_events
          WHERE subject_kind = ? AND subject_id = ?
          ORDER BY id`,
      )
      .all(subject, subjectId) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject_kind,
      subjectId: row.subject_id,
      action: row.action,
      detail: parseJson(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }
}
