import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { createAttachmentTalkReplyReferenceId } from '../domain/idempotency.js';
import type { ReceiptModelRunMetadata } from '../model/index.js';
import type { TalkAttachmentReference, TalkReply } from '../talk/index.js';

export type AttachmentShadowStatus =
  'received' | 'preserved' | 'completed' | 'failed';

const ATTACHMENT_CONVERSATION_SETTLE_MS = 1_000;

export interface AttachmentInboundEventInput {
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  actorId: string;
  messageId: string;
  attachment: TalkAttachmentReference;
  captionHint?: string;
  receivedAt: string;
}

export interface AttachmentInboundEvent extends AttachmentInboundEventInput {
  id: string;
}

export interface AttachmentShadowItem {
  eventId: string;
  status: AttachmentShadowStatus;
  archivePath?: string;
  sourceSha256?: string;
  proposal?: unknown;
  modelMetadata?: ReceiptModelRunMetadata;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompletedAttachmentShadow {
  event: AttachmentInboundEvent;
  householdNotes?: readonly string[];
  shadow: AttachmentShadowItem & {
    status: 'completed';
    sourceSha256: string;
    proposal: unknown;
  };
}

export interface ReceiptAttachmentReference {
  readonly event: AttachmentInboundEvent;
  readonly shadow: AttachmentShadowItem;
  readonly ignored: boolean;
}

export type IgnoreReceiptAttachmentResult =
  | { readonly status: 'ignored' | 'already-ignored' }
  | { readonly status: 'still-processing' };

export type AttachmentOutboxKind =
  'process-attachment-shadow' | 'deliver-attachment-result';

export interface AttachmentOutboxJob {
  id: number;
  idempotencyKey: string;
  kind: AttachmentOutboxKind;
  eventId: string;
  payload: unknown;
  attemptCount: number;
}

export type AttachmentDeliveryPayload =
  | {
      readonly type: 'conversation-handoff';
      readonly fallbackReply: TalkReply;
    }
  | {
      readonly type: 'talk-reply';
      readonly reply: TalkReply;
    };

export interface AttachmentAuditEvent {
  id: number;
  eventId: string;
  action: string;
  detail: unknown;
  occurredAt: string;
}

interface AttachmentInboundRow {
  id: string;
  idempotency_key: string;
  backend_url: string;
  room_token: string;
  actor_id: string;
  message_id: string;
  file_id: string;
  source_etag: string;
  source_size_bytes: number;
  source_media_type: TalkAttachmentReference['mediaType'];
  caption_hint: string | null;
  received_at: string;
}

interface AttachmentShadowRow {
  event_id: string;
  status: AttachmentShadowStatus;
  archive_path: string | null;
  source_sha256: string | null;
  proposal_json: string | null;
  model_metadata_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface AttachmentOutboxRow {
  id: number;
  idempotency_key: string;
  kind: AttachmentOutboxKind;
  event_id: string;
  payload_json: string;
  attempt_count: number;
}

interface AttachmentAuditRow {
  id: number;
  event_id: string;
  action: string;
  detail_json: string;
  occurred_at: string;
}

const attachmentSchema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;

