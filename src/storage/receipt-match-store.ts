import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import {
  importedTransactionCandidateSchema,
  matchReceiptToImportedTransactions,
  receiptMatchIntentSchema,
  type ImportedTransactionCandidate,
  type ReceiptMatchIntent,
} from '../matching/receipt-transaction.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const LATEST_POSTING_DAYS_AFTER_PURCHASE = 7;
const BANK_IMPORT_GRACE_DAYS = 2;
const MATCH_RETRY_DELAYS_MS = [
  5 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
  3 * 60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  12 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
] as const;
const APPLY_RETRY_DELAYS_MS = [
  60 * 1_000,
  5 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
  3 * 60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
] as const;
const MAX_MATCH_ATTEMPTS = 20;
const MAX_APPLY_ATTEMPTS = APPLY_RETRY_DELAYS_MS.length + 1;
const MAX_AMBIGUITY_CHOICES = 20;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type ReceiptMatchStatus =
  | 'awaiting-bank-transaction'
  | 'matched'
  | 'ambiguous'
  | 'attention'
  | 'applied';

export const receiptAttentionReasons = [
  'cash',
  'bank-transaction-not-found',
  'match-retry-exhausted',
  'apply-retry-exhausted',
  'match-conflict',
  'operator-review',
  'unsupported-payment-evidence',
] as const;

export type ReceiptAttentionReason = (typeof receiptAttentionReasons)[number];

export type ReceiptMatchOutboxKind = 'match-receipt' | 'apply-receipt-match';

export interface ReceiptMatchIntakeInput {
  idempotencyKey: string;
  intent: ReceiptMatchIntent;
  receivedAt: string;
  matchRequestedAt?: string;
}

export interface ReceiptMatchRecord {
  receiptId: string;
  idempotencyKey: string;
  intent: ReceiptMatchIntent;
  status: ReceiptMatchStatus;
  expiresAt: string;
  matchAttemptCount: number;
  nextMatchAt?: string;
  attentionReason?: ReceiptAttentionReason;
  createdAt: string;
  updatedAt: string;
  matchedAt?: string;
  appliedAt?: string;
}

/**
 * Narrow receipt context for the conversational read surface. Payment
 * evidence and matching provenance are intentionally omitted.
 */
export interface AwaitingReceiptDetail {
  receiptId: string;
  sourceSha256?: string;
  merchantName: string;
  purchaseDate: string;
  currency: string;
  totalMinorUnits: number;
}

export interface ReceiptMatchOutboxJob {
  id: number;
  kind: ReceiptMatchOutboxKind;
  receiptId: string;
  attemptCount: number;
}

export interface ScoredImportedTransactionCandidate {
  candidate: ImportedTransactionCandidate;
  score: number;
}

/**
 * Safe for a user-facing ambiguity prompt. Actual transaction/imported IDs
 * are intentionally absent; the token is the only selection handle.
 */
export interface ReceiptAmbiguityChoice {
  choiceToken: string;
  accountAlias: string;
  postingDate: string;
  payeeName: string | null;
  amountMinorUnits: number;
  score: number;
  selected: boolean;
}

/**
 * Internal worker data only. Callers must never format these identifiers into
 * Talk messages; user-facing choices use ReceiptAmbiguityChoice instead.
 */
export interface ReceiptImportedTransactionLink {
  receiptId: string;
  transactionId: string;
  importedId: string;
  accountAlias: string;
  linkedAt: string;
}

export interface ReceiptMatchAuditEvent {
  id: number;
  receiptId: string;
  action: string;
  detail: unknown;
  occurredAt: string;
}

export interface ReceiptMatchAmbiguityPrompt {
  referenceId: string;
  receiptId: string;
  roomToken: string;
  botActorId: string;
  messageId: string;
  choiceTokens: readonly string[];
  deliveredAt: string;
}

export interface ReceiptMatchAmbiguityPromptCandidate {
  referenceId: string;
  receipt: ReceiptMatchRecord;
  choices: readonly ReceiptAmbiguityChoice[];
}

export interface ReceiptMatchTalkOutcomeCandidate {
  referenceId: string;
  receipt: ReceiptMatchRecord & {
    status: 'attention' | 'applied';
  };
}

export interface ReceiptMatchAmbiguityResolution {
  referenceId: string;
  receiptId: string;
  roomToken: string;
  actorId: string;
  inboundMessageId: string;
  parentBotId: string;
  parentMessageId: string;
  selection: number;
  choiceToken: string;
  resolvedAt: string;
}

export type ReceiptMatchRetryResult =
  | {
      status: 'awaiting-bank-transaction';
      nextMatchAt: string;
    }
  | {
      status: 'attention';
      reason: 'bank-transaction-not-found' | 'match-retry-exhausted';
    };

export type ReceiptApplyRetryResult =
  | {
      status: 'matched';
      nextAttemptAt: string;
    }
  | {
      status: 'attention';
      reason: 'apply-retry-exhausted';
    };

export type IgnoreReceiptMatchResult =
  | { readonly status: 'ignored' | 'already-ignored' }
  | { readonly status: 'already-applied' | 'still-processing' };

interface ReceiptMatchRow {
  receipt_id: string;
  idempotency_key: string;
  intent_json: string;
  status: ReceiptMatchStatus;
  expires_at: string;
  match_attempt_count: number;
  next_match_at: string | null;
  attention_reason: ReceiptAttentionReason | null;
  created_at: string;
  updated_at: string;
  matched_at: string | null;
  applied_at: string | null;
}

interface ReceiptMatchOutboxRow {
  id: number;
  kind: ReceiptMatchOutboxKind;
  receipt_id: string;
  state: 'pending' | 'processing' | 'completed' | 'failed';
  attempt_count: number;
  available_at: string;
}

interface ReceiptMatchLinkRow {
  receipt_id: string;
  transaction_id: string;
  imported_id: string;
  account_alias: string;
  linked_at: string;
}

interface ReceiptAmbiguityChoiceRow {
  choice_token: string;
  receipt_id: string;
  transaction_id: string;
  imported_id: string;
  account_alias: string;
  posting_date: string;
  payee_name: string | null;
  amount_minor_units: number;
  score: number;
  selected_at: string | null;
}

interface ReceiptMatchAuditRow {
  id: number;
  receipt_id: string;
  action: string;
  detail_json: string;
  occurred_at: string;
}

interface ReceiptAmbiguityPromptRow {
  reference_id: string;
  receipt_id: string;
  room_token: string;
  bot_actor_id: string;
  message_id: string;
  choice_tokens_json: string;
  delivered_at: string;
}

interface ReceiptAmbiguityResolutionRow {
  reference_id: string;
  receipt_id: string;
  room_token: string;
  actor_id: string;
  inbound_message_id: string;
  parent_bot_id: string;
  parent_message_id: string;
  selection: number;
  choice_token: string;
  resolved_at: string;
}

const receiptMatchSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS receipt_match_items (
    receipt_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    intent_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'awaiting-bank-transaction',
        'matched',
        'ambiguous',
        'attention',
        'applied'
      )
    ),
    expires_at TEXT NOT NULL,
    match_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
      match_attempt_count BETWEEN 0 AND ${String(MAX_MATCH_ATTEMPTS)}
    ),
    next_match_at TEXT,
    attention_reason TEXT CHECK (
      attention_reason IS NULL OR attention_reason IN (
        'cash',
        'bank-transaction-not-found',
        'match-retry-exhausted',
        'apply-retry-exhausted',
        'match-conflict',
        'operator-review',
        'unsupported-payment-evidence'
      )
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    matched_at TEXT,
    applied_at TEXT,
    CHECK (
      (status = 'awaiting-bank-transaction'
        AND attention_reason IS NULL
        AND matched_at IS NULL
        AND applied_at IS NULL)
      OR
      (status = 'ambiguous'
        AND next_match_at IS NULL
        AND attention_reason IS NULL
        AND matched_at IS NULL
        AND applied_at IS NULL)
      OR
      (status = 'matched'
        AND next_match_at IS NULL
        AND attention_reason IS NULL
        AND matched_at IS NOT NULL
        AND applied_at IS NULL)
      OR
      (status = 'attention'
        AND next_match_at IS NULL
        AND attention_reason IS NOT NULL
        AND applied_at IS NULL)
      OR
      (status = 'applied'
        AND next_match_at IS NULL
        AND attention_reason IS NULL
        AND matched_at IS NOT NULL
        AND applied_at IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS receipt_match_items_due
    ON receipt_match_items(status, next_match_at, expires_at, receipt_id);

  CREATE TABLE IF NOT EXISTS receipt_match_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN ('match-receipt', 'apply-receipt-match')
    ),
    receipt_id TEXT NOT NULL REFERENCES receipt_match_items(receipt_id),
    payload_json TEXT NOT NULL CHECK (payload_json = '{}'),
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'processing', 'completed', 'failed')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    locked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS receipt_match_outbox_one_open_kind
    ON receipt_match_outbox(receipt_id, kind)
    WHERE state IN ('pending', 'processing');

  CREATE INDEX IF NOT EXISTS receipt_match_outbox_due
    ON receipt_match_outbox(kind, state, available_at, id);

  CREATE TABLE IF NOT EXISTS receipt_imported_transaction_links (
    receipt_id TEXT NOT NULL REFERENCES receipt_match_items(receipt_id),
    transaction_id TEXT NOT NULL,
    imported_id TEXT NOT NULL,
    account_alias TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY(receipt_id, transaction_id),
    UNIQUE(receipt_id, account_alias, imported_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_imported_link_no_update
  BEFORE UPDATE ON receipt_imported_transaction_links
  BEGIN
    SELECT RAISE(ABORT, 'receipt imported-transaction links are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_match_ambiguity_choices (
    choice_token TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipt_match_items(receipt_id),
    transaction_id TEXT NOT NULL,
    imported_id TEXT NOT NULL,
    account_alias TEXT NOT NULL,
    posting_date TEXT NOT NULL,
    payee_name TEXT,
    amount_minor_units INTEGER NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10000),
    selected_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(receipt_id, transaction_id),
    UNIQUE(receipt_id, account_alias, imported_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_match_choice_identity_immutable
  BEFORE UPDATE OF
    choice_token,
    receipt_id,
    transaction_id,
    imported_id,
    account_alias,
    posting_date,
    payee_name,
    amount_minor_units,
    score,
    created_at
  ON receipt_match_ambiguity_choices
  BEGIN
    SELECT RAISE(ABORT, 'receipt ambiguity choice identity is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_match_choice_selected_once
  BEFORE UPDATE OF selected_at ON receipt_match_ambiguity_choices
  WHEN OLD.selected_at IS NOT NULL OR NEW.selected_at IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'receipt ambiguity choice can only be selected once');
  END;

  CREATE TABLE IF NOT EXISTS receipt_match_ambiguity_prompts (
    reference_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE
      REFERENCES receipt_match_items(receipt_id),
    room_token TEXT NOT NULL,
    bot_actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    choice_tokens_json TEXT NOT NULL CHECK (
      length(CAST(choice_tokens_json AS BLOB)) <= 4096
    ),
    delivered_at TEXT NOT NULL,
    UNIQUE(room_token, message_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_match_prompt_no_update
  BEFORE UPDATE ON receipt_match_ambiguity_prompts
  BEGIN
    SELECT RAISE(ABORT, 'receipt match ambiguity prompts are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_match_ambiguity_resolutions (
    reference_id TEXT PRIMARY KEY
      REFERENCES receipt_match_ambiguity_prompts(reference_id),
    receipt_id TEXT NOT NULL UNIQUE
      REFERENCES receipt_match_items(receipt_id),
    room_token TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL,
    parent_bot_id TEXT NOT NULL,
    parent_message_id TEXT NOT NULL,
    selection INTEGER NOT NULL CHECK (selection BETWEEN 1 AND 10),
    choice_token TEXT NOT NULL,
    resolved_at TEXT NOT NULL,
    UNIQUE(room_token, inbound_message_id)
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_match_resolution_no_update
  BEFORE UPDATE ON receipt_match_ambiguity_resolutions
  BEGIN
    SELECT RAISE(ABORT, 'receipt match ambiguity resolutions are immutable');
  END;

  CREATE TABLE IF NOT EXISTS receipt_match_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL REFERENCES receipt_match_items(receipt_id),
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS receipt_match_ignores (
    receipt_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL UNIQUE,
    ignored_at TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS receipt_match_ignore_no_update
  BEFORE UPDATE ON receipt_match_ignores
  BEGIN
    SELECT RAISE(ABORT, 'receipt match ignore is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_match_ignore_no_delete
  BEFORE DELETE ON receipt_match_ignores
  BEGIN
    SELECT RAISE(ABORT, 'receipt match ignore is immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_match_audit_no_update
  BEFORE UPDATE ON receipt_match_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'receipt match audit events are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS receipt_match_audit_no_delete
  BEFORE DELETE ON receipt_match_audit_events
  BEGIN
    SELECT RAISE(ABORT, 'receipt match audit events are append-only');
  END;
`;

export class ReceiptMatchStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptMatchStoreConflictError';
  }
}

export class ReceiptMatchStoreBusyError extends Error {
  constructor() {
    super('Receipt match work is already processing');
    this.name = 'ReceiptMatchStoreBusyError';
  }
}

export class ReceiptMatchIgnoredError extends Error {
  constructor() {
    super('Receipt was ignored by the household');
    this.name = 'ReceiptMatchIgnoredError';
  }
}

function normalizedInstant(value: string, name: string): string {
  if (!ISO_INSTANT_PATTERN.test(value)) {
    throw new TypeError(`${name} must be an ISO-8601 instant with an offset`);
  }
  const datePart = value.slice(0, 10);
  const parsedDate = new Date(`${datePart}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== datePart
  ) {
    throw new TypeError(`${name} must contain a valid calendar date`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new TypeError(`${name} must be a valid ISO-8601 instant`);
  }
  return date.toISOString();
}

/**
 * Matching accepts postings through purchase day +7. Keep the receipt active
 * for two additional calendar days so a daily bank feed plus the configured
 * polling interval can still reveal a transaction inside that window. A
 * clearly future OCR date gets one immediate check instead of extending the
 * queue into the future.
 */
function receiptPostingWindowExpiresAt(
  purchaseDate: string,
  receivedAt: string,
): string {
  const purchaseDay = Date.parse(`${purchaseDate}T00:00:00.000Z`);
  const receivedDay = Date.parse(`${receivedAt.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(purchaseDay)) {
    throw new TypeError('purchaseDate must contain a valid calendar date');
  }
  if (purchaseDay > receivedDay + MILLISECONDS_PER_DAY) {
    return receivedAt;
  }
  return new Date(
    purchaseDay +
      (LATEST_POSTING_DAYS_AFTER_PURCHASE + BANK_IMPORT_GRACE_DAYS + 1) *
        MILLISECONDS_PER_DAY,
  ).toISOString();
}

function boundedText(value: string, maximum: number, name: string): string {
  const normalized = value.normalize('NFC').trim();
  const unsafe = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (normalized.length === 0 || normalized.length > maximum || unsafe) {
    throw new RangeError(
      `${name} must contain between 1 and ${String(maximum)} safe characters`,
    );
  }
  return normalized;
}

function errorCode(value: string): string {
  const normalized = boundedText(value, 64, 'errorCode');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new TypeError('errorCode must be a lowercase kebab-case token');
  }
  return normalized;
}

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

function toRecord(row: ReceiptMatchRow): ReceiptMatchRecord {
  return {
    receiptId: row.receipt_id,
    idempotencyKey: row.idempotency_key,
    intent: receiptMatchIntentSchema.parse(parseJson(row.intent_json)),
    status: row.status,
    expiresAt: row.expires_at,
    matchAttemptCount: row.match_attempt_count,
    ...(row.next_match_at === null ? {} : { nextMatchAt: row.next_match_at }),
    ...(row.attention_reason === null
      ? {}
      : { attentionReason: row.attention_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.matched_at === null ? {} : { matchedAt: row.matched_at }),
    ...(row.applied_at === null ? {} : { appliedAt: row.applied_at }),
  };
}

function toLink(row: ReceiptMatchLinkRow): ReceiptImportedTransactionLink {
  return {
    receiptId: row.receipt_id,
    transactionId: row.transaction_id,
    importedId: row.imported_id,
    accountAlias: row.account_alias,
    linkedAt: row.linked_at,
  };
}

function toSafeChoice(row: ReceiptAmbiguityChoiceRow): ReceiptAmbiguityChoice {
  return {
    choiceToken: row.choice_token,
    accountAlias: row.account_alias,
    postingDate: row.posting_date,
    payeeName: row.payee_name,
    amountMinorUnits: row.amount_minor_units,
    score: row.score,
    selected: row.selected_at !== null,
  };
}

function candidateKey(candidate: ImportedTransactionCandidate): string {
  return `${candidate.transactionId}\u0000${candidate.accountAlias}\u0000${candidate.importedId}`;
}

function candidateLinksReceipt(
  candidate: ImportedTransactionCandidate,
  receiptId: string,
): boolean {
  return candidate.alreadyLinkedReceipts.some(
    (link) => link.receiptId === receiptId,
  );
}

function linkRowKey(link: ReceiptMatchLinkRow): string {
  return `${link.transaction_id}\u0000${link.account_alias}\u0000${link.imported_id}`;
}

function validatedScore(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError('Candidate score must be an integer from 0 to 10000');
  }
  return value;
}

function choiceToken(): string {
  return `match_${randomBytes(24).toString('base64url')}`;
}

function validatedChoiceToken(value: string): string {
  const token = boundedText(value, 80, 'choiceToken');
  if (!/^match_[A-Za-z0-9_-]{32}$/.test(token)) {
    throw new TypeError('choiceToken must be an opaque match token');
  }
  return token;
}

function validatedReferenceId(value: string): string {
  const referenceId = boundedText(value, 64, 'referenceId');
  if (!/^[a-f0-9]{64}$/.test(referenceId)) {
    throw new TypeError('referenceId must be a SHA-256 digest');
  }
  return referenceId;
}

function validatedBotActorId(value: string): string {
  const botActorId = boundedText(value, 80, 'botActorId');
  if (!/^bots\/bot-[a-f0-9]{40}$/.test(botActorId)) {
    throw new TypeError('botActorId must be a full Talk bot actor ID');
  }
  return botActorId;
}

function promptFromRow(
  row: ReceiptAmbiguityPromptRow,
): ReceiptMatchAmbiguityPrompt {
  const choiceTokens = JSON.parse(row.choice_tokens_json) as unknown;
  if (
    !Array.isArray(choiceTokens) ||
    choiceTokens.length < 1 ||
    choiceTokens.length > 10
  ) {
    throw new Error('Persisted receipt ambiguity prompt choices are invalid');
  }
  return {
    referenceId: validatedReferenceId(row.reference_id),
    receiptId: row.receipt_id,
    roomToken: boundedText(row.room_token, 500, 'roomToken'),
    botActorId: validatedBotActorId(row.bot_actor_id),
    messageId: boundedText(row.message_id, 500, 'messageId'),
    choiceTokens: choiceTokens.map((token) =>
      validatedChoiceToken(String(token)),
    ),
    deliveredAt: normalizedInstant(row.delivered_at, 'deliveredAt'),
  };
}

function resolutionFromRow(
  row: ReceiptAmbiguityResolutionRow,
): ReceiptMatchAmbiguityResolution {
  return {
    referenceId: validatedReferenceId(row.reference_id),
    receiptId: row.receipt_id,
    roomToken: boundedText(row.room_token, 500, 'roomToken'),
    actorId: boundedText(row.actor_id, 500, 'actorId'),
    inboundMessageId: boundedText(
      row.inbound_message_id,
      500,
      'inboundMessageId',
    ),
    parentBotId: validatedBotActorId(row.parent_bot_id),
    parentMessageId: boundedText(row.parent_message_id, 500, 'parentMessageId'),
    selection: row.selection,
    choiceToken: validatedChoiceToken(row.choice_token),
    resolvedAt: normalizedInstant(row.resolved_at, 'resolvedAt'),
  };
}

export function createReceiptMatchReferenceId(receiptId: string): string {
  return createHash('sha256')
    .update('receipt-match-talk-reply-v1\0')
    .update(boundedText(receiptId, 200, 'receiptId'))
    .digest('hex');
}

export function createReceiptMatchOutcomeReferenceId(
  receiptId: string,
  status: 'attention' | 'applied',
): string {
  return createHash('sha256')
    .update('receipt-match-talk-outcome-v1\0')
    .update(boundedText(receiptId, 200, 'receiptId'))
    .update('\0')
    .update(status)
    .digest('hex');
}

/**
 * Durable orchestration for matching an extracted receipt to an already
 * imported transaction. This store has no transaction-creation operation.
 */
export class ReceiptMatchStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new Database(databasePath);
    this.#database.exec(receiptMatchSchema);
  }

  close(): void {
    this.#database.close();
  }

  recordReceipt(input: ReceiptMatchIntakeInput): {
    receipt: ReceiptMatchRecord;
    inserted: boolean;
  } {
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      500,
      'idempotencyKey',
    );
    const intent = receiptMatchIntentSchema.parse(input.intent);
    const receivedAt = normalizedInstant(input.receivedAt, 'receivedAt');
    const matchRequestedAt = normalizedInstant(
      input.matchRequestedAt ?? receivedAt,
      'matchRequestedAt',
    );
    if (matchRequestedAt < receivedAt) {
      throw new RangeError(
        'Receipt matching cannot start before receipt intake',
      );
    }
    const intentJson = serializeJson(intent, 'receipt match intent');
    const expiresAt = receiptPostingWindowExpiresAt(
      intent.purchaseDate,
      receivedAt,
    );

    return this.#database.transaction(() => {
      const ignored = this.#database
        .prepare(
          `SELECT 1
             FROM receipt_match_ignores
            WHERE receipt_id = ?
            LIMIT 1`,
        )
        .get(intent.receiptId);
      const byKey = this.#database
        .prepare(
          `SELECT *
             FROM receipt_match_items
            WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as ReceiptMatchRow | undefined;
      if (byKey !== undefined) {
        if (
          byKey.receipt_id !== intent.receiptId ||
          byKey.intent_json !== intentJson
        ) {
          throw new ReceiptMatchStoreConflictError(
            'Receipt match idempotency key was reused with different input',
          );
        }
        return { receipt: toRecord(byKey), inserted: false };
      }
      if (ignored !== undefined) {
        throw new ReceiptMatchIgnoredError();
      }

      const byReceipt = this.#getReceiptRow(intent.receiptId);
      if (byReceipt !== undefined) {
        const processing = this.#database
          .prepare(
            `SELECT 1
               FROM receipt_match_outbox
              WHERE receipt_id = ? AND state = 'processing'
              LIMIT 1`,
          )
          .get(intent.receiptId);
        if (processing !== undefined) {
          throw new ReceiptMatchStoreBusyError();
        }
        const links = this.#getLinkRows(intent.receiptId);
        const applyJob = this.#database
          .prepare(
            `SELECT state, attempt_count, last_error
               FROM receipt_match_outbox
              WHERE receipt_id = ?
                AND kind = 'apply-receipt-match'
              ORDER BY id DESC
              LIMIT 1`,
          )
          .get(intent.receiptId) as
          | {
              state: 'pending' | 'processing' | 'completed' | 'failed';
              attempt_count: number;
              last_error: string | null;
            }
          | undefined;
        const safeProvisionalMatch =
          byReceipt.status === 'matched' &&
          applyJob?.state === 'pending' &&
          applyJob.attempt_count === 0 &&
          applyJob.last_error !== 'actual-update-pending';
        if (
          byReceipt.status === 'applied' ||
          (links.length > 0 && !safeProvisionalMatch)
        ) {
          throw new ReceiptMatchStoreConflictError(
            'A receipt revision arrived after its Actual update started',
          );
        }
        this.#database
          .prepare(
            `UPDATE receipt_match_outbox
                SET state = 'failed',
                    locked_at = NULL,
                    last_error = 'superseded-by-receipt-revision'
              WHERE receipt_id = ? AND state = 'pending'`,
          )
          .run(intent.receiptId);
        this.#database
          .prepare(
            `DELETE FROM receipt_match_ambiguity_resolutions
              WHERE receipt_id = ?`,
          )
          .run(intent.receiptId);
        this.#database
          .prepare(
            `DELETE FROM receipt_match_ambiguity_prompts
              WHERE receipt_id = ?`,
          )
          .run(intent.receiptId);
        this.#database
          .prepare(
            `DELETE FROM receipt_match_ambiguity_choices
              WHERE receipt_id = ?`,
          )
          .run(intent.receiptId);
        this.#database
          .prepare(
            `DELETE FROM receipt_imported_transaction_links
              WHERE receipt_id = ?`,
          )
          .run(intent.receiptId);
        const updated = this.#database
          .prepare(
            `UPDATE receipt_match_items
                SET idempotency_key = ?,
                    intent_json = ?,
                    status = 'awaiting-bank-transaction',
                    expires_at = ?,
                    match_attempt_count = 0,
                    next_match_at = ?,
                    attention_reason = NULL,
                    updated_at = ?,
                    matched_at = NULL,
                    applied_at = NULL
              WHERE receipt_id = ?`,
          )
          .run(
            idempotencyKey,
            intentJson,
            expiresAt,
            matchRequestedAt,
            matchRequestedAt,
            intent.receiptId,
          );
        if (updated.changes !== 1) {
          throw new Error('Receipt match revision was not persisted');
        }
        this.#enqueue(
          'match-receipt',
          intent.receiptId,
          `receipt-match:${idempotencyKey}`,
          matchRequestedAt,
          matchRequestedAt,
        );
        this.#appendAudit(
          intent.receiptId,
          'receipt-match.intake-revised',
          {
            previousIdempotencyKey: byReceipt.idempotency_key,
            previousStatus: byReceipt.status,
            supersededLinkCount: links.length,
            idempotencyKey,
            expiresAt,
            sourceReceivedAt: receivedAt,
            matchRequestedAt,
          },
          matchRequestedAt,
        );
        const revised = this.#getReceiptRow(intent.receiptId);
        if (revised === undefined) {
          throw new Error('Receipt match revision was not persisted');
        }
        return { receipt: toRecord(revised), inserted: true };
      }

      this.#database
        .prepare(
          `INSERT INTO receipt_match_items (
             receipt_id,
             idempotency_key,
             intent_json,
             status,
             expires_at,
             match_attempt_count,
             next_match_at,
             created_at,
             updated_at
           ) VALUES (
             ?, ?, ?, 'awaiting-bank-transaction', ?, 0, ?, ?, ?
           )`,
        )
        .run(
          intent.receiptId,
          idempotencyKey,
          intentJson,
          expiresAt,
          matchRequestedAt,
          receivedAt,
          matchRequestedAt,
        );
      this.#enqueue(
        'match-receipt',
        intent.receiptId,
        `receipt-match:${idempotencyKey}`,
        matchRequestedAt,
        matchRequestedAt,
      );
      this.#appendAudit(
        intent.receiptId,
        'receipt-match.intake-recorded',
        {
          expiresAt,
          initialStatus: 'awaiting-bank-transaction',
          sourceReceivedAt: receivedAt,
          matchRequestedAt,
        },
        matchRequestedAt,
      );

      const row = this.#getReceiptRow(intent.receiptId);
      if (row === undefined) {
        throw new Error('Receipt match intake was not persisted');
      }
      return { receipt: toRecord(row), inserted: true };
    })();
  }

  getReceipt(receiptId: string): ReceiptMatchRecord | undefined {
    const row = this.#getReceiptRow(receiptId);
    return row === undefined ? undefined : toRecord(row);
  }

  isReceiptIgnored(receiptIdInput: string): boolean {
    const receiptId = boundedText(receiptIdInput, 200, 'receiptId');
    return this.#isIgnored(receiptId);
  }

  ignoreReceipt(input: {
    readonly receiptId: string;
    readonly actorId: string;
    readonly inboundMessageId: string;
    readonly ignoredAt: string;
  }): IgnoreReceiptMatchResult {
    const receiptId = boundedText(input.receiptId, 200, 'receiptId');
    const actorId = boundedText(input.actorId, 200, 'actorId');
    const inboundMessageId = boundedText(
      input.inboundMessageId,
      500,
      'inboundMessageId',
    );
    const ignoredAt = normalizedInstant(input.ignoredAt, 'ignoredAt');
    return this.#database.transaction((): IgnoreReceiptMatchResult => {
      const existing = this.#database
        .prepare(
          `SELECT receipt_id
             FROM receipt_match_ignores
            WHERE receipt_id = ? OR inbound_message_id = ?
            LIMIT 1`,
        )
        .get(receiptId, inboundMessageId) as { receipt_id: string } | undefined;
      if (existing !== undefined) {
        if (existing.receipt_id !== receiptId) {
          throw new ReceiptMatchStoreConflictError(
            'Receipt ignore message was reused for another receipt',
          );
        }
        return { status: 'already-ignored' };
      }
      const receipt = this.#getReceiptRow(receiptId);
      if (receipt?.status === 'applied') {
        return { status: 'already-applied' };
      }
      if (receipt?.status === 'matched') {
        return { status: 'still-processing' };
      }
      const processing =
        receipt === undefined
          ? undefined
          : this.#database
              .prepare(
                `SELECT 1
                   FROM receipt_match_outbox
                  WHERE receipt_id = ? AND state = 'processing'
                  LIMIT 1`,
              )
              .get(receiptId);
      if (processing !== undefined) {
        return { status: 'still-processing' };
      }
      this.#database
        .prepare(
          `INSERT INTO receipt_match_ignores (
             receipt_id, actor_id, inbound_message_id, ignored_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(receiptId, actorId, inboundMessageId, ignoredAt);
      if (receipt !== undefined) {
        this.#database
          .prepare(
            `UPDATE receipt_match_outbox
                SET state = 'failed',
                    locked_at = NULL,
                    last_error = 'receipt-ignored'
              WHERE receipt_id = ? AND state = 'pending'`,
          )
          .run(receiptId);
        this.#appendAudit(
          receiptId,
          'receipt-match.ignored',
          { actorId, inboundMessageId },
          ignoredAt,
        );
      }
      return { status: 'ignored' };
    })();
  }

  isImportedTransactionReserved(
    accountAliasInput: string,
    importedIdInput: string,
  ): boolean {
    const accountAlias = boundedText(accountAliasInput, 64, 'accountAlias');
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(accountAlias)) {
      throw new TypeError('accountAlias is invalid');
    }
    const importedId = boundedText(importedIdInput, 500, 'importedId');
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM receipt_imported_transaction_links AS link
            WHERE link.account_alias = ?
              AND link.imported_id = ?
              AND NOT EXISTS (
                SELECT 1
                  FROM receipt_match_ignores AS ignored
                 WHERE ignored.receipt_id = link.receipt_id
              )
            LIMIT 1`,
        )
        .get(accountAlias, importedId) !== undefined
    );
  }

  pendingReceiptSummary(nowInput = new Date().toISOString()): {
    count: number;
    totalMinorUnits: number;
  } {
    const now = normalizedInstant(nowInput, 'now');
    const rows = this.#database
      .prepare(
        `SELECT intent_json
           FROM receipt_match_items
          WHERE status = 'awaiting-bank-transaction'
            AND expires_at > ?
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_ignores AS ignored
               WHERE ignored.receipt_id = receipt_match_items.receipt_id
            )`,
      )
      .all(now) as Array<{ intent_json: string }>;
    const total = rows.reduce((sum, row) => {
      const intent = receiptMatchIntentSchema.parse(parseJson(row.intent_json));
      return intent.currency === 'CAD'
        ? sum + BigInt(intent.totalMinorUnits)
        : sum + BigInt(intent.totalMinorUnits) * 3n;
    }, 0n);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('Pending receipt total is outside the safe range');
    }
    return { count: rows.length, totalMinorUnits: Number(total) };
  }

  listAwaitingReceiptDetails(
    limit = 10,
    nowInput = new Date().toISOString(),
  ): AwaitingReceiptDetail[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('Pending receipt detail limit is outside bounds');
    }
    const now = normalizedInstant(nowInput, 'now');
    const rows = this.#database
      .prepare(
        `SELECT idempotency_key, intent_json
           FROM receipt_match_items
          WHERE status = 'awaiting-bank-transaction'
            AND expires_at > ?
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_ignores AS ignored
               WHERE ignored.receipt_id = receipt_match_items.receipt_id
            )
          ORDER BY created_at, receipt_id
          LIMIT ?`,
      )
      .all(now, limit) as Array<{
      idempotency_key: string;
      intent_json: string;
    }>;
    return rows.map((row) => {
      const intent = receiptMatchIntentSchema.parse(parseJson(row.intent_json));
      const sourcePrefix = 'receipt-source-sha256:';
      const sourceSha256 = row.idempotency_key.startsWith(sourcePrefix)
        ? row.idempotency_key.slice(sourcePrefix.length)
        : undefined;
      return {
        receiptId: intent.receiptId,
        ...(sourceSha256 !== undefined && /^[a-f0-9]{64}$/.test(sourceSha256)
          ? { sourceSha256 }
          : {}),
        merchantName: intent.merchantName,
        purchaseDate: intent.purchaseDate,
        currency: intent.currency,
        totalMinorUnits: intent.totalMinorUnits,
      };
    });
  }

  claimNextDueMatch(nowInput: string): ReceiptMatchOutboxJob | undefined {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction((): ReceiptMatchOutboxJob | undefined => {
      this.#expireAwaiting(now);
      while (true) {
        const row = this.#database
          .prepare(
            `SELECT outbox.id,
                    outbox.kind,
                    outbox.receipt_id,
                    outbox.state,
                    outbox.attempt_count,
                    outbox.available_at
               FROM receipt_match_outbox AS outbox
               JOIN receipt_match_items AS item
                 ON item.receipt_id = outbox.receipt_id
              WHERE outbox.kind = 'match-receipt'
                AND outbox.state = 'pending'
                AND outbox.available_at <= ?
                AND item.status = 'awaiting-bank-transaction'
                AND NOT EXISTS (
                  SELECT 1
                    FROM receipt_match_ignores AS ignored
                   WHERE ignored.receipt_id = item.receipt_id
                )
              ORDER BY outbox.available_at, outbox.id
              LIMIT 1`,
          )
          .get(now) as ReceiptMatchOutboxRow | undefined;
        if (row === undefined) {
          return undefined;
        }
        if (row.attempt_count >= MAX_MATCH_ATTEMPTS) {
          this.#pendingJobToAttention(
            row.id,
            row.receipt_id,
            'match-retry-exhausted',
            now,
          );
          continue;
        }
        const claimed = this.#database
          .prepare(
            `UPDATE receipt_match_outbox
                SET state = 'processing',
                    attempt_count = attempt_count + 1,
                    locked_at = ?
              WHERE id = ? AND state = 'pending'`,
          )
          .run(now, row.id);
        if (claimed.changes !== 1) {
          continue;
        }
        const attemptCount = row.attempt_count + 1;
        const updated = this.#database
          .prepare(
            `UPDATE receipt_match_items
                SET next_match_at = NULL,
                    updated_at = ?
              WHERE receipt_id = ?
                AND status = 'awaiting-bank-transaction'`,
          )
          .run(now, row.receipt_id);
        if (updated.changes !== 1) {
          throw new Error('Claimed receipt is not awaiting a bank transaction');
        }
        this.#appendAudit(
          row.receipt_id,
          'receipt-match.attempt-claimed',
          { attemptCount },
          now,
        );
        return {
          id: row.id,
          kind: 'match-receipt',
          receiptId: row.receipt_id,
          attemptCount,
        };
      }
    })();
  }

  claimNextDueApply(nowInput: string): ReceiptMatchOutboxJob | undefined {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction((): ReceiptMatchOutboxJob | undefined => {
      while (true) {
        const row = this.#database
          .prepare(
            `SELECT outbox.id,
                    outbox.kind,
                    outbox.receipt_id,
                    outbox.state,
                    outbox.attempt_count,
                    outbox.available_at
               FROM receipt_match_outbox AS outbox
               JOIN receipt_match_items AS item
                 ON item.receipt_id = outbox.receipt_id
              WHERE outbox.kind = 'apply-receipt-match'
                AND outbox.state = 'pending'
                AND outbox.available_at <= ?
                AND item.status = 'matched'
                AND NOT EXISTS (
                  SELECT 1
                    FROM receipt_match_ignores AS ignored
                   WHERE ignored.receipt_id = item.receipt_id
                )
              ORDER BY outbox.available_at, outbox.id
              LIMIT 1`,
          )
          .get(now) as ReceiptMatchOutboxRow | undefined;
        if (row === undefined) {
          return undefined;
        }
        if (row.attempt_count >= MAX_APPLY_ATTEMPTS) {
          this.#pendingJobToAttention(
            row.id,
            row.receipt_id,
            'apply-retry-exhausted',
            now,
          );
          continue;
        }
        const claimed = this.#database
          .prepare(
            `UPDATE receipt_match_outbox
                SET state = 'processing',
                    attempt_count = attempt_count + 1,
                    locked_at = ?
              WHERE id = ? AND state = 'pending'`,
          )
          .run(now, row.id);
        if (claimed.changes !== 1) {
          continue;
        }
        const attemptCount = row.attempt_count + 1;
        this.#appendAudit(
          row.receipt_id,
          'receipt-match.apply-attempt-claimed',
          { attemptCount },
          now,
        );
        return {
          id: row.id,
          kind: 'apply-receipt-match',
          receiptId: row.receipt_id,
          attemptCount,
        };
      }
    })();
  }

  rescheduleAwaitingMatch(
    jobId: number,
    receiptId: string,
    nowInput: string,
    untrustedErrorCode = 'no-plausible-candidate',
  ): ReceiptMatchRetryResult {
    const now = normalizedInstant(nowInput, 'now');
    const lastError = errorCode(untrustedErrorCode);
    return this.#database.transaction((): ReceiptMatchRetryResult => {
      this.#claimedJob(jobId, receiptId, 'match-receipt');
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== 'awaiting-bank-transaction') {
        throw new Error('Receipt is not awaiting a bank transaction');
      }
      if (now >= receipt.expires_at) {
        this.#claimedJobToAttention(
          jobId,
          receiptId,
          'bank-transaction-not-found',
          now,
        );
        return {
          status: 'attention',
          reason: 'bank-transaction-not-found',
        };
      }
      const successfulNoCandidateCount = Math.min(
        receipt.match_attempt_count + 1,
        MAX_MATCH_ATTEMPTS,
      );
      const delay =
        MATCH_RETRY_DELAYS_MS[successfulNoCandidateCount - 1] ??
        Math.max(0, Date.parse(receipt.expires_at) - Date.parse(now));
      const nextMatchAt = new Date(
        Math.min(Date.parse(now) + delay, Date.parse(receipt.expires_at)),
      ).toISOString();
      if (nextMatchAt <= now) {
        this.#claimedJobToAttention(
          jobId,
          receiptId,
          'bank-transaction-not-found',
          now,
        );
        return {
          status: 'attention',
          reason: 'bank-transaction-not-found',
        };
      }

      const outbox = this.#database
        .prepare(
          `UPDATE receipt_match_outbox
              SET state = 'pending',
                  attempt_count = 0,
                  available_at = ?,
                  locked_at = NULL,
                  last_error = ?
            WHERE id = ?
              AND receipt_id = ?
              AND kind = 'match-receipt'
              AND state = 'processing'`,
        )
        .run(nextMatchAt, lastError, jobId, receiptId);
      if (outbox.changes !== 1) {
        throw new Error('Receipt match outbox job is not claimed');
      }
      const item = this.#database
        .prepare(
          `UPDATE receipt_match_items
              SET match_attempt_count = ?,
                  next_match_at = ?,
                  updated_at = ?
            WHERE receipt_id = ?
              AND status = 'awaiting-bank-transaction'`,
        )
        .run(successfulNoCandidateCount, nextMatchAt, now, receiptId);
      if (item.changes !== 1) {
        throw new Error('Receipt match retry state could not be persisted');
      }
      this.#appendAudit(
        receiptId,
        'receipt-match.retry-scheduled',
        {
          attemptCount: successfulNoCandidateCount,
          nextMatchAt,
          errorCode: lastError,
        },
        now,
      );
      return { status: 'awaiting-bank-transaction', nextMatchAt };
    })();
  }

  retryMatch(
    jobId: number,
    receiptId: string,
    untrustedErrorCode: string,
    nowInput: string,
  ): ReceiptMatchRetryResult {
    const now = normalizedInstant(nowInput, 'now');
    const lastError = errorCode(untrustedErrorCode);
    return this.#database.transaction((): ReceiptMatchRetryResult => {
      const job = this.#claimedJob(jobId, receiptId, 'match-receipt');
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== 'awaiting-bank-transaction') {
        throw new Error('Receipt is not awaiting a bank transaction');
      }
      if (now >= receipt.expires_at) {
        this.#claimedJobToAttention(
          jobId,
          receiptId,
          'bank-transaction-not-found',
          now,
        );
        return {
          status: 'attention',
          reason: 'bank-transaction-not-found',
        };
      }
      if (job.attempt_count >= MAX_MATCH_ATTEMPTS) {
        this.#claimedJobToAttention(
          jobId,
          receiptId,
          'match-retry-exhausted',
          now,
        );
        return {
          status: 'attention',
          reason: 'match-retry-exhausted',
        };
      }
      const delay =
        MATCH_RETRY_DELAYS_MS[job.attempt_count - 1] ??
        MATCH_RETRY_DELAYS_MS.at(-1)!;
      const nextMatchAt = new Date(
        Math.min(Date.parse(now) + delay, Date.parse(receipt.expires_at)),
      ).toISOString();
      const outbox = this.#database
        .prepare(
          `UPDATE receipt_match_outbox
              SET state = 'pending',
                  available_at = ?,
                  locked_at = NULL,
                  last_error = ?
            WHERE id = ?
              AND receipt_id = ?
              AND kind = 'match-receipt'
              AND state = 'processing'`,
        )
        .run(nextMatchAt, lastError, jobId, receiptId);
      if (outbox.changes !== 1) {
        throw new Error('Receipt match outbox job is not claimed');
      }
      this.#database
        .prepare(
          `UPDATE receipt_match_items
              SET next_match_at = ?, updated_at = ?
            WHERE receipt_id = ?
              AND status = 'awaiting-bank-transaction'`,
        )
        .run(nextMatchAt, now, receiptId);
      this.#appendAudit(
        receiptId,
        'receipt-match.retry-scheduled',
        {
          attemptCount: job.attempt_count,
          nextMatchAt,
          errorCode: lastError,
        },
        now,
      );
      return { status: 'awaiting-bank-transaction', nextMatchAt };
    })();
  }

  recordMatchedSet(
    jobId: number,
    receiptId: string,
    untrustedCandidates: readonly ImportedTransactionCandidate[],
    untrustedScore: number,
    nowInput: string,
  ): { links: readonly ReceiptImportedTransactionLink[]; inserted: boolean } {
    if (
      !Array.isArray(untrustedCandidates) ||
      untrustedCandidates.length < 1 ||
      untrustedCandidates.length > 6
    ) {
      throw new RangeError(
        'A deterministic receipt match requires between 1 and 6 transactions',
      );
    }
    const candidates = untrustedCandidates
      .map((candidate) => importedTransactionCandidateSchema.parse(candidate))
      .sort((left, right) =>
        candidateKey(left).localeCompare(candidateKey(right)),
      );
    if (new Set(candidates.map(candidateKey)).size !== candidates.length) {
      throw new ReceiptMatchStoreConflictError(
        'Receipt match transactions must be unique',
      );
    }
    const score = validatedScore(untrustedScore);
    const now = normalizedInstant(nowInput, 'now');

    return this.#database.transaction(
      (): {
        links: readonly ReceiptImportedTransactionLink[];
        inserted: boolean;
      } => {
        const receipt = this.#requireReceiptRow(receiptId);
        for (const candidate of candidates) {
          this.#assertCandidateLinkAllowed(receipt, candidate);
        }
        const deterministicMatch = matchReceiptToImportedTransactions(
          receiptMatchIntentSchema.parse(parseJson(receipt.intent_json)),
          candidates,
        );
        const matchedCandidates =
          deterministicMatch.disposition === 'matched'
            ? [deterministicMatch.candidate]
            : deterministicMatch.disposition === 'matched-set'
              ? deterministicMatch.candidates
              : undefined;
        const matchedScore =
          deterministicMatch.disposition === 'matched' ||
          deterministicMatch.disposition === 'matched-set'
            ? deterministicMatch.score
            : undefined;
        if (matchedCandidates === undefined || matchedScore !== score) {
          throw new ReceiptMatchStoreConflictError(
            'Transactions are not a deterministic receipt match',
          );
        }
        const deterministicKeys = [...matchedCandidates]
          .map(candidateKey)
          .sort();
        if (
          JSON.stringify(deterministicKeys) !==
          JSON.stringify(candidates.map(candidateKey))
        ) {
          throw new ReceiptMatchStoreConflictError(
            'Deterministic receipt match selected a different transaction set',
          );
        }
        const existing = this.#getLinkRows(receiptId);
        if (existing.length > 0) {
          this.#assertSameLinks(existing, candidates);
          return { links: existing.map(toLink), inserted: false };
        }
        this.#claimedJob(jobId, receiptId, 'match-receipt');
        if (receipt.status !== 'awaiting-bank-transaction') {
          throw new Error('Receipt is not awaiting a bank transaction');
        }
        const links = candidates.map((candidate) =>
          this.#insertImmutableLink(receiptId, candidate, now),
        );
        const updated = this.#database
          .prepare(
            `UPDATE receipt_match_items
              SET status = 'matched',
                  next_match_at = NULL,
                  attention_reason = NULL,
                  matched_at = ?,
                  updated_at = ?
            WHERE receipt_id = ?
              AND status = 'awaiting-bank-transaction'`,
          )
          .run(now, now, receiptId);
        if (updated.changes !== 1) {
          throw new Error('Receipt match state could not be persisted');
        }
        this.#completeClaimedJob(jobId, receiptId, 'match-receipt', now);
        this.#enqueueApply(receipt, now);
        this.#appendAudit(
          receiptId,
          'receipt-match.matched',
          {
            accountAliases: [
              ...new Set(candidates.map((candidate) => candidate.accountAlias)),
            ].sort(),
            postingDates: [
              ...new Set(candidates.map((candidate) => candidate.postingDate)),
            ].sort(),
            transactionCount: candidates.length,
            score,
            priorExternalLinkCount: candidates.filter((candidate) =>
              candidateLinksReceipt(candidate, receiptId),
            ).length,
          },
          now,
        );
        this.#appendAudit(receiptId, 'receipt-match.apply-queued', {}, now);
        return { links, inserted: true };
      },
    )();
  }

  recordAmbiguous(
    jobId: number,
    receiptId: string,
    untrustedCandidates: readonly ScoredImportedTransactionCandidate[],
    nowInput: string,
  ): ReceiptAmbiguityChoice[] {
    const candidates = this.#validatedAmbiguityCandidates(
      receiptId,
      untrustedCandidates,
    );
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction((): ReceiptAmbiguityChoice[] => {
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status === 'ambiguous') {
        this.#assertSameAmbiguity(receiptId, candidates);
        return this.listAmbiguityChoices(receiptId);
      }
      this.#claimedJob(jobId, receiptId, 'match-receipt');
      if (receipt.status !== 'awaiting-bank-transaction') {
        throw new Error('Receipt is not awaiting a bank transaction');
      }
      for (const { candidate, score } of candidates) {
        this.#database
          .prepare(
            `INSERT INTO receipt_match_ambiguity_choices (
               choice_token,
               receipt_id,
               transaction_id,
               imported_id,
               account_alias,
               posting_date,
               payee_name,
               amount_minor_units,
               score,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            choiceToken(),
            receiptId,
            candidate.transactionId,
            candidate.importedId,
            candidate.accountAlias,
            candidate.postingDate,
            candidate.payeeName,
            candidate.amountMinorUnits,
            score,
            now,
          );
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_match_items
              SET status = 'ambiguous',
                  next_match_at = NULL,
                  updated_at = ?
            WHERE receipt_id = ?
              AND status = 'awaiting-bank-transaction'`,
        )
        .run(now, receiptId);
      if (updated.changes !== 1) {
        throw new Error('Receipt ambiguity state could not be persisted');
      }
      this.#completeClaimedJob(jobId, receiptId, 'match-receipt', now);
      this.#appendAudit(
        receiptId,
        'receipt-match.ambiguous',
        { choiceCount: candidates.length },
        now,
      );
      return this.listAmbiguityChoices(receiptId);
    })();
  }

  listAmbiguityChoices(receiptId: string): ReceiptAmbiguityChoice[] {
    const rows = this.#ambiguityRows(receiptId);
    return rows.map(toSafeChoice);
  }

  listUnpromptedAmbiguities(
    limit = 100,
  ): ReceiptMatchAmbiguityPromptCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('Ambiguity prompt limit is outside safe bounds');
    }
    const rows = this.#database
      .prepare(
        `SELECT item.receipt_id
           FROM receipt_match_items AS item
          WHERE item.status = 'ambiguous'
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_ignores AS ignored
               WHERE ignored.receipt_id = item.receipt_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_ambiguity_prompts AS prompt
               WHERE prompt.receipt_id = item.receipt_id
            )
          ORDER BY item.updated_at, item.receipt_id
          LIMIT ?`,
      )
      .all(limit) as Array<{ receipt_id: string }>;
    return rows.map((row) => {
      const receipt = this.getReceipt(row.receipt_id);
      if (receipt === undefined || receipt.status !== 'ambiguous') {
        throw new Error('Receipt ambiguity changed while listing prompts');
      }
      return {
        referenceId: createReceiptMatchReferenceId(row.receipt_id),
        receipt,
        choices: this.listAmbiguityChoices(row.receipt_id).slice(0, 10),
      };
    });
  }

  recordAmbiguityPromptDelivered(input: {
    referenceId: string;
    receiptId: string;
    roomToken: string;
    botActorId: string;
    messageId: string;
    choiceTokens: readonly string[];
    deliveredAt: string;
  }): ReceiptMatchAmbiguityPrompt {
    const referenceId = validatedReferenceId(input.referenceId);
    const receiptId = boundedText(input.receiptId, 200, 'receiptId');
    const roomToken = boundedText(input.roomToken, 500, 'roomToken');
    const botActorId = validatedBotActorId(input.botActorId);
    const messageId = boundedText(input.messageId, 500, 'messageId');
    const deliveredAt = normalizedInstant(input.deliveredAt, 'deliveredAt');
    if (
      !Array.isArray(input.choiceTokens) ||
      input.choiceTokens.length < 1 ||
      input.choiceTokens.length > 10
    ) {
      throw new RangeError(
        'Receipt match prompt requires between 1 and 10 choices',
      );
    }
    const choiceTokens = input.choiceTokens.map(validatedChoiceToken);
    if (new Set(choiceTokens).size !== choiceTokens.length) {
      throw new ReceiptMatchStoreConflictError(
        'Receipt ambiguity prompt choices must be unique',
      );
    }
    if (createReceiptMatchReferenceId(receiptId) !== referenceId) {
      throw new ReceiptMatchStoreConflictError(
        'Receipt ambiguity prompt reference does not match',
      );
    }

    return this.#database.transaction(() => {
      const current = this.getAmbiguityPrompt(referenceId);
      if (current !== undefined) {
        if (
          current.receiptId !== receiptId ||
          current.roomToken !== roomToken ||
          current.botActorId !== botActorId ||
          current.messageId !== messageId ||
          JSON.stringify(current.choiceTokens) !== JSON.stringify(choiceTokens)
        ) {
          throw new ReceiptMatchStoreConflictError(
            'Receipt ambiguity prompt was already delivered differently',
          );
        }
        return current;
      }
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== 'ambiguous') {
        throw new Error('Receipt is not awaiting an ambiguity prompt');
      }
      const currentTokens = this.#ambiguityRows(receiptId)
        .slice(0, 10)
        .map((row) => row.choice_token);
      if (JSON.stringify(currentTokens) !== JSON.stringify(choiceTokens)) {
        throw new ReceiptMatchStoreConflictError(
          'Receipt ambiguity prompt choices do not match persisted choices',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO receipt_match_ambiguity_prompts (
             reference_id, receipt_id, room_token, bot_actor_id,
             message_id, choice_tokens_json, delivered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          referenceId,
          receiptId,
          roomToken,
          botActorId,
          messageId,
          serializeJson(choiceTokens, 'receipt ambiguity prompt choices'),
          deliveredAt,
        );
      this.#appendAudit(
        receiptId,
        'receipt-match.ambiguity-prompt-delivered',
        {
          referenceId,
          roomToken,
          botActorId,
          messageId,
          choiceCount: choiceTokens.length,
        },
        deliveredAt,
      );
      return this.getAmbiguityPrompt(referenceId)!;
    })();
  }

  getAmbiguityPrompt(
    referenceIdInput: string,
  ): ReceiptMatchAmbiguityPrompt | undefined {
    const referenceId = validatedReferenceId(referenceIdInput);
    const row = this.#database
      .prepare(
        `SELECT reference_id, receipt_id, room_token, bot_actor_id,
                message_id, choice_tokens_json, delivered_at
           FROM receipt_match_ambiguity_prompts
          WHERE reference_id = ?`,
      )
      .get(referenceId) as ReceiptAmbiguityPromptRow | undefined;
    return row === undefined ? undefined : promptFromRow(row);
  }

  getAmbiguityResolution(
    referenceIdInput: string,
  ): ReceiptMatchAmbiguityResolution | undefined {
    const referenceId = validatedReferenceId(referenceIdInput);
    const row = this.#database
      .prepare(
        `SELECT reference_id, receipt_id, room_token, actor_id,
                inbound_message_id, parent_bot_id, parent_message_id,
                selection, choice_token, resolved_at
           FROM receipt_match_ambiguity_resolutions
          WHERE reference_id = ?`,
      )
      .get(referenceId) as ReceiptAmbiguityResolutionRow | undefined;
    return row === undefined ? undefined : resolutionFromRow(row);
  }

  resolveAmbiguityFromTalk(input: {
    referenceId: string;
    roomToken: string;
    actorId: string;
    inboundMessageId: string;
    parentBotId: string;
    parentMessageId: string;
    selection: number;
    resolvedAt: string;
  }): { link: ReceiptImportedTransactionLink; inserted: boolean } {
    const referenceId = validatedReferenceId(input.referenceId);
    const roomToken = boundedText(input.roomToken, 500, 'roomToken');
    const actorId = boundedText(input.actorId, 500, 'actorId');
    const inboundMessageId = boundedText(
      input.inboundMessageId,
      500,
      'inboundMessageId',
    );
    const parentBotId = validatedBotActorId(input.parentBotId);
    const parentMessageId = boundedText(
      input.parentMessageId,
      500,
      'parentMessageId',
    );
    if (
      !Number.isSafeInteger(input.selection) ||
      input.selection < 1 ||
      input.selection > 10
    ) {
      throw new RangeError('Receipt ambiguity selection must be 1 through 10');
    }
    const resolvedAt = normalizedInstant(input.resolvedAt, 'resolvedAt');

    return this.#database.transaction(() => {
      const prompt = this.getAmbiguityPrompt(referenceId);
      if (prompt === undefined) {
        throw new Error('Unknown receipt ambiguity prompt');
      }
      if (this.#isIgnored(prompt.receiptId)) {
        throw new Error('Receipt is ignored');
      }
      if (
        prompt.roomToken !== roomToken ||
        prompt.botActorId !== parentBotId ||
        prompt.messageId !== parentMessageId
      ) {
        throw new ReceiptMatchStoreConflictError(
          'Receipt ambiguity reply parent does not match the delivered prompt',
        );
      }
      const choiceToken = prompt.choiceTokens[input.selection - 1];
      if (choiceToken === undefined) {
        throw new RangeError(
          'Receipt ambiguity selection is outside the offered choices',
        );
      }
      const existing = this.getAmbiguityResolution(referenceId);
      if (existing !== undefined) {
        if (
          existing.receiptId !== prompt.receiptId ||
          existing.roomToken !== roomToken ||
          existing.actorId !== actorId ||
          existing.inboundMessageId !== inboundMessageId ||
          existing.parentBotId !== parentBotId ||
          existing.parentMessageId !== parentMessageId ||
          existing.selection !== input.selection ||
          existing.choiceToken !== choiceToken
        ) {
          throw new ReceiptMatchStoreConflictError(
            'Receipt ambiguity was already resolved differently',
          );
        }
        const links = this.getImportedTransactionLinks(prompt.receiptId);
        if (links.length !== 1) {
          throw new Error('Receipt ambiguity resolution has no durable link');
        }
        return { link: links[0]!, inserted: false };
      }

      const resolution = this.resolveAmbiguity(
        prompt.receiptId,
        choiceToken,
        resolvedAt,
      );
      this.#database
        .prepare(
          `INSERT INTO receipt_match_ambiguity_resolutions (
             reference_id, receipt_id, room_token, actor_id,
             inbound_message_id, parent_bot_id, parent_message_id,
             selection, choice_token, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          referenceId,
          prompt.receiptId,
          roomToken,
          actorId,
          inboundMessageId,
          parentBotId,
          parentMessageId,
          input.selection,
          choiceToken,
          resolvedAt,
        );
      this.#appendAudit(
        prompt.receiptId,
        'receipt-match.ambiguity-resolved-from-talk',
        {
          referenceId,
          actorId,
          inboundMessageId,
          parentBotId,
          parentMessageId,
          selection: input.selection,
        },
        resolvedAt,
      );
      return resolution;
    })();
  }

  resolveAmbiguity(
    receiptId: string,
    untrustedChoiceToken: string,
    nowInput: string,
  ): { link: ReceiptImportedTransactionLink; inserted: boolean } {
    const token = validatedChoiceToken(untrustedChoiceToken);
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      if (this.#isIgnored(receiptId)) {
        throw new Error('Receipt is ignored');
      }
      const row = this.#database
        .prepare(
          `SELECT choice_token,
                  receipt_id,
                  transaction_id,
                  imported_id,
                  account_alias,
                  posting_date,
                  payee_name,
                  amount_minor_units,
                  score,
                  selected_at
             FROM receipt_match_ambiguity_choices
            WHERE choice_token = ? AND receipt_id = ?`,
        )
        .get(token, receiptId) as ReceiptAmbiguityChoiceRow | undefined;
      if (row === undefined) {
        throw new Error('Unknown receipt ambiguity choice');
      }
      const existing = this.#getLinkRows(receiptId);
      if (existing.length > 0) {
        const link = existing[0];
        if (
          existing.length !== 1 ||
          link === undefined ||
          row.selected_at === null ||
          link.transaction_id !== row.transaction_id ||
          link.imported_id !== row.imported_id ||
          link.account_alias !== row.account_alias
        ) {
          throw new ReceiptMatchStoreConflictError(
            'Receipt is already linked to another imported transaction',
          );
        }
        return { link: toLink(link), inserted: false };
      }
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== 'ambiguous') {
        throw new Error('Receipt is not awaiting an ambiguity choice');
      }
      const candidate = importedTransactionCandidateSchema.parse({
        transactionId: row.transaction_id,
        importedId: row.imported_id,
        accountAlias: row.account_alias,
        accountLastFour: null,
        postingDate: row.posting_date,
        payeeName: row.payee_name,
        currency: 'CAD',
        amountMinorUnits: row.amount_minor_units,
        alreadyLinkedReceipts: [],
      });
      this.#assertCandidateCompatible(receipt, candidate);
      const link = this.#insertImmutableLink(receiptId, candidate, now);
      const selected = this.#database
        .prepare(
          `UPDATE receipt_match_ambiguity_choices
              SET selected_at = ?
            WHERE choice_token = ?
              AND receipt_id = ?
              AND selected_at IS NULL`,
        )
        .run(now, token, receiptId);
      if (selected.changes !== 1) {
        throw new Error('Receipt ambiguity choice was already selected');
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_match_items
              SET status = 'matched',
                  matched_at = ?,
                  updated_at = ?
            WHERE receipt_id = ? AND status = 'ambiguous'`,
        )
        .run(now, now, receiptId);
      if (updated.changes !== 1) {
        throw new Error('Receipt ambiguity selection could not be persisted');
      }
      this.#enqueueApply(receipt, now);
      this.#appendAudit(
        receiptId,
        'receipt-match.choice-selected',
        {
          choiceToken: token,
          accountAlias: row.account_alias,
          postingDate: row.posting_date,
          score: row.score,
        },
        now,
      );
      this.#appendAudit(receiptId, 'receipt-match.apply-queued', {}, now);
      return { link, inserted: true };
    })();
  }

  getImportedTransactionLinks(
    receiptId: string,
  ): readonly ReceiptImportedTransactionLink[] {
    return this.#getLinkRows(receiptId).map(toLink);
  }

  markApplied(
    jobId: number,
    receiptId: string,
    nowInput: string,
  ): ReceiptMatchRecord {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const current = this.#requireReceiptRow(receiptId);
      if (current.status === 'applied') {
        return toRecord(current);
      }
      this.#claimedJob(jobId, receiptId, 'apply-receipt-match');
      if (current.status !== 'matched') {
        throw new Error('Receipt match is not ready to be applied');
      }
      if (this.#getLinkRows(receiptId).length === 0) {
        throw new Error('Receipt match has no imported-transaction link');
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_match_items
              SET status = 'applied',
                  applied_at = ?,
                  updated_at = ?
            WHERE receipt_id = ? AND status = 'matched'`,
        )
        .run(now, now, receiptId);
      if (updated.changes !== 1) {
        throw new Error('Receipt match application could not be persisted');
      }
      this.#completeClaimedJob(jobId, receiptId, 'apply-receipt-match', now);
      this.#appendAudit(receiptId, 'receipt-match.applied', {}, now);
      return toRecord(this.#requireReceiptRow(receiptId));
    })();
  }

  /**
   * Returns a claimed apply job to the queue without consuming its retry
   * budget. This is used while an independently durable Actual update intent
   * is awaiting approval or writer reconciliation.
   */
  deferApply(
    jobId: number,
    receiptId: string,
    availableAtInput: string,
    nowInput: string,
    reasonInput = 'actual-update-pending',
  ): void {
    const availableAt = normalizedInstant(availableAtInput, 'availableAt');
    const now = normalizedInstant(nowInput, 'now');
    const reason = errorCode(reasonInput);
    if (availableAt <= now) {
      throw new RangeError('Deferred receipt apply must be scheduled later');
    }
    this.#database.transaction(() => {
      this.#claimedJob(jobId, receiptId, 'apply-receipt-match');
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== 'matched') {
        throw new Error('Receipt match is not awaiting Actual application');
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_match_outbox
              SET state = 'pending',
                  attempt_count = CASE
                    WHEN attempt_count > 0 THEN attempt_count - 1
                    ELSE 0
                  END,
                  available_at = ?,
                  locked_at = NULL,
                  last_error = ?
            WHERE id = ?
              AND receipt_id = ?
              AND kind = 'apply-receipt-match'
              AND state = 'processing'`,
        )
        .run(availableAt, reason, jobId, receiptId);
      if (updated.changes !== 1) {
        throw new Error('Receipt apply deferral could not be persisted');
      }
      this.#appendAudit(
        receiptId,
        'receipt-match.apply-deferred',
        { availableAt, reason },
        now,
      );
    })();
  }

  retryApply(
    jobId: number,
    receiptId: string,
    untrustedErrorCode: string,
    nowInput: string,
  ): ReceiptApplyRetryResult {
    const now = normalizedInstant(nowInput, 'now');
    const lastError = errorCode(untrustedErrorCode);
    return this.#database.transaction((): ReceiptApplyRetryResult => {
      const job = this.#claimedJob(jobId, receiptId, 'apply-receipt-match');
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== 'matched') {
        throw new Error('Receipt match is not ready to be applied');
      }
      if (job.attempt_count >= MAX_APPLY_ATTEMPTS) {
        this.#claimedJobToAttention(
          jobId,
          receiptId,
          'apply-retry-exhausted',
          now,
        );
        return {
          status: 'attention',
          reason: 'apply-retry-exhausted',
        };
      }
      const delay = APPLY_RETRY_DELAYS_MS[job.attempt_count - 1];
      if (delay === undefined) {
        throw new Error('Apply retry schedule is inconsistent');
      }
      const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
      const updated = this.#database
        .prepare(
          `UPDATE receipt_match_outbox
              SET state = 'pending',
                  available_at = ?,
                  locked_at = NULL,
                  last_error = ?
            WHERE id = ?
              AND receipt_id = ?
              AND kind = 'apply-receipt-match'
              AND state = 'processing'`,
        )
        .run(nextAttemptAt, lastError, jobId, receiptId);
      if (updated.changes !== 1) {
        throw new Error('Receipt apply outbox job is not claimed');
      }
      this.#appendAudit(
        receiptId,
        'receipt-match.apply-retry-scheduled',
        {
          attemptCount: job.attempt_count,
          nextAttemptAt,
          errorCode: lastError,
        },
        now,
      );
      return { status: 'matched', nextAttemptAt };
    })();
  }

  markAttention(
    jobId: number,
    receiptId: string,
    reason: ReceiptAttentionReason,
    nowInput: string,
  ): ReceiptMatchRecord {
    if (!receiptAttentionReasons.includes(reason)) {
      throw new TypeError('Unknown receipt attention reason');
    }
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const current = this.#requireReceiptRow(receiptId);
      if (
        current.status === 'attention' &&
        current.attention_reason === reason
      ) {
        return toRecord(current);
      }
      const job = this.#database
        .prepare(
          `SELECT id, kind, receipt_id, state, attempt_count, available_at
             FROM receipt_match_outbox
            WHERE id = ? AND receipt_id = ? AND state = 'processing'`,
        )
        .get(jobId, receiptId) as ReceiptMatchOutboxRow | undefined;
      if (job === undefined) {
        throw new Error('Receipt match outbox job is not claimed');
      }
      this.#claimedJobToAttention(jobId, receiptId, reason, now);
      return toRecord(this.#requireReceiptRow(receiptId));
    })();
  }

  wakeAllPendingAfterLedgerRefresh(nowInput: string): number {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      this.#expireAwaiting(now);
      const rows = this.#database
        .prepare(
          `SELECT outbox.receipt_id
             FROM receipt_match_outbox AS outbox
             JOIN receipt_match_items AS item
               ON item.receipt_id = outbox.receipt_id
            WHERE outbox.kind = 'match-receipt'
              AND outbox.state = 'pending'
              AND item.status = 'awaiting-bank-transaction'
              AND outbox.available_at > ?
              AND NOT EXISTS (
                SELECT 1
                  FROM receipt_match_ignores AS ignored
                 WHERE ignored.receipt_id = item.receipt_id
              )
            ORDER BY outbox.id`,
        )
        .all(now) as Array<{ receipt_id: string }>;
      if (rows.length === 0) {
        return 0;
      }
      const updated = this.#database
        .prepare(
          `UPDATE receipt_match_outbox
              SET available_at = ?
            WHERE kind = 'match-receipt'
              AND state = 'pending'
              AND available_at > ?
              AND receipt_id IN (
                SELECT receipt_id
                 FROM receipt_match_items
                 WHERE status = 'awaiting-bank-transaction'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM receipt_match_ignores AS ignored
                      WHERE ignored.receipt_id =
                            receipt_match_items.receipt_id
                   )
              )`,
        )
        .run(now, now);
      if (updated.changes !== rows.length) {
        throw new Error('Pending receipt-match wakeup was inconsistent');
      }
      for (const row of rows) {
        this.#database
          .prepare(
            `UPDATE receipt_match_items
                SET next_match_at = ?, updated_at = ?
              WHERE receipt_id = ?
                AND status = 'awaiting-bank-transaction'`,
          )
          .run(now, now, row.receipt_id);
        this.#appendAudit(
          row.receipt_id,
          'receipt-match.woken-after-ledger-refresh',
          {},
          now,
        );
      }
      return rows.length;
    })();
  }

  expireAwaiting(nowInput: string): number {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => this.#expireAwaiting(now))();
  }

  recoverInterruptedOutbox(nowInput: string): number {
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT id, kind, receipt_id, state, attempt_count, available_at
             FROM receipt_match_outbox
            WHERE state = 'processing'
            ORDER BY id`,
        )
        .all() as ReceiptMatchOutboxRow[];
      for (const row of rows) {
        const recovered = this.#database
          .prepare(
            `UPDATE receipt_match_outbox
                SET state = 'pending',
                    available_at = ?,
                    locked_at = NULL,
                    last_error = 'interrupted-before-completion'
              WHERE id = ? AND state = 'processing'`,
          )
          .run(now, row.id);
        if (recovered.changes !== 1) {
          throw new Error('Interrupted receipt match job changed concurrently');
        }
        if (row.kind === 'match-receipt') {
          this.#database
            .prepare(
              `UPDATE receipt_match_items
                  SET next_match_at = ?, updated_at = ?
                WHERE receipt_id = ?
                  AND status = 'awaiting-bank-transaction'`,
            )
            .run(now, now, row.receipt_id);
        }
        this.#appendAudit(
          row.receipt_id,
          'receipt-match.outbox-recovered',
          { kind: row.kind },
          now,
        );
      }
      return rows.length;
    })();
  }

  listAudit(receiptId: string): ReceiptMatchAuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT id, receipt_id, action, detail_json, occurred_at
           FROM receipt_match_audit_events
          WHERE receipt_id = ?
          ORDER BY id`,
      )
      .all(receiptId) as ReceiptMatchAuditRow[];
    return rows.map((row) => ({
      id: row.id,
      receiptId: row.receipt_id,
      action: row.action,
      detail: parseJson(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }

  listUnnotifiedTalkOutcomes(limit = 100): ReceiptMatchTalkOutcomeCandidate[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('Receipt outcome limit is outside safe bounds');
    }
    const rows = this.#database
      .prepare(
        `SELECT item.*
           FROM receipt_match_items AS item
          WHERE item.status IN ('attention', 'applied')
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_ignores AS ignored
               WHERE ignored.receipt_id = item.receipt_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_audit_events AS audit
               WHERE audit.receipt_id = item.receipt_id
                 AND audit.action = 'receipt-match.talk-outcome-delivered'
            )
          ORDER BY item.updated_at, item.receipt_id
          LIMIT ?`,
      )
      .all(limit) as ReceiptMatchRow[];
    return rows.map((row) => {
      const receipt = toRecord(row);
      if (receipt.status !== 'attention' && receipt.status !== 'applied') {
        throw new Error('Receipt outcome changed while listing notifications');
      }
      return {
        referenceId: createReceiptMatchOutcomeReferenceId(
          receipt.receiptId,
          receipt.status,
        ),
        receipt: {
          ...receipt,
          status: receipt.status,
        },
      };
    });
  }

  recordTalkOutcomeDelivered(input: {
    receiptId: string;
    status: 'attention' | 'applied';
    referenceId: string;
    deliveredAt: string;
  }): boolean {
    const receiptId = boundedText(input.receiptId, 200, 'receiptId');
    const referenceId = validatedReferenceId(input.referenceId);
    const deliveredAt = normalizedInstant(input.deliveredAt, 'deliveredAt');
    if (
      referenceId !==
      createReceiptMatchOutcomeReferenceId(receiptId, input.status)
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Receipt outcome reference does not match',
      );
    }
    return this.#database.transaction(() => {
      const receipt = this.#requireReceiptRow(receiptId);
      if (receipt.status !== input.status) {
        throw new ReceiptMatchStoreConflictError(
          'Receipt outcome changed before delivery was recorded',
        );
      }
      const existing = this.#database
        .prepare(
          `SELECT 1
             FROM receipt_match_audit_events
            WHERE receipt_id = ?
              AND action = 'receipt-match.talk-outcome-delivered'
            LIMIT 1`,
        )
        .get(receiptId);
      if (existing !== undefined) {
        return false;
      }
      this.#appendAudit(
        receiptId,
        'receipt-match.talk-outcome-delivered',
        { referenceId, status: input.status },
        deliveredAt,
      );
      return true;
    })();
  }

  #getReceiptRow(receiptId: string): ReceiptMatchRow | undefined {
    return this.#database
      .prepare(
        `SELECT *
           FROM receipt_match_items
          WHERE receipt_id = ?`,
      )
      .get(receiptId) as ReceiptMatchRow | undefined;
  }

  #requireReceiptRow(receiptId: string): ReceiptMatchRow {
    const row = this.#getReceiptRow(receiptId);
    if (row === undefined) {
      throw new Error('Unknown receipt match');
    }
    return row;
  }

  #getLinkRows(receiptId: string): ReceiptMatchLinkRow[] {
    return this.#database
      .prepare(
        `SELECT receipt_id,
                transaction_id,
                imported_id,
                account_alias,
                linked_at
           FROM receipt_imported_transaction_links
          WHERE receipt_id = ?
          ORDER BY transaction_id, account_alias, imported_id`,
      )
      .all(receiptId) as ReceiptMatchLinkRow[];
  }

  #assertSameLinks(
    existing: readonly ReceiptMatchLinkRow[],
    candidates: readonly ImportedTransactionCandidate[],
  ): void {
    if (
      JSON.stringify(existing.map(linkRowKey).sort()) !==
      JSON.stringify(candidates.map(candidateKey).sort())
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Receipt is already linked to another imported-transaction set',
      );
    }
  }

  #assertCandidateLinkAllowed(
    receiptRow: ReceiptMatchRow,
    candidate: ImportedTransactionCandidate,
  ): void {
    const receipt = receiptMatchIntentSchema.parse(
      parseJson(receiptRow.intent_json),
    );
    if (
      candidate.alreadyLinkedReceipts.length > 0 &&
      !candidateLinksReceipt(candidate, receipt.receiptId)
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Imported transaction is already linked to another receipt',
      );
    }
    if (candidate.currency !== 'CAD') {
      throw new ReceiptMatchStoreConflictError(
        'Imported transaction candidate conflicts with the receipt',
      );
    }
  }

  #assertCandidateCompatible(
    receiptRow: ReceiptMatchRow,
    candidate: ImportedTransactionCandidate,
  ): void {
    this.#assertCandidateLinkAllowed(receiptRow, candidate);
    const receipt = receiptMatchIntentSchema.parse(
      parseJson(receiptRow.intent_json),
    );
    if (
      receipt.currency === 'CAD' &&
      -candidate.amountMinorUnits !== receipt.totalMinorUnits
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Imported transaction candidate conflicts with the receipt',
      );
    }
  }

  #insertImmutableLink(
    receiptId: string,
    candidate: ImportedTransactionCandidate,
    now: string,
  ): ReceiptImportedTransactionLink {
    const transactionConflicts = this.#database
      .prepare(
        `SELECT receipt_id,
                transaction_id,
                imported_id,
                account_alias
           FROM receipt_imported_transaction_links
          WHERE transaction_id = ?
             OR (account_alias = ? AND imported_id = ?)
          ORDER BY receipt_id`,
      )
      .all(
        candidate.transactionId,
        candidate.accountAlias,
        candidate.importedId,
      ) as Array<
      Pick<
        ReceiptMatchLinkRow,
        'receipt_id' | 'transaction_id' | 'imported_id' | 'account_alias'
      >
    >;
    if (
      transactionConflicts.some(
        (conflict) =>
          (conflict.transaction_id === candidate.transactionId &&
            (conflict.account_alias !== candidate.accountAlias ||
              conflict.imported_id !== candidate.importedId)) ||
          (conflict.account_alias === candidate.accountAlias &&
            conflict.imported_id === candidate.importedId &&
            conflict.transaction_id !== candidate.transactionId),
      )
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Imported transaction identity conflicts with an existing link',
      );
    }
    const otherReceiptIds = [
      ...new Set(
        transactionConflicts
          .map((conflict) => conflict.receipt_id)
          .filter((existingReceiptId) => existingReceiptId !== receiptId),
      ),
    ];
    if (
      otherReceiptIds.length > 0 &&
      (!candidateLinksReceipt(candidate, receiptId) ||
        otherReceiptIds.some(
          (existingReceiptId) =>
            !candidateLinksReceipt(candidate, existingReceiptId),
        ))
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Imported transaction is already linked to another receipt',
      );
    }
    this.#database
      .prepare(
        `INSERT INTO receipt_imported_transaction_links (
           receipt_id,
           transaction_id,
           imported_id,
           account_alias,
           linked_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        receiptId,
        candidate.transactionId,
        candidate.importedId,
        candidate.accountAlias,
        now,
      );
    return {
      receiptId,
      transactionId: candidate.transactionId,
      importedId: candidate.importedId,
      accountAlias: candidate.accountAlias,
      linkedAt: now,
    };
  }

  #validatedAmbiguityCandidates(
    receiptId: string,
    untrusted: readonly ScoredImportedTransactionCandidate[],
  ): readonly ScoredImportedTransactionCandidate[] {
    if (
      !Array.isArray(untrusted) ||
      untrusted.length < 1 ||
      untrusted.length > MAX_AMBIGUITY_CHOICES
    ) {
      throw new RangeError(
        'Receipt confirmation requires between 1 and 20 candidates',
      );
    }
    const receipt = this.#requireReceiptRow(receiptId);
    const candidates = untrusted.map((entry) => {
      const candidate = importedTransactionCandidateSchema.parse(
        entry.candidate,
      );
      this.#assertCandidateCompatible(receipt, candidate);
      return { candidate, score: validatedScore(entry.score) };
    });
    const candidateKeys = candidates.map(({ candidate }) =>
      candidateKey(candidate),
    );
    const transactionIds = candidates.map(
      ({ candidate }) => candidate.transactionId,
    );
    const importedKeys = candidates.map(
      ({ candidate }) =>
        `${candidate.accountAlias}\u0000${candidate.importedId}`,
    );
    if (
      new Set(candidateKeys).size !== candidates.length ||
      new Set(transactionIds).size !== candidates.length ||
      new Set(importedKeys).size !== candidates.length
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Ambiguity candidates must identify distinct imported transactions',
      );
    }
    const deterministicMatch = matchReceiptToImportedTransactions(
      receiptMatchIntentSchema.parse(parseJson(receipt.intent_json)),
      candidates.map(({ candidate }) => candidate),
    );
    if (
      deterministicMatch.disposition !== 'ambiguous' ||
      deterministicMatch.candidates.length !== candidates.length
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Candidates do not form a deterministic receipt ambiguity',
      );
    }
    const suppliedScores = new Map(
      candidates.map(({ candidate, score }) => [
        candidateKey(candidate),
        score,
      ]),
    );
    if (
      deterministicMatch.candidates.some(
        ({ candidate, score }) =>
          suppliedScores.get(candidateKey(candidate)) !== score,
      )
    ) {
      throw new ReceiptMatchStoreConflictError(
        'Ambiguity candidate scores do not match deterministic scoring',
      );
    }
    return candidates;
  }

  #ambiguityRows(receiptId: string): ReceiptAmbiguityChoiceRow[] {
    return this.#database
      .prepare(
        `SELECT choice_token,
                receipt_id,
                transaction_id,
                imported_id,
                account_alias,
                posting_date,
                payee_name,
                amount_minor_units,
                score,
                selected_at
           FROM receipt_match_ambiguity_choices
          WHERE receipt_id = ?
          ORDER BY score DESC, created_at, choice_token`,
      )
      .all(receiptId) as ReceiptAmbiguityChoiceRow[];
  }

  #assertSameAmbiguity(
    receiptId: string,
    candidates: readonly ScoredImportedTransactionCandidate[],
  ): void {
    const rows = this.#ambiguityRows(receiptId);
    const expected = [...candidates]
      .map(({ candidate, score }) => ({
        transactionId: candidate.transactionId,
        importedId: candidate.importedId,
        accountAlias: candidate.accountAlias,
        score,
      }))
      .sort((left, right) =>
        `${left.transactionId}\u0000${left.accountAlias}\u0000${left.importedId}`.localeCompare(
          `${right.transactionId}\u0000${right.accountAlias}\u0000${right.importedId}`,
        ),
      );
    const actual = rows
      .map((row) => ({
        transactionId: row.transaction_id,
        importedId: row.imported_id,
        accountAlias: row.account_alias,
        score: row.score,
      }))
      .sort((left, right) =>
        `${left.transactionId}\u0000${left.accountAlias}\u0000${left.importedId}`.localeCompare(
          `${right.transactionId}\u0000${right.accountAlias}\u0000${right.importedId}`,
        ),
      );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new ReceiptMatchStoreConflictError(
        'Receipt ambiguity was already recorded with different candidates',
      );
    }
  }

  #claimedJob(
    jobId: number,
    receiptId: string,
    kind: ReceiptMatchOutboxKind,
  ): ReceiptMatchOutboxRow {
    const row = this.#database
      .prepare(
        `SELECT id, kind, receipt_id, state, attempt_count, available_at
           FROM receipt_match_outbox
          WHERE id = ?
            AND receipt_id = ?
            AND kind = ?
            AND state = 'processing'`,
      )
      .get(jobId, receiptId, kind) as ReceiptMatchOutboxRow | undefined;
    if (row === undefined) {
      throw new Error('Receipt match outbox job is not claimed');
    }
    return row;
  }

  #completeClaimedJob(
    jobId: number,
    receiptId: string,
    kind: ReceiptMatchOutboxKind,
    now: string,
  ): void {
    const completed = this.#database
      .prepare(
        `UPDATE receipt_match_outbox
            SET state = 'completed',
                completed_at = ?,
                locked_at = NULL
          WHERE id = ?
            AND receipt_id = ?
            AND kind = ?
            AND state = 'processing'`,
      )
      .run(now, jobId, receiptId, kind);
    if (completed.changes !== 1) {
      throw new Error('Receipt match outbox job is not claimed');
    }
  }

  #pendingJobToAttention(
    jobId: number,
    receiptId: string,
    reason: ReceiptAttentionReason,
    now: string,
  ): void {
    const outbox = this.#database
      .prepare(
        `UPDATE receipt_match_outbox
            SET state = 'failed',
                locked_at = NULL,
                last_error = ?
          WHERE id = ?
            AND receipt_id = ?
            AND state = 'pending'`,
      )
      .run(reason, jobId, receiptId);
    if (outbox.changes !== 1) {
      throw new Error('Pending receipt match outbox job changed concurrently');
    }
    this.#setAttention(receiptId, reason, now);
  }

  #claimedJobToAttention(
    jobId: number,
    receiptId: string,
    reason: ReceiptAttentionReason,
    now: string,
  ): void {
    const outbox = this.#database
      .prepare(
        `UPDATE receipt_match_outbox
            SET state = 'failed',
                locked_at = NULL,
                last_error = ?
          WHERE id = ?
            AND receipt_id = ?
            AND state = 'processing'`,
      )
      .run(reason, jobId, receiptId);
    if (outbox.changes !== 1) {
      throw new Error('Receipt match outbox job is not claimed');
    }
    this.#setAttention(receiptId, reason, now);
  }

  #setAttention(
    receiptId: string,
    reason: ReceiptAttentionReason,
    now: string,
  ): void {
    const updated = this.#database
      .prepare(
        `UPDATE receipt_match_items
            SET status = 'attention',
                next_match_at = NULL,
                attention_reason = ?,
                updated_at = ?
          WHERE receipt_id = ? AND status <> 'applied'`,
      )
      .run(reason, now, receiptId);
    if (updated.changes !== 1) {
      throw new Error('Receipt cannot transition to attention');
    }
    this.#appendAudit(
      receiptId,
      'receipt-match.attention-required',
      { reason },
      now,
    );
  }

  #expireAwaiting(now: string): number {
    const rows = this.#database
      .prepare(
        `SELECT item.receipt_id
           FROM receipt_match_items AS item
          WHERE item.status = 'awaiting-bank-transaction'
            AND item.expires_at <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_ignores AS ignored
               WHERE ignored.receipt_id = item.receipt_id
            )
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_outbox AS outbox
               WHERE outbox.receipt_id = item.receipt_id
                 AND outbox.kind = 'match-receipt'
                 AND outbox.state = 'processing'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM receipt_match_outbox AS outbox
               WHERE outbox.receipt_id = item.receipt_id
                 AND outbox.kind = 'match-receipt'
                 AND outbox.state = 'pending'
                 AND outbox.available_at <= ?
            )
          ORDER BY item.expires_at, item.receipt_id`,
      )
      .all(now, now) as Array<{ receipt_id: string }>;
    for (const row of rows) {
      this.#database
        .prepare(
          `UPDATE receipt_match_outbox
              SET state = 'failed',
                  locked_at = NULL,
                  last_error = 'bank-transaction-not-found'
            WHERE receipt_id = ?
              AND kind = 'match-receipt'
              AND state = 'pending'`,
        )
        .run(row.receipt_id);
      this.#setAttention(row.receipt_id, 'bank-transaction-not-found', now);
      this.#appendAudit(
        row.receipt_id,
        'receipt-match.expired',
        {
          latestPostingDaysAfterPurchase: LATEST_POSTING_DAYS_AFTER_PURCHASE,
          bankImportGraceDays: BANK_IMPORT_GRACE_DAYS,
        },
        now,
      );
    }
    return rows.length;
  }

  #enqueueApply(receipt: ReceiptMatchRow, now: string): void {
    this.#enqueue(
      'apply-receipt-match',
      receipt.receipt_id,
      `receipt-apply:${receipt.idempotency_key}`,
      now,
      now,
    );
  }

  #isIgnored(receiptId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM receipt_match_ignores
            WHERE receipt_id = ?
            LIMIT 1`,
        )
        .get(receiptId) !== undefined
    );
  }

  #enqueue(
    kind: ReceiptMatchOutboxKind,
    receiptId: string,
    idempotencyKey: string,
    availableAt: string,
    createdAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO receipt_match_outbox (
           idempotency_key,
           kind,
           receipt_id,
           payload_json,
           state,
           available_at,
           created_at
         ) VALUES (?, ?, ?, '{}', 'pending', ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(idempotencyKey, kind, receiptId, availableAt, createdAt);
  }

  #appendAudit(
    receiptId: string,
    action: string,
    detail: unknown,
    occurredAt: string,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO receipt_match_audit_events (
           receipt_id,
           action,
           detail_json,
           occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        receiptId,
        action,
        serializeJson(detail, 'receipt match audit detail'),
        occurredAt,
      );
  }
}
