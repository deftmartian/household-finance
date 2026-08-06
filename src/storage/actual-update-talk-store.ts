import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

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
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const fullBotActorIdSchema = z.string().regex(/^bots\/bot-[a-f0-9]{40}$/);
const messageIdSchema = z.string().regex(/^[1-9]\d*$/);
const messageSchema = z
  .string()
  .min(1)
  .max(32_000)
  .refine((value) => !value.includes('\0'));
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, 'Timestamp must be a canonical ISO-8601 UTC instant');
const backendUrlSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Backend URL is not an allowed HTTP origin',
      });
      return z.NEVER;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  });

const talkInteractionSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS actual_update_talk_deliveries (
    intent_id TEXT PRIMARY KEY,
    delivery_idempotency_key TEXT NOT NULL UNIQUE,
    backend_url TEXT NOT NULL,
    room_token TEXT NOT NULL,
    reference_id TEXT NOT NULL UNIQUE CHECK (
      length(reference_id) = 64
    ),
    message_text TEXT NOT NULL CHECK (
      length(message_text) BETWEEN 1 AND 32000
    ),
    message_sha256 TEXT NOT NULL CHECK (
      length(message_sha256) = 64
    ),
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'delivering', 'delivered')
    ),
    bot_actor_id TEXT,
    bot_message_id TEXT,
    available_at TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    last_error_code TEXT,
    CHECK (
      (state = 'delivered'
        AND bot_actor_id IS NOT NULL
        AND bot_message_id IS NOT NULL
        AND delivered_at IS NOT NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL)
      OR
      (state != 'delivered'
        AND bot_actor_id IS NULL
        AND bot_message_id IS NULL
        AND delivered_at IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS actual_update_talk_parent_identity
    ON actual_update_talk_deliveries(
      room_token, bot_actor_id, bot_message_id
    )
    WHERE state = 'delivered';

  CREATE INDEX IF NOT EXISTS actual_update_talk_delivery_ready
    ON actual_update_talk_deliveries(
      state, available_at, lease_expires_at, created_at, intent_id
    );

  CREATE TABLE IF NOT EXISTS actual_update_talk_outcome_deliveries (
    intent_id TEXT PRIMARY KEY
      REFERENCES actual_update_talk_deliveries(intent_id),
    outcome_status TEXT NOT NULL CHECK (
      outcome_status IN ('applied', 'rejected', 'failed')
    ),
    delivery_idempotency_key TEXT NOT NULL UNIQUE,
    reference_id TEXT NOT NULL UNIQUE CHECK (
      length(reference_id) = 64
    ),
    message_text TEXT NOT NULL CHECK (
      length(message_text) BETWEEN 1 AND 32000
    ),
    message_sha256 TEXT NOT NULL CHECK (
      length(message_sha256) = 64
    ),
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'delivering', 'delivered')
    ),
    bot_actor_id TEXT,
    bot_message_id TEXT,
    available_at TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    last_error_code TEXT,
    CHECK (
      (state = 'delivered'
        AND bot_actor_id IS NOT NULL
        AND bot_message_id IS NOT NULL
        AND delivered_at IS NOT NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL)
      OR
      (state != 'delivered'
        AND bot_actor_id IS NULL
        AND bot_message_id IS NULL
        AND delivered_at IS NULL)
    )
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS actual_update_talk_outcome_parent_identity
    ON actual_update_talk_outcome_deliveries(bot_actor_id, bot_message_id)
    WHERE state = 'delivered';

  CREATE INDEX IF NOT EXISTS actual_update_talk_outcome_delivery_ready
    ON actual_update_talk_outcome_deliveries(
      state, available_at, lease_expires_at, created_at, intent_id
    );

  CREATE TABLE IF NOT EXISTS actual_update_talk_inbound_actions (
    idempotency_key TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES actual_update_talk_deliveries(intent_id),
    action TEXT NOT NULL CHECK (
      action IN ('approve', 'reject', 'undo')
    ),
    actor_id TEXT NOT NULL,
    room_token TEXT NOT NULL,
    bot_actor_id TEXT NOT NULL,
    bot_message_id TEXT NOT NULL,
    parent_message_sha256 TEXT NOT NULL CHECK (
      length(parent_message_sha256) = 64
    ),
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS actual_update_talk_auto_approvals (
    intent_id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    approved_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS actual_update_talk_auto_outcomes (
    intent_id TEXT PRIMARY KEY
      REFERENCES actual_update_talk_deliveries(intent_id),
    outcome_status TEXT NOT NULL CHECK (
      outcome_status IN ('applied', 'failed')
    ),
    planned_at TEXT NOT NULL
  ) STRICT;

`;

interface DeliveryRow {
  intent_id: string;
  delivery_idempotency_key: string;
  backend_url: string;
  room_token: string;
  reference_id: string;
  message_text: string;
  message_sha256: string;
  state: 'pending' | 'delivering' | 'delivered';
  bot_actor_id: string | null;
  bot_message_id: string | null;
  available_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  delivered_at: string | null;
  last_error_code: string | null;
}

interface InboundActionRow {
  idempotency_key: string;
  intent_id: string;
  action: ActualUpdateTalkInboundAction;
  actor_id: string;
  room_token: string;
  bot_actor_id: string;
  bot_message_id: string;
  parent_message_sha256: string;
  occurred_at: string;
}

interface OutcomeDeliveryRow {
  intent_id: string;
  outcome_status: ActualUpdateTalkOutcomeStatus;
  delivery_idempotency_key: string;
  reference_id: string;
  message_text: string;
  message_sha256: string;
  state: 'pending' | 'delivering' | 'delivered';
  bot_actor_id: string | null;
  bot_message_id: string | null;
  available_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  delivered_at: string | null;
  last_error_code: string | null;
}

interface AutoApprovalRow {
  intent_id: string;
  decision_id: string;
  actor_id: string;
  approved_at: string;
}

export interface PlanActualUpdateTalkDeliveryInput {
  readonly intentId: string;
  readonly deliveryIdempotencyKey: string;
  readonly backendUrl: string;
  readonly roomToken: string;
  readonly referenceId: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface ActualUpdateTalkDelivery {
  readonly intentId: string;
  readonly deliveryIdempotencyKey: string;
  readonly backendUrl: string;
  readonly roomToken: string;
  readonly referenceId: string;
  readonly message: string;
  readonly messageSha256: string;
  readonly state: 'pending' | 'delivering' | 'delivered';
  readonly botActorId: string | null;
  readonly botMessageId: string | null;
  readonly availableAt: string;
  readonly deliveredAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface ActualUpdateTalkDeliveryClaim extends ActualUpdateTalkDelivery {
  readonly state: 'delivering';
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export type ActualUpdateTalkOutcomeStatus = 'applied' | 'rejected' | 'failed';

export interface PlanActualUpdateTalkOutcomeDeliveryInput {
  readonly intentId: string;
  readonly outcomeStatus: ActualUpdateTalkOutcomeStatus;
  readonly deliveryIdempotencyKey: string;
  readonly referenceId: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface ActualUpdateTalkOutcomeDelivery {
  readonly intentId: string;
  readonly outcomeStatus: ActualUpdateTalkOutcomeStatus;
  readonly deliveryIdempotencyKey: string;
  readonly referenceId: string;
  readonly message: string;
  readonly messageSha256: string;
  readonly state: 'pending' | 'delivering' | 'delivered';
  readonly botActorId: string | null;
  readonly botMessageId: string | null;
  readonly availableAt: string;
  readonly deliveredAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface ActualUpdateTalkOutcomeDeliveryClaim extends ActualUpdateTalkOutcomeDelivery {
  readonly state: 'delivering';
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly roomToken: string;
  readonly replyTo: string;
}

export interface ActualUpdateTalkParentIdentity {
  readonly roomToken: string;
  readonly botActorId: string;
  readonly botMessageId: string;
}

export type ActualUpdateTalkInboundAction = 'approve' | 'reject' | 'undo';

export interface ActualUpdateTalkInboundActionRecord {
  readonly idempotencyKey: string;
  readonly intentId: string;
  readonly action: ActualUpdateTalkInboundAction;
  readonly actorId: string;
  readonly roomToken: string;
  readonly botActorId: string;
  readonly botMessageId: string;
  readonly parentMessageSha256: string;
  readonly occurredAt: string;
}

export interface ActualUpdateTalkAutoApprovalPlan {
  readonly intentId: string;
  readonly decisionId: string;
  readonly actorId: string;
  readonly approvedAt: string;
}

export class ActualUpdateTalkStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualUpdateTalkStoreConflictError';
  }
}

function normalizedInstant(value: string, name: string): string {
  const parsed = canonicalInstantSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`${name} is not a canonical instant`);
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function actualUpdateTalkMessageSha256(messageInput: string): string {
  const message = messageSchema.parse(messageInput);
  return createHash('sha256')
    .update('household-finance.actual-update-talk-message.v1\0', 'utf8')
    .update(message, 'utf8')
    .digest('hex');
}

function addMilliseconds(instant: string, milliseconds: number): string {
  return new Date(new Date(instant).valueOf() + milliseconds).toISOString();
}

function normalizeBackendUrl(value: string): string {
  return backendUrlSchema.parse(value);
}

function deliveryFromRow(row: DeliveryRow): ActualUpdateTalkDelivery {
  return {
    intentId: row.intent_id,
    deliveryIdempotencyKey: row.delivery_idempotency_key,
    backendUrl: row.backend_url,
    roomToken: row.room_token,
    referenceId: row.reference_id,
    message: row.message_text,
    messageSha256: row.message_sha256,
    state: row.state,
    botActorId: row.bot_actor_id,
    botMessageId: row.bot_message_id,
    availableAt: row.available_at,
    deliveredAt: row.delivered_at,
    lastErrorCode: row.last_error_code,
  };
}

function outcomeDeliveryFromRow(
  row: OutcomeDeliveryRow,
): ActualUpdateTalkOutcomeDelivery {
  return {
    intentId: row.intent_id,
    outcomeStatus: row.outcome_status,
    deliveryIdempotencyKey: row.delivery_idempotency_key,
    referenceId: row.reference_id,
    message: row.message_text,
    messageSha256: row.message_sha256,
    state: row.state,
    botActorId: row.bot_actor_id,
    botMessageId: row.bot_message_id,
    availableAt: row.available_at,
    deliveredAt: row.delivered_at,
    lastErrorCode: row.last_error_code,
  };
}
function inboundActionFromRow(
  row: InboundActionRow,
): ActualUpdateTalkInboundActionRecord {
  return {
    idempotencyKey: row.idempotency_key,
    intentId: row.intent_id,
    action: row.action,
    actorId: row.actor_id,
    roomToken: row.room_token,
    botActorId: row.bot_actor_id,
    botMessageId: row.bot_message_id,
    parentMessageSha256: row.parent_message_sha256,
    occurredAt: row.occurred_at,
  };
}

/**
 * Durable interaction boundary for Actual update approvals. The persisted
 * parent identity and exact message digest are the authority for later direct
 * replies; an inbound webhook cannot choose an Actual intent ID.
 */
export class ActualUpdateTalkStore {
  readonly #database: Database.Database;
  readonly #leaseDurationMs: number;

  constructor(
    databasePath: string,
    options: {
      readonly leaseDurationMs?: number;
    } = {},
  ) {
    const leaseDurationMs = options.leaseDurationMs ?? 60_000;
    if (
      !Number.isSafeInteger(leaseDurationMs) ||
      leaseDurationMs < 1_000 ||
      leaseDurationMs > 60 * 60_000
    ) {
      throw new RangeError(
        'Actual update Talk lease duration must be from 1 second to 1 hour',
      );
    }
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#leaseDurationMs = leaseDurationMs;
    this.#database = new Database(databasePath);
    this.#database.exec(talkInteractionSchema);
  }

  close(): void {
    this.#database.close();
  }

  planDelivery(input: PlanActualUpdateTalkDeliveryInput): {
    readonly inserted: boolean;
    readonly delivery: ActualUpdateTalkDelivery;
  } {
    const intentId = identifier(input.intentId, 'intentId');
    const deliveryIdempotencyKey = sha256Schema.parse(
      input.deliveryIdempotencyKey,
    );
    const backendUrl = normalizeBackendUrl(input.backendUrl);
    const roomToken = identifier(input.roomToken, 'roomToken');
    const referenceId = sha256Schema.parse(input.referenceId);
    const message = messageSchema.parse(input.message);
    const messageSha256 = actualUpdateTalkMessageSha256(message);
    const createdAt = normalizedInstant(input.createdAt, 'createdAt');

    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_deliveries
            WHERE intent_id = ?
               OR delivery_idempotency_key = ?
               OR reference_id = ?
            ORDER BY intent_id
            LIMIT 1`,
        )
        .get(intentId, deliveryIdempotencyKey, referenceId) as
        DeliveryRow | undefined;
      if (existing !== undefined) {
        if (
          existing.intent_id !== intentId ||
          existing.delivery_idempotency_key !== deliveryIdempotencyKey ||
          existing.backend_url !== backendUrl ||
          existing.room_token !== roomToken ||
          existing.reference_id !== referenceId ||
          existing.message_text !== message ||
          existing.message_sha256 !== messageSha256 ||
          existing.created_at !== createdAt
        ) {
          throw new ActualUpdateTalkStoreConflictError(
            'Actual update Talk delivery identity was reused with different content',
          );
        }
        return { inserted: false, delivery: deliveryFromRow(existing) };
      }

      this.#database
        .prepare(
          `INSERT INTO actual_update_talk_deliveries (
             intent_id, delivery_idempotency_key, backend_url, room_token,
             reference_id, message_text, message_sha256, state,
             available_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          intentId,
          deliveryIdempotencyKey,
          backendUrl,
          roomToken,
          referenceId,
          message,
          messageSha256,
          createdAt,
          createdAt,
        );
      const delivery = this.getDelivery(intentId);
      if (delivery === undefined) {
        throw new Error('Actual update Talk delivery was not persisted');
      }
      return { inserted: true, delivery };
    })();
  }

  getDelivery(intentIdInput: string): ActualUpdateTalkDelivery | undefined {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_talk_deliveries
          WHERE intent_id = ?`,
      )
      .get(identifier(intentIdInput, 'intentId')) as DeliveryRow | undefined;
    return row === undefined ? undefined : deliveryFromRow(row);
  }

  claimDelivery(
    intentIdInput: string,
    nowInput: string,
  ): ActualUpdateTalkDeliveryClaim | undefined {
    const intentId = identifier(intentIdInput, 'intentId');
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_deliveries
            WHERE intent_id = ?`,
        )
        .get(intentId) as DeliveryRow | undefined;
      if (
        row === undefined ||
        row.state === 'delivered' ||
        row.available_at > now ||
        (row.state === 'delivering' &&
          row.lease_expires_at !== null &&
          row.lease_expires_at > now)
      ) {
        return undefined;
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = addMilliseconds(now, this.#leaseDurationMs);
      const changed = this.#database
        .prepare(
          `UPDATE actual_update_talk_deliveries
              SET state = 'delivering',
                  lease_token = ?,
                  lease_expires_at = ?,
                  last_error_code = NULL
            WHERE intent_id = ?
              AND state != 'delivered'
              AND available_at <= ?
              AND (
                state = 'pending'
                OR lease_expires_at IS NULL
                OR lease_expires_at <= ?
              )`,
        )
        .run(leaseToken, leaseExpiresAt, intentId, now, now);
      if (changed.changes !== 1) {
        return undefined;
      }
      const claimed = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_deliveries
            WHERE intent_id = ?`,
        )
        .get(intentId) as DeliveryRow;
      const claim: ActualUpdateTalkDeliveryClaim = {
        ...deliveryFromRow(claimed),
        state: 'delivering',
        leaseToken,
        leaseExpiresAt,
      };
      return claim;
    })();
  }

  completeDelivery(
    intentIdInput: string,
    leaseTokenInput: string,
    identity: {
      readonly roomToken: string;
      readonly botActorId: string;
      readonly messageId: string;
      readonly referenceId: string;
    },
    deliveredAtInput: string,
  ): ActualUpdateTalkDelivery {
    const intentId = identifier(intentIdInput, 'intentId');
    const leaseToken = identifier(leaseTokenInput, 'leaseToken');
    const roomToken = identifier(identity.roomToken, 'roomToken');
    const botActorId = fullBotActorIdSchema.parse(identity.botActorId);
    const botMessageId = messageIdSchema.parse(identity.messageId);
    const referenceId = sha256Schema.parse(identity.referenceId);
    const deliveredAt = normalizedInstant(deliveredAtInput, 'deliveredAt');

    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_deliveries
            WHERE intent_id = ?`,
        )
        .get(intentId) as DeliveryRow | undefined;
      if (row === undefined) {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update Talk delivery does not exist',
        );
      }
      if (row.state === 'delivered') {
        if (
          row.room_token !== roomToken ||
          row.bot_actor_id !== botActorId ||
          row.bot_message_id !== botMessageId ||
          row.reference_id !== referenceId ||
          row.delivered_at !== deliveredAt
        ) {
          throw new ActualUpdateTalkStoreConflictError(
            'Delivered Actual update Talk identity does not match',
          );
        }
        return deliveryFromRow(row);
      }
      if (row.state !== 'delivering' || row.lease_token !== leaseToken) {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update Talk delivery does not own the active lease',
        );
      }
      if (row.room_token !== roomToken || row.reference_id !== referenceId) {
        throw new ActualUpdateTalkStoreConflictError(
          'Talk delivery identity does not match its persisted plan',
        );
      }
      this.#database
        .prepare(
          `UPDATE actual_update_talk_deliveries
              SET state = 'delivered',
                  bot_actor_id = ?,
                  bot_message_id = ?,
                  delivered_at = ?,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  last_error_code = NULL
            WHERE intent_id = ?
              AND state = 'delivering'
              AND lease_token = ?`,
        )
        .run(botActorId, botMessageId, deliveredAt, intentId, leaseToken);
      const delivery = this.getDelivery(intentId);
      if (delivery?.state !== 'delivered') {
        throw new Error('Actual update Talk delivery was not completed');
      }
      return delivery;
    })();
  }

  retryDelivery(
    intentIdInput: string,
    leaseTokenInput: string,
    errorCodeInput: string,
    availableAtInput: string,
  ): void {
    const intentId = identifier(intentIdInput, 'intentId');
    const leaseToken = identifier(leaseTokenInput, 'leaseToken');
    const errorCode = identifier(errorCodeInput, 'errorCode');
    const availableAt = normalizedInstant(availableAtInput, 'availableAt');
    const changed = this.#database
      .prepare(
        `UPDATE actual_update_talk_deliveries
            SET state = 'pending',
                available_at = ?,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = ?
          WHERE intent_id = ?
            AND state = 'delivering'
            AND lease_token = ?`,
      )
      .run(availableAt, errorCode, intentId, leaseToken);
    if (changed.changes !== 1) {
      throw new ActualUpdateTalkStoreConflictError(
        'Actual update Talk retry does not own the active lease',
      );
    }
  }

  planOutcomeDelivery(input: PlanActualUpdateTalkOutcomeDeliveryInput): {
    readonly inserted: boolean;
    readonly delivery: ActualUpdateTalkOutcomeDelivery;
  } {
    const intentId = identifier(input.intentId, 'intentId');
    const outcomeStatus = input.outcomeStatus;
    if (
      outcomeStatus !== 'applied' &&
      outcomeStatus !== 'rejected' &&
      outcomeStatus !== 'failed'
    ) {
      throw new TypeError('Actual update Talk outcome status is invalid');
    }
    const deliveryIdempotencyKey = sha256Schema.parse(
      input.deliveryIdempotencyKey,
    );
    const referenceId = sha256Schema.parse(input.referenceId);
    const message = messageSchema.parse(input.message);
    const messageSha256 = actualUpdateTalkMessageSha256(message);
    const createdAt = normalizedInstant(input.createdAt, 'createdAt');

    return this.#database.transaction(() => {
      const parent = this.getDelivery(intentId);
      if (parent?.state !== 'delivered') {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update outcome has no delivered approval parent',
        );
      }
      const existing = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_outcome_deliveries
            WHERE intent_id = ?
               OR delivery_idempotency_key = ?
               OR reference_id = ?
            ORDER BY intent_id
            LIMIT 1`,
        )
        .get(intentId, deliveryIdempotencyKey, referenceId) as
        OutcomeDeliveryRow | undefined;
      if (existing !== undefined) {
        if (
          existing.intent_id !== intentId ||
          existing.outcome_status !== outcomeStatus ||
          existing.delivery_idempotency_key !== deliveryIdempotencyKey ||
          existing.reference_id !== referenceId ||
          existing.message_text !== message ||
          existing.message_sha256 !== messageSha256 ||
          existing.created_at !== createdAt
        ) {
          throw new ActualUpdateTalkStoreConflictError(
            'Actual update Talk outcome identity was reused with different content',
          );
        }
        return {
          inserted: false,
          delivery: outcomeDeliveryFromRow(existing),
        };
      }
      this.#database
        .prepare(
          `INSERT INTO actual_update_talk_outcome_deliveries (
             intent_id, outcome_status, delivery_idempotency_key, reference_id,
             message_text, message_sha256, state, available_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          intentId,
          outcomeStatus,
          deliveryIdempotencyKey,
          referenceId,
          message,
          messageSha256,
          createdAt,
          createdAt,
        );
      const delivery = this.getOutcomeDelivery(intentId);
      if (delivery === undefined) {
        throw new Error('Actual update Talk outcome was not persisted');
      }
      return { inserted: true, delivery };
    })();
  }

  getOutcomeDelivery(
    intentIdInput: string,
  ): ActualUpdateTalkOutcomeDelivery | undefined {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_talk_outcome_deliveries
          WHERE intent_id = ?`,
      )
      .get(identifier(intentIdInput, 'intentId')) as
      OutcomeDeliveryRow | undefined;
    return row === undefined ? undefined : outcomeDeliveryFromRow(row);
  }

  claimOutcomeDelivery(
    intentIdInput: string,
    nowInput: string,
  ): ActualUpdateTalkOutcomeDeliveryClaim | undefined {
    const intentId = identifier(intentIdInput, 'intentId');
    const now = normalizedInstant(nowInput, 'now');
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_outcome_deliveries
            WHERE intent_id = ?`,
        )
        .get(intentId) as OutcomeDeliveryRow | undefined;
      if (
        row === undefined ||
        row.state === 'delivered' ||
        row.available_at > now ||
        (row.state === 'delivering' &&
          row.lease_expires_at !== null &&
          row.lease_expires_at > now)
      ) {
        return undefined;
      }
      const parent = this.getDelivery(intentId);
      if (parent?.state !== 'delivered' || parent.botMessageId === null) {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update outcome approval parent is unavailable',
        );
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = addMilliseconds(now, this.#leaseDurationMs);
      const changed = this.#database
        .prepare(
          `UPDATE actual_update_talk_outcome_deliveries
              SET state = 'delivering',
                  lease_token = ?,
                  lease_expires_at = ?,
                  last_error_code = NULL
            WHERE intent_id = ?
              AND state != 'delivered'
              AND available_at <= ?
              AND (
                state = 'pending'
                OR lease_expires_at IS NULL
                OR lease_expires_at <= ?
              )`,
        )
        .run(leaseToken, leaseExpiresAt, intentId, now, now);
      if (changed.changes !== 1) {
        return undefined;
      }
      const claimed = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_outcome_deliveries
            WHERE intent_id = ?`,
        )
        .get(intentId) as OutcomeDeliveryRow;
      const claim: ActualUpdateTalkOutcomeDeliveryClaim = {
        ...outcomeDeliveryFromRow(claimed),
        state: 'delivering',
        leaseToken,
        leaseExpiresAt,
        roomToken: parent.roomToken,
        replyTo: parent.botMessageId,
      };
      return claim;
    })();
  }

  completeOutcomeDelivery(
    intentIdInput: string,
    leaseTokenInput: string,
    identity: {
      readonly roomToken: string;
      readonly botActorId: string;
      readonly messageId: string;
      readonly referenceId: string;
      readonly replyTo?: string;
    },
    deliveredAtInput: string,
  ): ActualUpdateTalkOutcomeDelivery {
    const intentId = identifier(intentIdInput, 'intentId');
    const leaseToken = identifier(leaseTokenInput, 'leaseToken');
    const roomToken = identifier(identity.roomToken, 'roomToken');
    const botActorId = fullBotActorIdSchema.parse(identity.botActorId);
    const botMessageId = messageIdSchema.parse(identity.messageId);
    const referenceId = sha256Schema.parse(identity.referenceId);
    const replyTo =
      identity.replyTo === undefined
        ? undefined
        : messageIdSchema.parse(identity.replyTo);
    const deliveredAt = normalizedInstant(deliveredAtInput, 'deliveredAt');

    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_outcome_deliveries
            WHERE intent_id = ?`,
        )
        .get(intentId) as OutcomeDeliveryRow | undefined;
      const parent = this.getDelivery(intentId);
      if (row === undefined || parent?.state !== 'delivered') {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update Talk outcome does not exist',
        );
      }
      if (
        parent.botMessageId === null ||
        parent.roomToken !== roomToken ||
        parent.botMessageId !== replyTo ||
        row.reference_id !== referenceId
      ) {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update Talk outcome identity does not match its approval parent',
        );
      }
      if (row.state === 'delivered') {
        if (
          row.bot_actor_id !== botActorId ||
          row.bot_message_id !== botMessageId ||
          row.delivered_at !== deliveredAt
        ) {
          throw new ActualUpdateTalkStoreConflictError(
            'Delivered Actual update Talk outcome identity does not match',
          );
        }
        return outcomeDeliveryFromRow(row);
      }
      if (row.state !== 'delivering' || row.lease_token !== leaseToken) {
        throw new ActualUpdateTalkStoreConflictError(
          'Actual update Talk outcome does not own the active lease',
        );
      }
      this.#database
        .prepare(
          `UPDATE actual_update_talk_outcome_deliveries
              SET state = 'delivered',
                  bot_actor_id = ?,
                  bot_message_id = ?,
                  delivered_at = ?,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  last_error_code = NULL
            WHERE intent_id = ?
              AND state = 'delivering'
              AND lease_token = ?`,
        )
        .run(botActorId, botMessageId, deliveredAt, intentId, leaseToken);
      const delivery = this.getOutcomeDelivery(intentId);
      if (delivery?.state !== 'delivered') {
        throw new Error('Actual update Talk outcome was not completed');
      }
      return delivery;
    })();
  }

  retryOutcomeDelivery(
    intentIdInput: string,
    leaseTokenInput: string,
    errorCodeInput: string,
    availableAtInput: string,
  ): void {
    const intentId = identifier(intentIdInput, 'intentId');
    const leaseToken = identifier(leaseTokenInput, 'leaseToken');
    const errorCode = identifier(errorCodeInput, 'errorCode');
    const availableAt = normalizedInstant(availableAtInput, 'availableAt');
    const changed = this.#database
      .prepare(
        `UPDATE actual_update_talk_outcome_deliveries
            SET state = 'pending',
                available_at = ?,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = ?
          WHERE intent_id = ?
            AND state = 'delivering'
            AND lease_token = ?`,
      )
      .run(availableAt, errorCode, intentId, leaseToken);
    if (changed.changes !== 1) {
      throw new ActualUpdateTalkStoreConflictError(
        'Actual update Talk outcome retry does not own the active lease',
      );
    }
  }

  findDeliveredOutcomeParent(
    identity: ActualUpdateTalkParentIdentity,
  ): ActualUpdateTalkOutcomeDelivery | undefined {
    const row = this.#database
      .prepare(
        `SELECT outcome.*
           FROM actual_update_talk_outcome_deliveries AS outcome
           JOIN actual_update_talk_deliveries AS proposal
             ON proposal.intent_id = outcome.intent_id
          WHERE outcome.state = 'delivered'
            AND proposal.room_token = ?
            AND outcome.bot_actor_id = ?
            AND outcome.bot_message_id = ?`,
      )
      .get(
        identifier(identity.roomToken, 'roomToken'),
        fullBotActorIdSchema.parse(identity.botActorId),
        messageIdSchema.parse(identity.botMessageId),
      ) as OutcomeDeliveryRow | undefined;
    return row === undefined ? undefined : outcomeDeliveryFromRow(row);
  }

  findDeliveredParent(
    identity: ActualUpdateTalkParentIdentity,
  ): ActualUpdateTalkDelivery | undefined {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_talk_deliveries
          WHERE state = 'delivered'
            AND room_token = ?
            AND bot_actor_id = ?
            AND bot_message_id = ?`,
      )
      .get(
        identifier(identity.roomToken, 'roomToken'),
        fullBotActorIdSchema.parse(identity.botActorId),
        messageIdSchema.parse(identity.botMessageId),
      ) as DeliveryRow | undefined;
    return row === undefined ? undefined : deliveryFromRow(row);
  }

  recordInboundAction(input: {
    readonly idempotencyKey: string;
    readonly intentId: string;
    readonly action: ActualUpdateTalkInboundAction;
    readonly actorId: string;
    readonly roomToken: string;
    readonly botActorId: string;
    readonly botMessageId: string;
    readonly parentMessageSha256: string;
    readonly occurredAt: string;
  }): {
    readonly inserted: boolean;
    readonly action: ActualUpdateTalkInboundActionRecord;
  } {
    const normalized = {
      idempotencyKey: sha256Schema.parse(input.idempotencyKey),
      intentId: identifier(input.intentId, 'intentId'),
      action: input.action,
      actorId: identifier(input.actorId, 'actorId'),
      roomToken: identifier(input.roomToken, 'roomToken'),
      botActorId: fullBotActorIdSchema.parse(input.botActorId),
      botMessageId: messageIdSchema.parse(input.botMessageId),
      parentMessageSha256: sha256Schema.parse(input.parentMessageSha256),
      occurredAt: normalizedInstant(input.occurredAt, 'occurredAt'),
    };
    if (
      normalized.action !== 'approve' &&
      normalized.action !== 'reject' &&
      normalized.action !== 'undo'
    ) {
      throw new TypeError('Actual update Talk action is invalid');
    }
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_inbound_actions
            WHERE idempotency_key = ?`,
        )
        .get(normalized.idempotencyKey) as InboundActionRow | undefined;
      if (existing !== undefined) {
        const record = inboundActionFromRow(existing);
        if (
          record.intentId !== normalized.intentId ||
          record.action !== normalized.action ||
          record.actorId !== normalized.actorId ||
          record.roomToken !== normalized.roomToken ||
          record.botActorId !== normalized.botActorId ||
          record.botMessageId !== normalized.botMessageId ||
          record.parentMessageSha256 !== normalized.parentMessageSha256
        ) {
          throw new ActualUpdateTalkStoreConflictError(
            'Actual update Talk action identity was reused with different content',
          );
        }
        return { inserted: false, action: record };
      }
      this.#database
        .prepare(
          `INSERT INTO actual_update_talk_inbound_actions (
             idempotency_key, intent_id, action, actor_id, room_token,
             bot_actor_id, bot_message_id, parent_message_sha256, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.idempotencyKey,
          normalized.intentId,
          normalized.action,
          normalized.actorId,
          normalized.roomToken,
          normalized.botActorId,
          normalized.botMessageId,
          normalized.parentMessageSha256,
          normalized.occurredAt,
        );
      return {
        inserted: true,
        action: {
          ...normalized,
        },
      };
    })();
  }

  planAutoApproval(input: {
    readonly intentId: string;
    readonly actorId: string;
    readonly approvedAt: string;
  }): ActualUpdateTalkAutoApprovalPlan {
    const intentId = identifier(input.intentId, 'intentId');
    const actorId = identifier(input.actorId, 'actorId');
    const approvedAt = normalizedInstant(input.approvedAt, 'approvedAt');
    const decisionId = sha256(
      `household-finance.actual-update-auto-approval.v1\0${intentId}`,
    );
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT *
             FROM actual_update_talk_auto_approvals
            WHERE intent_id = ? OR decision_id = ?
            ORDER BY intent_id
            LIMIT 1`,
        )
        .get(intentId, decisionId) as AutoApprovalRow | undefined;
      if (existing !== undefined) {
        if (
          existing.intent_id !== intentId ||
          existing.decision_id !== decisionId ||
          existing.actor_id !== actorId
        ) {
          throw new ActualUpdateTalkStoreConflictError(
            'Actual update auto-approval identity was reused with different content',
          );
        }
        return {
          intentId: existing.intent_id,
          decisionId: existing.decision_id,
          actorId: existing.actor_id,
          approvedAt: existing.approved_at,
        };
      }
      this.#database
        .prepare(
          `INSERT INTO actual_update_talk_auto_approvals (
             intent_id, decision_id, actor_id, approved_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(intentId, decisionId, actorId, approvedAt);
      return { intentId, decisionId, actorId, approvedAt };
    })();
  }

  getAutoApproval(
    intentIdInput: string,
  ): ActualUpdateTalkAutoApprovalPlan | undefined {
    const row = this.#database
      .prepare(
        `SELECT *
           FROM actual_update_talk_auto_approvals
          WHERE intent_id = ?`,
      )
      .get(identifier(intentIdInput, 'intentId')) as
      AutoApprovalRow | undefined;
    return row === undefined
      ? undefined
      : {
          intentId: row.intent_id,
          decisionId: row.decision_id,
          actorId: row.actor_id,
          approvedAt: row.approved_at,
        };
  }

  getAutoOutcomeStatus(
    intentIdInput: string,
  ): Extract<ActualUpdateTalkOutcomeStatus, 'applied' | 'failed'> | undefined {
    const row = this.#database
      .prepare(
        `SELECT outcome_status
           FROM actual_update_talk_auto_outcomes
          WHERE intent_id = ?`,
      )
      .get(identifier(intentIdInput, 'intentId')) as
      { outcome_status: 'applied' | 'failed' } | undefined;
    return row?.outcome_status;
  }

  /**
   * A verified auto-approved outcome reuses the normal durable delivery row as
   * its one standalone Talk message. The marker keeps the regular explicit
   * approval/outcome reconciler from sending a second message, while the
   * delivered parent still supports an exact reply-to undo for applied writes.
   */
  planAutoOutcomeDelivery(
    input: PlanActualUpdateTalkDeliveryInput & {
      readonly outcomeStatus: Extract<
        ActualUpdateTalkOutcomeStatus,
        'applied' | 'failed'
      >;
    },
  ): {
    readonly inserted: boolean;
    readonly delivery: ActualUpdateTalkDelivery;
  } {
    const intentId = identifier(input.intentId, 'intentId');
    const autoApproval = this.getAutoApproval(intentId);
    if (autoApproval === undefined) {
      throw new ActualUpdateTalkStoreConflictError(
        'Standalone Actual update outcome has no durable auto-approval',
      );
    }
    return this.#database.transaction(() => {
      const planned = this.planDelivery(input);
      const existing = this.getAutoOutcomeStatus(intentId);
      if (existing !== undefined && existing !== input.outcomeStatus) {
        throw new ActualUpdateTalkStoreConflictError(
          'Standalone Actual update outcome changed terminal state',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO actual_update_talk_auto_outcomes (
             intent_id, outcome_status, planned_at
           ) VALUES (?, ?, ?)
           ON CONFLICT(intent_id) DO NOTHING`,
        )
        .run(intentId, input.outcomeStatus, input.createdAt);
      return planned;
    })();
  }
}