  CREATE TABLE IF NOT EXISTS attachment_inbound_events (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    backend_url TEXT NOT NULL,
    room_token TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    source_etag TEXT NOT NULL,
    source_size_bytes INTEGER NOT NULL,
    source_media_type TEXT NOT NULL CHECK (
      source_media_type IN ('image/jpeg', 'image/png', 'application/pdf')
    ),
    caption_hint TEXT CHECK (
      caption_hint IS NULL
      OR (
        length(caption_hint) BETWEEN 1 AND 2000
        AND instr(caption_hint, char(0)) = 0
      )
    ),
    received_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attachment_shadow_items (
    event_id TEXT PRIMARY KEY REFERENCES attachment_inbound_events(id),
    status TEXT NOT NULL CHECK (
      status IN ('received', 'preserved', 'completed', 'failed')
    ),
    archive_path TEXT,
    source_sha256 TEXT,
    proposal_json TEXT,
    model_metadata_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS attachment_shadow_source
    ON attachment_shadow_items(status, source_sha256, created_at);

  CREATE TABLE IF NOT EXISTS attachment_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (
      kind IN ('process-attachment-shadow', 'deliver-attachment-result')
    ),
    event_id TEXT NOT NULL REFERENCES attachment_inbound_events(id),
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

  CREATE INDEX IF NOT EXISTS attachment_outbox_ready
    ON attachment_outbox(state, available_at, id);

  CREATE TABLE IF NOT EXISTS attachment_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES attachment_inbound_events(id),
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attachment_provider_calls (
    event_id TEXT PRIMARY KEY REFERENCES attachment_inbound_events(id),
    started_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS attachment_receipt_ignores (
    event_id TEXT PRIMARY KEY REFERENCES attachment_inbound_events(id),
    room_token TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    inbound_message_id TEXT NOT NULL,
    ignored_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS attachment_receipt_ignore_message
    ON attachment_receipt_ignores(inbound_message_id);

  CREATE TRIGGER IF NOT EXISTS attachment_receipt_ignore_no_update
  BEFORE UPDATE ON attachment_receipt_ignores
  BEGIN
    SELECT RAISE(ABORT, 'receipt ignore records are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS attachment_receipt_ignore_no_delete
  BEFORE DELETE ON attachment_receipt_ignores
  BEGIN
    SELECT RAISE(ABORT, 'receipt ignore records are immutable');
  END;

`;

export function createAttachmentConversationOutboxIdempotencyKey(
  event: Pick<
    AttachmentInboundEvent,
    'id' | 'backendUrl' | 'roomToken' | 'actorId' | 'messageId'
  >,
  activeEventIds: readonly string[] = [event.id],
): string {
  const messageDigest = createHash('sha256')
    .update('attachment-conversation-v1\0')
    .update(event.backendUrl)
    .update('\0')
    .update(event.roomToken)
    .update('\0')
    .update(event.actorId)
    .update('\0')
    .update(event.messageId)
    .digest('hex');
  const setDigest = createHash('sha256');
  for (const eventId of [...new Set(activeEventIds)].sort()) {
    setDigest.update(eventId).update('\0');
  }
  return `attachment-conversation:${messageDigest}:${setDigest.digest('hex')}`;
}

function attachmentConversationFallbackReply(
  event: AttachmentInboundEvent,
): TalkReply {
  return {
    roomToken: event.roomToken,
    message:
      "I saved the receipt, but I couldn't finish checking it right now. Nothing changed in Actual.",
    replyTo: event.messageId,
    referenceId: createAttachmentTalkReplyReferenceId(
      event.idempotencyKey,
      'conversation-fallback',
    ),
    silent: false,
  };
}

function attachmentConversationAvailableAt(now: string): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('Attachment conversation time must be an ISO instant');
  }
  return new Date(timestamp + ATTACHMENT_CONVERSATION_SETTLE_MS).toISOString();
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function toInboundEvent(row: AttachmentInboundRow): AttachmentInboundEvent {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    backendUrl: row.backend_url,
    roomToken: row.room_token,
    actorId: row.actor_id,
    messageId: row.message_id,
    attachment: {
      fileId: row.file_id,
      etag: row.source_etag,
      sizeBytes: row.source_size_bytes,
      mediaType: row.source_media_type,
    },
    ...(row.caption_hint === null ? {} : { captionHint: row.caption_hint }),
    receivedAt: row.received_at,
  };
}

function toShadowItem(row: AttachmentShadowRow): AttachmentShadowItem {
  return {
    eventId: row.event_id,
    status: row.status,
    ...(row.archive_path === null ? {} : { archivePath: row.archive_path }),
    ...(row.source_sha256 === null ? {} : { sourceSha256: row.source_sha256 }),
    ...(row.proposal_json === null
      ? {}
      : { proposal: parseJson(row.proposal_json) }),
    ...(row.model_metadata_json === null
      ? {}
      : {
          modelMetadata: parseJson(
            row.model_metadata_json,
          ) as ReceiptModelRunMetadata,
        }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * This store is deliberately isolated. The attachment model lane therefore
 * has no method capable of creating or linking an Actual transaction.
 */
export class AttachmentShadowStore {
  readonly #database: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = new Database(databasePath);
    this.#database.exec(attachmentSchema);
  }

  close(): void {
    this.#database.close();
  }

  recordInbound(input: AttachmentInboundEventInput): {
    event: AttachmentInboundEvent;
    inserted: boolean;
  } {
    if (
      input.captionHint !== undefined &&
      (input.captionHint.length === 0 ||
        input.captionHint.length > 2_000 ||
        input.captionHint !== input.captionHint.normalize('NFC').trim() ||
        input.captionHint.includes('\0'))
    ) {
      throw new TypeError('Attachment caption hint is invalid');
    }
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          'SELECT * FROM attachment_inbound_events WHERE idempotency_key = ?',
        )
        .get(input.idempotencyKey) as AttachmentInboundRow | undefined;
      if (existing !== undefined) {
        const event = toInboundEvent(existing);
        if (
          event.backendUrl !== input.backendUrl ||
          event.roomToken !== input.roomToken ||
          event.actorId !== input.actorId ||
          event.messageId !== input.messageId ||
          event.attachment.fileId !== input.attachment.fileId ||
          event.attachment.etag !== input.attachment.etag ||
          event.attachment.sizeBytes !== input.attachment.sizeBytes ||
          event.attachment.mediaType !== input.attachment.mediaType ||
          event.captionHint !== input.captionHint
        ) {
          throw new Error('Attachment replay conflicts with persisted event');
        }
        return { event, inserted: false };
      }

      const id = randomUUID();
      this.#database
        .prepare(
          `INSERT INTO attachment_inbound_events (
             id,
             idempotency_key,
             backend_url,
             room_token,
             actor_id,
             message_id,
             file_id,
             source_etag,
             source_size_bytes,
             source_media_type,
             caption_hint,
             received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.idempotencyKey,
          input.backendUrl,
          input.roomToken,
          input.actorId,
          input.messageId,
          input.attachment.fileId,
          input.attachment.etag,
          input.attachment.sizeBytes,
          input.attachment.mediaType,
          input.captionHint ?? null,
          input.receivedAt,
        );
      this.#database
        .prepare(
          `INSERT INTO attachment_shadow_items (
             event_id, status, created_at, updated_at
           ) VALUES (?, 'received', ?, ?)`,
        )
        .run(id, input.receivedAt, input.receivedAt);
      this.#enqueue(
        'process-attachment-shadow',
        id,
        {},
        `process-attachment-shadow:${input.idempotencyKey}`,
        input.receivedAt,
      );
      this.#appendAudit(id, 'attachment.received', {}, input.receivedAt);

      return {
        event: {
          id,
          ...input,
        },
        inserted: true,
      };
    })();
  }

  getInbound(eventId: string): AttachmentInboundEvent | undefined {
    const row = this.#database
      .prepare('SELECT * FROM attachment_inbound_events WHERE id = ?')
      .get(eventId) as AttachmentInboundRow | undefined;
    return row === undefined ? undefined : toInboundEvent(row);
  }

  findReceiptByIdempotencyKey(
    idempotencyKey: string,
  ): ReceiptAttachmentReference | undefined {
    const row = this.#database
      .prepare(
        `SELECT id
           FROM attachment_inbound_events
          WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as { id: string } | undefined;
    if (row === undefined) {
      return undefined;
    }
    const event = this.getInbound(row.id);
    const shadow = this.getShadowItem(row.id);
    if (event === undefined || shadow === undefined) {
      throw new Error('Attachment identity has incomplete persisted state');
    }
    return {
      event,
      shadow,
      ignored: this.#receiptIsIgnored(row.id),
    };
  }

  getShadowItem(eventId: string): AttachmentShadowItem | undefined {
    const row = this.#database
      .prepare('SELECT * FROM attachment_shadow_items WHERE event_id = ?')
      .get(eventId) as AttachmentShadowRow | undefined;
    return row === undefined ? undefined : toShadowItem(row);
  }

  listCompletedShadows(limit = 1_000): CompletedAttachmentShadow[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('Completed shadow limit is outside safe bounds');
    }
    const rows = this.#database
      .prepare(
        `SELECT inbound.*,
                item.event_id AS shadow_event_id,
                item.status AS shadow_status,
                item.archive_path,
                item.source_sha256,
                item.proposal_json,
                item.model_metadata_json,
                item.error_code,
                item.created_at AS shadow_created_at,
                item.updated_at AS shadow_updated_at
           FROM attachment_shadow_items AS item
           JOIN attachment_inbound_events AS inbound
             ON inbound.id = item.event_id
          WHERE item.status = 'completed'
            AND item.source_sha256 IS NOT NULL
            AND item.proposal_json IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM attachment_receipt_ignores AS ignored
                JOIN attachment_shadow_items AS ignored_item
                  ON ignored_item.event_id = ignored.event_id
               WHERE ignored.event_id = item.event_id
                  OR ignored_item.source_sha256 = item.source_sha256
            )
          ORDER BY inbound.received_at, inbound.rowid
          LIMIT ?`,
      )
      .all(limit) as Array<
      AttachmentInboundRow & {
        shadow_event_id: string;
        shadow_status: 'completed';
        archive_path: string | null;
        source_sha256: string;
        proposal_json: string;
        model_metadata_json: string | null;
        error_code: null;
        shadow_created_at: string;
        shadow_updated_at: string;
      }
    >;
    return rows.map((row) => ({
      event: toInboundEvent(row),
      shadow: {
        eventId: row.shadow_event_id,
        status: row.shadow_status,
        ...(row.archive_path === null ? {} : { archivePath: row.archive_path }),
        sourceSha256: row.source_sha256,
        proposal: JSON.parse(row.proposal_json) as unknown,
        ...(row.model_metadata_json === null
          ? {}
          : {
              modelMetadata: JSON.parse(
                row.model_metadata_json,
              ) as ReceiptModelRunMetadata,
            }),
        createdAt: row.shadow_created_at,
        updatedAt: row.shadow_updated_at,
      },
    }));
  }

  findReceiptsByRoomMessage(
    roomToken: string,
    messageId: string,
  ): readonly ReceiptAttachmentReference[] {
    const rows = this.#database
      .prepare(
        `SELECT inbound.*,
                item.event_id AS shadow_event_id,
                item.status AS shadow_status,
                item.archive_path,
                item.source_sha256,
                item.proposal_json,
                item.model_metadata_json,
                item.error_code,
                item.created_at AS shadow_created_at,
                item.updated_at AS shadow_updated_at,
                EXISTS (
                  SELECT 1
                    FROM attachment_receipt_ignores AS ignored
                    JOIN attachment_shadow_items AS ignored_item
                      ON ignored_item.event_id = ignored.event_id
                   WHERE ignored.event_id = inbound.id
                      OR (
                        item.source_sha256 IS NOT NULL
                        AND ignored_item.source_sha256 = item.source_sha256
                      )
                ) AS receipt_ignored
           FROM attachment_inbound_events AS inbound
           JOIN attachment_shadow_items AS item
             ON item.event_id = inbound.id
          WHERE inbound.room_token = ?
            AND inbound.message_id = ?
          ORDER BY inbound.received_at, inbound.rowid
          LIMIT 33`,
      )
      .all(roomToken, messageId) as Array<
      AttachmentInboundRow & {
        shadow_event_id: string;
        shadow_status: AttachmentShadowStatus;
        archive_path: string | null;
        source_sha256: string | null;
        proposal_json: string | null;
        model_metadata_json: string | null;
        error_code: string | null;
        shadow_created_at: string;
        shadow_updated_at: string;
        receipt_ignored: 0 | 1;
      }
    >;
    if (rows.length > 32) {
      throw new RangeError('Talk message contains too many attachments');
    }
    return rows.map((row) => ({
      event: toInboundEvent(row),
      shadow: toShadowItem({
        event_id: row.shadow_event_id,
        status: row.shadow_status,
        archive_path: row.archive_path,
        source_sha256: row.source_sha256,
        proposal_json: row.proposal_json,
        model_metadata_json: row.model_metadata_json,
        error_code: row.error_code,
        created_at: row.shadow_created_at,
        updated_at: row.shadow_updated_at,
      }),
      ignored: row.receipt_ignored === 1,
    }));
  }

  ignoreReceipt(input: {
    readonly eventId: string;
    readonly roomToken: string;
    readonly actorId: string;
    readonly inboundMessageId: string;
    readonly ignoredAt: string;
  }): IgnoreReceiptAttachmentResult {
    return this.#database.transaction((): IgnoreReceiptAttachmentResult => {
      const event = this.getInbound(input.eventId);
      const shadow = this.getShadowItem(input.eventId);
      if (event === undefined || shadow === undefined) {
        throw new Error('Unknown receipt attachment');
      }
      if (event.roomToken !== input.roomToken) {
        throw new Error('Receipt attachment room does not match');
      }
      const existingByMessageAndEvent = this.#database
        .prepare(
          `SELECT event_id
             FROM attachment_receipt_ignores
            WHERE inbound_message_id = ? AND event_id = ?
            LIMIT 1`,
        )
        .get(input.inboundMessageId, input.eventId) as
        { event_id: string } | undefined;
      if (existingByMessageAndEvent !== undefined) {
        return { status: 'already-ignored' };
      }
      const existingReceipt = this.#database
        .prepare(
          `SELECT ignored.event_id
             FROM attachment_receipt_ignores AS ignored
             JOIN attachment_shadow_items AS ignored_item
               ON ignored_item.event_id = ignored.event_id
            WHERE ignored.event_id = ?
               OR (
                 ? IS NOT NULL
                 AND ignored_item.source_sha256 = ?
               )
            LIMIT 1`,
        )
        .get(
          input.eventId,
          shadow.sourceSha256 ?? null,
          shadow.sourceSha256 ?? null,
        );
      if (existingReceipt !== undefined) {
        return { status: 'already-ignored' };
      }
      const stillProcessing =
        shadow.status !== 'completed' && shadow.status !== 'failed';
      this.#database
        .prepare(
          `INSERT INTO attachment_receipt_ignores (
             event_id, room_token, actor_id, inbound_message_id, ignored_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.eventId,
          input.roomToken,
          input.actorId,
          input.inboundMessageId,
          input.ignoredAt,
        );
      this.#database
        .prepare(
          `UPDATE attachment_outbox
              SET state = 'failed',
                  locked_at = NULL,
                  last_error = 'receipt-ignored'
            WHERE state = 'pending'
              AND event_id IN (
                SELECT candidate.event_id
                  FROM attachment_shadow_items AS candidate
                 WHERE candidate.event_id = ?
                    OR (
                      ? IS NOT NULL
                      AND candidate.source_sha256 = ?
                    )
              )`,
        )
        .run(
          input.eventId,
          shadow.sourceSha256 ?? null,
          shadow.sourceSha256 ?? null,
        );
      this.#appendAudit(
        input.eventId,
        'attachment.receipt-ignored',
        {
          actorId: input.actorId,
          inboundMessageId: input.inboundMessageId,
        },
        input.ignoredAt,
      );
      return { status: stillProcessing ? 'still-processing' : 'ignored' };
    })();
  }

  findCompletedBySourceSha256(
    sourceSha256: string,
    excludingEventId: string,
  ):
    | {
        eventId: string;
        proposal: unknown;
        modelMetadata: ReceiptModelRunMetadata;
      }
    | undefined {
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
      throw new TypeError('Source SHA-256 must be lowercase hexadecimal');
    }
    const row = this.#database
      .prepare(
        `SELECT event_id, proposal_json, model_metadata_json
           FROM attachment_shadow_items
          WHERE status = 'completed'
            AND source_sha256 = ?
            AND event_id <> ?
            AND proposal_json IS NOT NULL
            AND model_metadata_json IS NOT NULL
          ORDER BY created_at, event_id
          LIMIT 1`,
      )
      .get(sourceSha256, excludingEventId) as
      | {
          event_id: string;
          proposal_json: string;
          model_metadata_json: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          eventId: row.event_id,
          proposal: parseJson(row.proposal_json),
          modelMetadata: parseJson(
            row.model_metadata_json,
          ) as ReceiptModelRunMetadata,
        };
  }

  markPreserved(
    eventId: string,
    archivePath: string,
    sourceSha256: string,
    now: string,
  ): void {
    this.#updateShadow(
      eventId,
      `status = 'preserved',
       archive_path = ?,
       source_sha256 = ?,
       error_code = NULL`,
      [archivePath, sourceSha256],
      now,
    );
    this.#appendAudit(eventId, 'attachment.preserved', { sourceSha256 }, now);
  }

  completeShadowAndEnqueueConversation(
    eventId: string,
    proposal: unknown,
    metadata: ReceiptModelRunMetadata,
    now: string,
  ): void {
    this.#database.transaction(() => {
      this.#updateShadow(
        eventId,
        `status = 'completed',
         proposal_json = ?,
         model_metadata_json = ?,
         error_code = NULL`,
        [JSON.stringify(proposal), JSON.stringify(metadata)],
        now,
      );
      this.#appendAudit(
        eventId,
        'attachment.shadow-completed',
        {
          provider: metadata.provider,
          requestedModel: metadata.requestedModel,
          resolvedModel: metadata.resolvedModel,
          zeroDataRetention: metadata.zeroDataRetention,
          costInUsdTicks: metadata.usage?.costInUsdTicks ?? null,
        },
        now,
      );
      if (!this.#receiptIsIgnored(eventId)) {
        const event = this.getInbound(eventId);
        if (event === undefined) {
          throw new Error('Attachment conversation event is missing');
        }
        this.#enqueueAttachmentConversation(event, now);
      }
      this.#database
        .prepare('DELETE FROM attachment_provider_calls WHERE event_id = ?')
        .run(eventId);
    })();
  }

  completeReusedShadowAndEnqueueConversation(
    eventId: string,
    proposal: unknown,
    metadata: ReceiptModelRunMetadata,
    reusedEventId: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      this.#updateShadow(
        eventId,
        `status = 'completed',
         proposal_json = ?,
         model_metadata_json = ?,
         error_code = NULL`,
        [JSON.stringify(proposal), JSON.stringify(metadata)],
        now,
      );
      this.#appendAudit(
        eventId,
        'attachment.shadow-reused',
        { reusedEventId },
        now,
      );
      if (!this.#receiptIsIgnored(eventId)) {
        const event = this.getInbound(eventId);
        if (event === undefined) {
          throw new Error('Attachment conversation event is missing');
        }
        this.#enqueueAttachmentConversation(event, now);
      }
    })();
  }

  markFailed(eventId: string, errorCode: string, now: string): void {
    this.#updateShadow(
      eventId,
      `status = 'failed', error_code = ?`,
      [errorCode],
      now,
    );
    this.#appendAudit(eventId, 'attachment.shadow-failed', { errorCode }, now);
  }

  startProviderCall(eventId: string, now: string): void {
    this.#database.transaction(() => {
      const shadow = this.getShadowItem(eventId);
      if (shadow?.status !== 'preserved') {
        throw new Error('Attachment is not ready for a provider call');
      }
      this.#database
        .prepare(
          `INSERT INTO attachment_provider_calls (event_id, started_at)
           VALUES (?, ?)`,
        )
        .run(eventId, now);
      this.#appendAudit(eventId, 'attachment.provider-call-started', {}, now);
    })();
  }

  clearProviderCallBeforeSend(eventId: string, now: string): void {
    this.#database.transaction(() => {
      const deleted = this.#database
        .prepare('DELETE FROM attachment_provider_calls WHERE event_id = ?')
        .run(eventId);
      if (deleted.changes !== 1) {
        throw new Error('Attachment provider call marker is not active');
      }
      this.#appendAudit(eventId, 'attachment.provider-call-not-sent', {}, now);
    })();
  }

  failProcessingAndEnqueueReply(
    jobId: number,
    eventId: string,
    errorCode: string,
    reply: TalkReply,
    replyIdempotencyKey: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE attachment_outbox
              SET state = 'failed', locked_at = NULL, last_error = ?
            WHERE id = ? AND state = 'processing'`,
        )
        .run(errorCode, jobId);
      if (result.changes !== 1) {
        throw new Error('Attachment processing outbox job is not claimed');
      }
      this.markFailed(eventId, errorCode, now);
      this.#database
        .prepare('DELETE FROM attachment_provider_calls WHERE event_id = ?')
        .run(eventId);
      if (!this.#receiptIsIgnored(eventId)) {
        this.#enqueue(
          'deliver-attachment-result',
          eventId,
          { type: 'talk-reply', reply } satisfies AttachmentDeliveryPayload,
          replyIdempotencyKey,
          now,
        );
      }
    })();
  }

  claimNextOutbox(now: string): AttachmentOutboxJob | undefined {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT outbox.id,
                  outbox.idempotency_key,
                  outbox.kind,
                  outbox.event_id,
                  outbox.payload_json,
                  outbox.attempt_count
             FROM attachment_outbox AS outbox
             JOIN attachment_shadow_items AS item
               ON item.event_id = outbox.event_id
            WHERE outbox.state = 'pending'
              AND outbox.available_at <= ?
              AND NOT EXISTS (
                SELECT 1
                  FROM attachment_receipt_ignores AS ignored
                  JOIN attachment_shadow_items AS ignored_item
                    ON ignored_item.event_id = ignored.event_id
                 WHERE ignored.event_id = outbox.event_id
                    OR (
                      item.source_sha256 IS NOT NULL
                      AND ignored_item.source_sha256 = item.source_sha256
                    )
              )
            ORDER BY outbox.id
            LIMIT 1`,
        )
        .get(now) as AttachmentOutboxRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      this.#database
        .prepare(
          `UPDATE attachment_outbox
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  locked_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(now, row.id);
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
    this.#database
      .prepare(
        `UPDATE attachment_outbox
            SET state = 'completed', completed_at = ?, locked_at = NULL
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
  }

  completeTalkReplyOutbox(
    jobId: number,
    eventId: string,
    referenceId: string,
    now: string,
  ): void {
    this.#database.transaction(() => {
      this.#completeClaimedOutbox(jobId, now);
      this.#appendAudit(
        eventId,
        'attachment.talk-reply-delivered',
        { referenceId },
        now,
      );
    })();
  }

  retryOutbox(jobId: number, errorCode: string, availableAt: string): void {
    this.#database
      .prepare(
        `UPDATE attachment_outbox
            SET state = 'pending',
                available_at = ?,
                locked_at = NULL,
                last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(availableAt, errorCode, jobId);
  }

  failOutbox(jobId: number, errorCode: string): void {
    this.#database
      .prepare(
        `UPDATE attachment_outbox
            SET state = 'failed', locked_at = NULL, last_error = ?
          WHERE id = ? AND state = 'processing'`,
      )
      .run(errorCode, jobId);
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
          `UPDATE attachment_outbox
              SET state = 'failed', locked_at = NULL, last_error = ?
            WHERE id = ? AND state = 'processing'`,
        )
        .run(errorCode, jobId);
      if (result.changes !== 1) {
        throw new Error('Attachment Talk reply outbox job is not claimed');
      }
      this.#appendAudit(
        eventId,
        'attachment.talk-reply-dead-lettered',
        { errorCode },
        now,
      );
    })();
  }

  recoverInterruptedOutbox(now: string): number {
    return this.#database.transaction(() => {
      let recovered = 0;
      const uncertainCalls = this.#database
        .prepare(
          `SELECT event_id
             FROM attachment_provider_calls
            ORDER BY event_id`,
        )
        .all() as Array<{ event_id: string }>;
      for (const call of uncertainCalls) {
        const event = this.getInbound(call.event_id);
        if (event === undefined) {
          throw new Error('Interrupted provider call has no inbound event');
        }
        recovered += this.#database
          .prepare(
            `UPDATE attachment_outbox
                SET state = 'failed',
                    locked_at = NULL,
                    last_error = 'provider-outcome-unknown'
              WHERE event_id = ?
                AND kind = 'process-attachment-shadow'
                AND state IN ('pending', 'processing')`,
          )
          .run(event.id).changes;
        this.markFailed(event.id, 'provider-outcome-unknown', now);
        if (!this.#receiptIsIgnored(event.id)) {
          this.#enqueue(
            'deliver-attachment-result',
            event.id,
            {
              type: 'talk-reply',
              reply: {
                roomToken: event.roomToken,
                message:
                  'Something interrupted me while I was reading this receipt. Nothing changed in Actual. Please send the receipt again.',
                replyTo: event.messageId,
                referenceId: createAttachmentTalkReplyReferenceId(
                  event.idempotencyKey,
                  'shadow-failed',
                ),
                silent: false,
              },
            } satisfies AttachmentDeliveryPayload,
            `attachment-talk-reply:${event.idempotencyKey}:failed`,
            now,
          );
        }
        this.#database
          .prepare('DELETE FROM attachment_provider_calls WHERE event_id = ?')
          .run(event.id);
        this.#appendAudit(
          event.id,
          'attachment.provider-outcome-unknown',
          {},
          now,
        );
      }
      recovered += this.#database
        .prepare(
          `UPDATE attachment_outbox
              SET state = 'pending', available_at = ?, locked_at = NULL
            WHERE state = 'processing'`,
        )
        .run(now).changes;
      return recovered;
    })();
  }

  listAudit(eventId: string): AttachmentAuditEvent[] {
    const rows = this.#database
      .prepare(
        `SELECT id, event_id, action, detail_json, occurred_at
           FROM attachment_audit_events
          WHERE event_id = ?
          ORDER BY id`,
      )
      .all(eventId) as AttachmentAuditRow[];
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      action: row.action,
      detail: parseJson(row.detail_json),
      occurredAt: row.occurred_at,
    }));
  }

  #completeClaimedOutbox(jobId: number, now: string): void {
    const result = this.#database
      .prepare(
        `UPDATE attachment_outbox
            SET state = 'completed', completed_at = ?, locked_at = NULL
          WHERE id = ? AND state = 'processing'`,
      )
      .run(now, jobId);
    if (result.changes !== 1) {
      throw new Error('Attachment outbox job is not claimed');
    }
  }

  #updateShadow(
    eventId: string,
    assignments: string,
    values: readonly unknown[],
    now: string,
  ): void {
    const result = this.#database
      .prepare(
        `UPDATE attachment_shadow_items
            SET ${assignments}, updated_at = ?
          WHERE event_id = ?`,
      )
      .run(...values, now, eventId);
    if (result.changes !== 1) {
      throw new Error('Unknown attachment shadow event');
    }
  }

  #activeConversationEventIds(event: AttachmentInboundEvent): string[] {
    return (
      this.#database
        .prepare(
          `SELECT inbound.id
             FROM attachment_inbound_events AS inbound
             LEFT JOIN attachment_receipt_ignores AS ignored
               ON ignored.event_id = inbound.id
            WHERE inbound.backend_url = ?
              AND inbound.room_token = ?
              AND inbound.actor_id = ?
              AND inbound.message_id = ?
              AND ignored.event_id IS NULL
            ORDER BY inbound.id ASC`,
        )
        .all(
          event.backendUrl,
          event.roomToken,
          event.actorId,
          event.messageId,
        ) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  #enqueueAttachmentConversation(
    event: AttachmentInboundEvent,
    now: string,
  ): void {
    const idempotencyKey = createAttachmentConversationOutboxIdempotencyKey(
      event,
      this.#activeConversationEventIds(event),
    );
    const keyPrefix = `${idempotencyKey.slice(0, idempotencyKey.lastIndexOf(':') + 1)}%`;
    this.#database
      .prepare(
        `UPDATE attachment_outbox
            SET state = 'failed',
                locked_at = NULL,
                last_error = 'superseded-by-related-photo'
          WHERE kind = 'deliver-attachment-result'
            AND state = 'pending'
            AND idempotency_key LIKE ?
            AND idempotency_key <> ?`,
      )
      .run(keyPrefix, idempotencyKey);
    this.#enqueue(
      'deliver-attachment-result',
      event.id,
      {
        type: 'conversation-handoff',
        fallbackReply: attachmentConversationFallbackReply(event),
      } satisfies AttachmentDeliveryPayload,
      idempotencyKey,
      now,
      attachmentConversationAvailableAt(now),
    );
  }

  #enqueue(
    kind: AttachmentOutboxKind,
    eventId: string,
    payload: unknown,
    idempotencyKey: string,
    now: string,
    availableAt = now,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO attachment_outbox (
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
        JSON.stringify(payload),
        availableAt,
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
        `INSERT INTO attachment_audit_events (
           event_id,
           action,
           detail_json,
           occurred_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(eventId, action, JSON.stringify(detail), occurredAt);
  }

  #receiptIsIgnored(eventId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1
             FROM attachment_shadow_items AS item
            WHERE item.event_id = ?
              AND EXISTS (
                SELECT 1
                  FROM attachment_receipt_ignores AS ignored
                  JOIN attachment_shadow_items AS ignored_item
                    ON ignored_item.event_id = ignored.event_id
                 WHERE ignored.event_id = item.event_id
                    OR (
                      item.source_sha256 IS NOT NULL
                      AND ignored_item.source_sha256 = item.source_sha256
                    )
              )
            LIMIT 1`,
        )
        .get(eventId) !== undefined
    );
  }
}
