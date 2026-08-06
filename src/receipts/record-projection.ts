import { z } from 'zod';

import type { ActualReceiptRecordReadPort } from '../actual-read/port.js';
import {
  canonicalReceiptNoteOperationJson,
  type ReceiptNoteOutboxLatestInternal,
  type ReceiptNoteOutboxStore,
} from '../actual-receipt-note/index.js';
import {
  canonicalizeHouseholdReceiptCurrency,
  receiptModelProposalV1Schema,
} from '../model/index.js';
import {
  canonicalizeHouseholdFinanceReceiptHouseholdNotes,
  canonicalHouseholdFinanceReceiptJson,
  householdFinanceActiveReceiptRecordSchema,
  householdFinanceReceiptHouseholdNoteSchema,
  householdFinanceReceiptSha256,
  MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
  parseHouseholdFinanceReceiptRecord,
  type HouseholdFinanceActiveReceiptRecordV1,
  type HouseholdFinanceReceiptRecordV1,
} from '../receipt-record/index.js';
import type {
  AttachmentShadowStore,
  CompletedAttachmentShadow,
} from '../storage/attachment-shadow-store.js';
import {
  buildActiveReceiptRecord,
  bundleReceiptPhotos,
  type ReceiptPhotoBundle,
  type ReceiptPhotoCandidate,
} from './photo-bundler.js';
import type { ReceiptRecordPublisher } from './publication.js';

const DEFAULT_SETTLE_MS = 15 * 60 * 1_000;
const MAXIMUM_SHADOWS = 10_000;
const canonicalUuid = z.uuid();

export interface CanonicalReceiptRecordProjectionSourceOptions {
  readonly maximumRecords?: number;
}

export interface CanonicalReceiptFreshnessSource {
  isCurrentReceiptSource(receiptId: string, sourceSha256: string): boolean;
}

/**
 * Rebuildable view of canonical Actual receipt records that are ready for
 * automatic processing. Deleting and recreating the SQLite categorization
 * database therefore does not need the attachment-shadow database.
 */
export class CanonicalReceiptRecordProjectionSource {
  readonly #maximumRecords: number;
  #records: readonly HouseholdFinanceActiveReceiptRecordV1[] = [];
  #current = new Map<
    string,
    {
      readonly sourceSha256: string;
      readonly ready: boolean;
    }
  >();

  constructor(options: CanonicalReceiptRecordProjectionSourceOptions = {}) {
    const maximumRecords =
      options.maximumRecords ?? MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS;
    if (
      !Number.isSafeInteger(maximumRecords) ||
      maximumRecords < 1 ||
      maximumRecords > MAXIMUM_SHADOWS
    ) {
      throw new RangeError('Receipt projection bound is invalid');
    }
    this.#maximumRecords = maximumRecords;
  }

  /**
   * This is the hydration boundary for both the local confirmed-write producer
   * and a future Actual reader. Only the newest active revision for each
   * receipt is projected; discarded receipts disappear from the projection.
   */
  replaceCanonicalRecords(
    recordsInput: readonly HouseholdFinanceReceiptRecordV1[],
  ): void {
    this.replaceCanonicalState(recordsInput, recordsInput);
  }

  replaceCanonicalState(
    currentRecordsInput: readonly HouseholdFinanceReceiptRecordV1[],
    readyRecordsInput: readonly HouseholdFinanceReceiptRecordV1[],
  ): void {
    const current = this.#latestRecords(currentRecordsInput);
    const ready = this.#latestRecords(readyRecordsInput);
    const currentByReceiptId = new Map(
      current.map((record) => [record.receiptId, record] as const),
    );
    const readyHashes = new Map<string, string>();
    for (const record of ready) {
      const currentRecord = currentByReceiptId.get(record.receiptId);
      if (
        currentRecord === undefined ||
        householdFinanceReceiptSha256(currentRecord) !==
          householdFinanceReceiptSha256(record)
      ) {
        throw new Error(
          'Ready receipt projection is not the latest canonical revision',
        );
      }
      readyHashes.set(record.receiptId, householdFinanceReceiptSha256(record));
    }
    this.#current = new Map(
      current.map((record) => {
        const sourceSha256 = householdFinanceReceiptSha256(record);
        return [
          record.receiptId,
          {
            sourceSha256,
            ready:
              record.status === 'active' &&
              record.extraction.automaticProcessingBlocked !== true &&
              readyHashes.get(record.receiptId) === sourceSha256,
          },
        ] as const;
      }),
    );
    this.#records = ready
      .filter(
        (record): record is HouseholdFinanceActiveReceiptRecordV1 =>
          record.status === 'active' &&
          record.extraction.automaticProcessingBlocked !== true,
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.receiptId.localeCompare(right.receiptId),
      );
  }

  isCurrentReceiptSource(
    receiptIdInput: string,
    sourceSha256Input: string,
  ): boolean {
    const receiptId = canonicalUuid.parse(receiptIdInput);
    const sourceSha256 = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(sourceSha256Input);
    const current = this.#current.get(receiptId);
    return current?.ready === true && current.sourceSha256 === sourceSha256;
  }

  #latestRecords(
    recordsInput: readonly HouseholdFinanceReceiptRecordV1[],
  ): readonly HouseholdFinanceReceiptRecordV1[] {
    if (recordsInput.length > this.#maximumRecords) {
      throw new RangeError('Receipt projection exceeds its configured bound');
    }
    const latest = new Map<string, HouseholdFinanceReceiptRecordV1>();
    for (const input of recordsInput) {
      const record = parseHouseholdFinanceReceiptRecord(input);
      const existing = latest.get(record.receiptId);
      if (existing === undefined || record.revision > existing.revision) {
        latest.set(record.receiptId, record);
      } else if (
        record.revision === existing.revision &&
        householdFinanceReceiptSha256(record) !==
          householdFinanceReceiptSha256(existing)
      ) {
        throw new Error('Canonical receipt revision has conflicting content');
      }
    }
    return [...latest.values()];
  }

  listActiveRecords(
    limit = this.#maximumRecords,
  ): readonly HouseholdFinanceActiveReceiptRecordV1[] {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > this.#maximumRecords
    ) {
      throw new RangeError('Receipt projection limit is outside safe bounds');
    }
    return this.#records.slice(0, limit);
  }
}

export interface ReceiptRecordPublicationWorkflowOptions {
  readonly attachments: Pick<AttachmentShadowStore, 'listCompletedShadows'> &
    Partial<Pick<AttachmentShadowStore, 'findReceiptsByRoomMessage'>>;
  readonly outbox: Pick<
    ReceiptNoteOutboxStore,
    'getLatestInternal' | 'listLatestInternal'
  >;
  readonly publisher: Pick<ReceiptRecordPublisher, 'publish'>;
  readonly projection: CanonicalReceiptRecordProjectionSource;
  readonly roomToken: string;
  readonly settleMs?: number;
  readonly now?: () => Date;
}

export interface ReceiptRecordPublicationRunResult {
  readonly scanned: number;
  readonly candidates: number;
  readonly bundles: number;
  readonly invalid: number;
  readonly unsettled: number;
  readonly published: number;
  readonly waitingForActual: number;
  readonly visible: number;
}

export interface CanonicalReceiptSourceReference {
  readonly roomToken: string;
  readonly messageId: string;
  readonly nextcloudFileId: string;
  readonly sourceSha256: string | undefined;
}

export interface CanonicalReceiptExactSourceReference extends CanonicalReceiptSourceReference {
  readonly sourceSha256: string;
}

export type ReceiptRecordDiscardResult =
  | { readonly status: 'not-found' }
  | {
      readonly status: 'blocked';
      readonly receiptId: string;
      readonly reason: 'prior-write-failed';
    }
  | {
      readonly status: 'recorded';
      readonly receiptId: string;
      readonly revision: number;
      readonly inserted: boolean;
      readonly outboxStatus: string;
    };

export type ReceiptRecordSourceRemovalResult =
  | { readonly status: 'not-found' }
  | {
      readonly status: 'blocked';
      readonly reason:
        | 'prior-write-pending'
        | 'source-not-found'
        | 'source-rebuild-unavailable';
    }
  | {
      readonly status: 'recorded';
      readonly receiptId: string;
      readonly revision: number;
      readonly inserted: boolean;
      readonly outboxStatus: string;
      readonly remainingSourceCount: number;
    }
  | {
      readonly status: 'discarded';
      readonly result: Exclude<
        ReceiptRecordDiscardResult,
        { readonly status: 'not-found' }
      >;
    };

export type ReceiptRecordHouseholdNoteResult =
  | { readonly status: 'not-found' }
  | { readonly status: 'unchanged' }
  | { readonly status: 'stale' }
  | { readonly status: 'conflict' }
  | {
      readonly status: 'blocked';
      readonly reason: 'prior-write-pending';
    }
  | {
      readonly status: 'recorded';
      readonly receiptId: string;
      readonly revision: number;
      readonly inserted: boolean;
      readonly outboxStatus: string;
    };

/**
 * Attachment shadows are an initial producer only. This workflow bundles
 * immutable sources, publishes one canonical note, then exposes the record to
 * categorization only after the isolated writer has confirmed the Actual
 * read-back. The projection can therefore be rebuilt from Actual alone.
 */
export class ReceiptRecordPublicationWorkflow {
  readonly #attachments: ReceiptRecordPublicationWorkflowOptions['attachments'];
  readonly #outbox: ReceiptRecordPublicationWorkflowOptions['outbox'];
  readonly #publisher: ReceiptRecordPublicationWorkflowOptions['publisher'];
  readonly #projection: CanonicalReceiptRecordProjectionSource;
  readonly #roomToken: string;
  readonly #settleMs: number;
  readonly #now: () => Date;
  #actualRecords: readonly HouseholdFinanceReceiptRecordV1[] = [];

  constructor(options: ReceiptRecordPublicationWorkflowOptions) {
    this.#attachments = options.attachments;
    this.#outbox = options.outbox;
    this.#publisher = options.publisher;
    this.#projection = options.projection;
    this.#roomToken = z.string().min(1).max(500).parse(options.roomToken);
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    if (
      !Number.isSafeInteger(this.#settleMs) ||
      this.#settleMs < 0 ||
      this.#settleMs > 60 * 60 * 1_000
    ) {
      throw new RangeError('Receipt bundle settle interval is invalid');
    }
    this.#now = options.now ?? (() => new Date());
  }

  runOnce(limit = MAXIMUM_SHADOWS): ReceiptRecordPublicationRunResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_SHADOWS) {
      throw new RangeError('Receipt publication scan limit is invalid');
    }
    const completed = this.#attachments
      .listCompletedShadows(MAXIMUM_SHADOWS)
      .filter((candidate) => candidate.event.roomToken === this.#roomToken)
      .slice(0, limit);
    const parsed = canonicalPhotoCandidates(completed);
    const discardedSourceSha256s = new Set(
      this.#mergedCanonicalRecords().flatMap((record) =>
        record.status === 'discarded'
          ? record.sources.map((source) => source.sha256)
          : [],
      ),
    );
    const candidates = parsed.candidates
      .filter(
        (candidate) => !discardedSourceSha256s.has(candidate.sourceSha256),
      )
      .map((candidate) => ({
        ...candidate,
        relatedAttachmentBlocked:
          this.#attachments
            .findReceiptsByRoomMessage?.(
              candidate.roomToken,
              candidate.messageId,
            )
            .some(
              (related) =>
                !related.ignored && related.shadow.status !== 'completed',
            ) ?? false,
      }));
    const invalid = parsed.invalid;
    const bundles = bundleReceiptPhotos(candidates);
    if (bundles.length > MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS) {
      throw new RangeError('Canonical receipt record bound was exceeded');
    }
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError('Receipt publication clock returned an invalid Date');
    }

    let unsettled = 0;
    let published = 0;
    let waitingForActual = 0;
    const activeOwnersBySourceHash = new Map<string, Set<string>>();
    for (const record of this.#mergedCanonicalRecords()) {
      if (record.status !== 'active') {
        continue;
      }
      for (const source of record.sources) {
        const owners =
          activeOwnersBySourceHash.get(source.sha256) ?? new Set<string>();
        owners.add(record.receiptId);
        activeOwnersBySourceHash.set(source.sha256, owners);
      }
    }
    for (const bundle of bundles) {
      const bundleSourceHashes = [
        ...new Set(bundle.sources.map((source) => source.sourceSha256)),
      ];
      const sourceOwners = new Set(
        bundleSourceHashes.flatMap((sourceSha256) => [
          ...(activeOwnersBySourceHash.get(sourceSha256) ?? new Set<string>()),
        ]),
      );
      if (sourceOwners.size > 1) {
        continue;
      }
      const existingOwner = [...sourceOwners][0];
      if (
        existingOwner !== undefined &&
        existingOwner !== bundle.receiptId &&
        bundleSourceHashes.every((sourceSha256) =>
          activeOwnersBySourceHash.get(sourceSha256)?.has(existingOwner),
        )
      ) {
        continue;
      }
      const canonicalReceiptId = existingOwner ?? bundle.receiptId;
      const canonicalBundle =
        canonicalReceiptId === bundle.receiptId
          ? bundle
          : { ...bundle, receiptId: canonicalReceiptId };
      if (!isSettled(bundle, now, this.#settleMs)) {
        unsettled += 1;
      }
      const latest = this.#outbox.getLatestInternal(canonicalReceiptId);
      const state = selectPreviousRecord(
        latest,
        this.#actualRecords.find(
          (record) => record.receiptId === canonicalReceiptId,
        ),
      );
      const previous = state?.record;
      if (previous?.status === 'discarded') {
        continue;
      }
      const next = buildActiveReceiptRecord(canonicalBundle, previous);
      if (previous !== undefined && sameRecordFacts(previous, next)) {
        if (state?.applied !== true) {
          waitingForActual += 1;
        }
        continue;
      }
      if (state !== undefined && !state.applied) {
        waitingForActual += 1;
        continue;
      }
      const publication = this.#publisher.publish(next, previous);
      if (publication.inserted) {
        published += 1;
      }
      waitingForActual += 1;
    }
    const visible = this.#refreshProjection();
    return {
      scanned: completed.length,
      candidates: candidates.length,
      bundles: bundles.length,
      invalid,
      unsettled,
      published,
      waitingForActual,
      visible,
    };
  }

  replaceActualCanonicalRecords(
    recordsInput: readonly HouseholdFinanceReceiptRecordV1[],
  ): number {
    this.#actualRecords = latestCanonicalRecords(
      recordsInput,
      MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
    );
    return this.#refreshProjection();
  }

  resolveCanonicalReceiptId(
    referenceInput: CanonicalReceiptSourceReference,
  ): string | undefined {
    const reference = z
      .strictObject({
        roomToken: z.string().min(1).max(500),
        messageId: z.string().min(1).max(500),
        nextcloudFileId: z.string().min(1).max(500),
        sourceSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(referenceInput);
    const records = this.#mergedCanonicalRecords();
    const exactMatches = records.filter((record) =>
      record.sources.some(
        (source) =>
          source.talk.roomToken === reference.roomToken &&
          source.nextcloudFileId === reference.nextcloudFileId &&
          (reference.sourceSha256 === undefined ||
            source.sha256 === reference.sourceSha256),
      ),
    );
    if (exactMatches.length === 1) {
      return exactMatches[0]!.receiptId;
    }
    if (exactMatches.length > 1) {
      return undefined;
    }
    const messageMatches = records.filter((record) =>
      record.sources.some(
        (source) =>
          source.talk.roomToken === reference.roomToken &&
          source.talk.messageId === reference.messageId,
      ),
    );
    if (messageMatches.length === 1) {
      return messageMatches[0]!.receiptId;
    }
    if (messageMatches.length > 1 || reference.sourceSha256 === undefined) {
      return undefined;
    }
    const contentMatches = records.filter(
      (record) =>
        record.status === 'active' &&
        record.sources.some(
          (source) =>
            source.talk.roomToken === reference.roomToken &&
            source.sha256 === reference.sourceSha256,
        ),
    );
    return contentMatches.length === 1
      ? contentMatches[0]!.receiptId
      : undefined;
  }

  /**
   * Removes one bad photo from an active canonical receipt and rebuilds the
   * receipt facts from the remaining extracted sources. If it was the only
   * source, the ordinary receipt tombstone is used instead.
   */
  removeSource(
    receiptIdInput: string,
    referenceInput: CanonicalReceiptExactSourceReference,
    revisedAtInput: string,
  ): ReceiptRecordSourceRemovalResult {
    const receiptId = canonicalUuid.parse(receiptIdInput);
    const reference = z
      .strictObject({
        roomToken: z.string().min(1).max(500),
        messageId: z.string().min(1).max(500),
        nextcloudFileId: z.string().min(1).max(500),
        sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(referenceInput);
    const revisedAt = z.iso.datetime({ offset: true }).parse(revisedAtInput);
    const latest = this.#outbox.getLatestInternal(receiptId);
    const state = selectPreviousRecord(
      latest,
      this.#actualRecords.find((record) => record.receiptId === receiptId),
    );
    const previous = state?.record;
    if (previous === undefined || previous.status !== 'active') {
      return { status: 'not-found' };
    }
    if (state?.applied !== true) {
      return { status: 'blocked', reason: 'prior-write-pending' };
    }
    const source = previous.sources.find(
      (candidate) =>
        candidate.talk.roomToken === reference.roomToken &&
        candidate.talk.messageId === reference.messageId &&
        candidate.nextcloudFileId === reference.nextcloudFileId &&
        candidate.sha256 === reference.sourceSha256,
    );
    if (source === undefined) {
      return { status: 'blocked', reason: 'source-not-found' };
    }
    if (previous.sources.length === 1) {
      const result = this.discard(receiptId, revisedAt);
      return result.status === 'not-found'
        ? { status: 'not-found' }
        : { status: 'discarded', result };
    }

    const remainingHashes = new Set(
      previous.sources
        .filter((candidate) => candidate.sha256 !== source.sha256)
        .map((source) => source.sha256),
    );
    const parsed = canonicalPhotoCandidates(
      this.#attachments.listCompletedShadows(MAXIMUM_SHADOWS),
    );
    const remainingCandidates = parsed.candidates.filter(
      (candidate) =>
        candidate.roomToken === this.#roomToken &&
        remainingHashes.has(candidate.sourceSha256),
    );
    if (
      new Set(remainingCandidates.map((candidate) => candidate.sourceSha256))
        .size !== remainingHashes.size
    ) {
      return { status: 'blocked', reason: 'source-rebuild-unavailable' };
    }
    const bundles = bundleReceiptPhotos(remainingCandidates);
    if (
      bundles.length !== 1 ||
      bundles[0]!.sources.length !== remainingHashes.size
    ) {
      return { status: 'blocked', reason: 'source-rebuild-unavailable' };
    }

    const bundle = bundles[0]!;
    const updatedAt = new Date(
      Math.max(
        Date.parse(previous.updatedAt),
        Date.parse(bundle.updatedAt),
        Date.parse(revisedAt),
      ),
    ).toISOString();
    const next = buildActiveReceiptRecord(
      {
        ...bundle,
        receiptId,
        receivedAt: previous.createdAt,
        updatedAt,
      },
      previous,
    );
    const publication = this.#publisher.publish(next, previous);
    return {
      status: 'recorded',
      receiptId,
      revision: publication.revision,
      inserted: publication.inserted,
      outboxStatus: publication.status,
      remainingSourceCount: next.sources.length,
    };
  }

  appendHouseholdNote(
    receiptIdInput: string,
    noteInput: z.input<typeof householdFinanceReceiptHouseholdNoteSchema>,
  ): ReceiptRecordHouseholdNoteResult {
    const receiptId = canonicalUuid.parse(receiptIdInput);
    const note = householdFinanceReceiptHouseholdNoteSchema.parse(noteInput);
    const latest = this.#outbox.getLatestInternal(receiptId);
    const state = selectPreviousRecord(
      latest,
      this.#actualRecords.find((record) => record.receiptId === receiptId),
    );
    const previous = state?.record;
    if (previous === undefined || previous.status !== 'active') {
      return { status: 'not-found' };
    }
    if (state?.applied !== true) {
      return { status: 'blocked', reason: 'prior-write-pending' };
    }
    const existing = previous.householdNotes?.find(
      (candidate) =>
        candidate.talk.roomToken === note.talk.roomToken &&
        candidate.talk.messageId === note.talk.messageId &&
        candidate.talk.actorId === note.talk.actorId,
    );
    if (existing !== undefined) {
      return JSON.stringify(existing) === JSON.stringify(note)
        ? { status: 'unchanged' }
        : { status: 'conflict' };
    }
    const householdNotes = canonicalizeHouseholdFinanceReceiptHouseholdNotes([
      ...(previous.householdNotes ?? []),
      note,
    ]);
    if (
      !householdNotes.some(
        (candidate) =>
          candidate.talk.roomToken === note.talk.roomToken &&
          candidate.talk.messageId === note.talk.messageId &&
          candidate.talk.actorId === note.talk.actorId,
      )
    ) {
      return { status: 'stale' };
    }
    const updatedAt = new Date(
      Math.max(Date.parse(previous.updatedAt), Date.parse(note.receivedAt)),
    ).toISOString();
    const next = householdFinanceActiveReceiptRecordSchema.parse({
      ...previous,
      revision: previous.revision + 1,
      updatedAt,
      householdNotes,
    });
    const publication = this.#publisher.publish(next, previous);
    return {
      status: 'recorded',
      receiptId,
      revision: publication.revision,
      inserted: publication.inserted,
      outboxStatus: publication.status,
    };
  }

  /**
   * Queues the tombstone that makes a discard durable in Actual. Repeating the
   * same request is a no-op even while the writer is still processing it.
   */
  discard(
    receiptIdInput: string,
    discardedAtInput: string,
  ): ReceiptRecordDiscardResult {
    const receiptId = canonicalUuid.parse(receiptIdInput);
    const discardedAt = z.iso
      .datetime({ offset: true })
      .parse(discardedAtInput);
    const latest = this.#outbox.getLatestInternal(receiptId);
    const state = selectPreviousRecord(
      latest,
      this.#actualRecords.find((record) => record.receiptId === receiptId),
    );
    const previous = state?.record;
    if (state === undefined || previous === undefined) {
      return { status: 'not-found' };
    }
    if (previous.status === 'discarded') {
      return {
        status: 'recorded',
        receiptId,
        revision: previous.revision,
        inserted: false,
        outboxStatus: latest?.status ?? 'applied',
      };
    }
    if (
      latest !== undefined &&
      (latest.status === 'ambiguous' || latest.status === 'failed') &&
      latestRecord(latest)?.revision === previous.revision
    ) {
      return {
        status: 'blocked',
        receiptId,
        reason: 'prior-write-failed',
      };
    }
    const effectiveDiscardedAt = new Date(
      Math.max(
        Date.parse(discardedAt),
        Date.parse(previous.updatedAt),
        ...previous.sources.map((source) => Date.parse(source.receivedAt)),
      ),
    ).toISOString();
    const discarded = parseHouseholdFinanceReceiptRecord({
      schemaVersion: previous.schemaVersion,
      receiptId: previous.receiptId,
      revision: previous.revision + 1,
      createdAt: previous.createdAt,
      updatedAt: effectiveDiscardedAt,
      sources: previous.sources,
      status: 'discarded',
      discardedAt: effectiveDiscardedAt,
    });
    const publication = this.#publisher.publish(discarded, previous);
    return {
      status: 'recorded',
      receiptId,
      revision: publication.revision,
      inserted: publication.inserted,
      outboxStatus: publication.status,
    };
  }

  #refreshProjection(): number {
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError('Receipt publication clock returned an invalid Date');
    }
    const settled = this.#projectableCanonicalRecords().filter(
      (record) =>
        record.status === 'discarded' ||
        now.valueOf() - Date.parse(record.extraction.extractedAt) >=
          this.#settleMs,
    );
    this.#projection.replaceCanonicalState(
      this.#mergedCanonicalRecords(),
      settled,
    );
    return settled.filter(
      (record) =>
        record.status === 'active' &&
        record.extraction.automaticProcessingBlocked !== true,
    ).length;
  }

  #mergedCanonicalRecords(): readonly HouseholdFinanceReceiptRecordV1[] {
    const local = this.#outbox
      .listLatestInternal(MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS)
      .map((latest) => requiredLatestRecord(latest));
    return latestCanonicalRecords(
      [...this.#actualRecords, ...local],
      MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
    );
  }

  #projectableCanonicalRecords(): readonly HouseholdFinanceReceiptRecordV1[] {
    const local = this.#outbox.listLatestInternal(
      MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
    );
    const localByReceiptId = new Map(
      local.map((latest) => [latest.payload.receiptId, latest] as const),
    );
    const actualByReceiptId = new Map(
      this.#actualRecords.map((record) => [record.receiptId, record] as const),
    );
    const receiptIds = new Set([
      ...localByReceiptId.keys(),
      ...actualByReceiptId.keys(),
    ]);
    const projectable: HouseholdFinanceReceiptRecordV1[] = [];
    for (const receiptId of receiptIds) {
      const selected = selectPreviousRecord(
        localByReceiptId.get(receiptId),
        actualByReceiptId.get(receiptId),
      );
      if (selected?.applied === true) {
        projectable.push(selected.record);
      }
    }
    return latestCanonicalRecords(
      projectable,
      MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
    );
  }
}

export interface CanonicalReceiptRecordHydratorOptions {
  readonly actual: ActualReceiptRecordReadPort;
  readonly publication: Pick<
    ReceiptRecordPublicationWorkflow,
    'replaceActualCanonicalRecords'
  >;
  readonly pageSize?: number;
  readonly maximumPages?: number;
  readonly minimumIntervalMs?: number;
  readonly now?: () => Date;
}

export interface CanonicalReceiptRecordHydrationResult {
  readonly pages: number;
  readonly records: number;
  readonly visible: number;
}

/**
 * Reads the complete bounded receipt-note namespace before replacing the
 * projection. A partial or looping pagination result is rejected so an
 * incomplete read can never resurrect a discarded receipt.
 */
export class CanonicalReceiptRecordHydrator {
  readonly #actual: ActualReceiptRecordReadPort;
  readonly #publication: CanonicalReceiptRecordHydratorOptions['publication'];
  readonly #pageSize: number;
  readonly #maximumPages: number;
  readonly #minimumIntervalMs: number;
  readonly #now: () => Date;
  #running: Promise<CanonicalReceiptRecordHydrationResult> | undefined;
  #lastResult: CanonicalReceiptRecordHydrationResult | undefined;
  #nextRefreshAt = 0;

  constructor(options: CanonicalReceiptRecordHydratorOptions) {
    this.#actual = options.actual;
    this.#publication = options.publication;
    this.#pageSize = options.pageSize ?? 50;
    this.#maximumPages = options.maximumPages ?? 100;
    this.#minimumIntervalMs = options.minimumIntervalMs ?? 60_000;
    this.#now = options.now ?? (() => new Date());
    if (
      !Number.isSafeInteger(this.#pageSize) ||
      this.#pageSize < 1 ||
      this.#pageSize > 50 ||
      !Number.isSafeInteger(this.#maximumPages) ||
      this.#maximumPages < 1 ||
      this.#maximumPages > 200 ||
      this.#pageSize * this.#maximumPages >
        MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS ||
      !Number.isSafeInteger(this.#minimumIntervalMs) ||
      this.#minimumIntervalMs < 1_000 ||
      this.#minimumIntervalMs > 60 * 60_000
    ) {
      throw new RangeError('Receipt hydration bounds are invalid');
    }
  }

  kick(): Promise<CanonicalReceiptRecordHydrationResult> {
    const now = this.#now();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw new TypeError('Receipt hydrator clock returned an invalid Date');
    }
    if (this.#lastResult !== undefined && now.valueOf() < this.#nextRefreshAt) {
      return Promise.resolve(this.#lastResult);
    }
    this.#running ??= this.#runOnce()
      .then((result) => {
        this.#lastResult = result;
        this.#nextRefreshAt = now.valueOf() + this.#minimumIntervalMs;
        return result;
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #runOnce(): Promise<CanonicalReceiptRecordHydrationResult> {
    const records: HouseholdFinanceReceiptRecordV1[] = [];
    const seenCursors = new Set<string>();
    let afterNoteId: string | null = null;
    for (let page = 1; page <= this.#maximumPages; page += 1) {
      const result = await this.#actual.receiptRecords({
        afterNoteId,
        limit: this.#pageSize,
      });
      records.push(
        ...result.records.map(({ record }) =>
          parseHouseholdFinanceReceiptRecord(record),
        ),
      );
      if (!result.truncated) {
        return {
          pages: page,
          records: records.length,
          visible: this.#publication.replaceActualCanonicalRecords(records),
        };
      }
      if (
        result.nextAfterNoteId === null ||
        result.nextAfterNoteId === afterNoteId ||
        seenCursors.has(result.nextAfterNoteId)
      ) {
        throw new Error('Actual receipt pagination did not advance');
      }
      seenCursors.add(result.nextAfterNoteId);
      afterNoteId = result.nextAfterNoteId;
    }
    throw new RangeError('Actual receipt hydration exceeds its safe bound');
  }
}

function canonicalPhotoCandidates(
  completed: readonly CompletedAttachmentShadow[],
): {
  readonly candidates: readonly ReceiptPhotoCandidate[];
  readonly invalid: number;
} {
  const candidates: ReceiptPhotoCandidate[] = [];
  let invalid = 0;
  for (const item of completed) {
    const proposal = receiptModelProposalV1Schema.safeParse(
      item.shadow.proposal,
    );
    if (
      !proposal.success ||
      !canonicalUuid.safeParse(item.event.id).success ||
      !/^[a-f0-9]{64}$/.test(item.shadow.sourceSha256) ||
      item.shadow.archivePath === undefined ||
      item.shadow.modelMetadata === undefined
    ) {
      invalid += 1;
      continue;
    }
    candidates.push({
      eventId: item.event.id,
      roomToken: item.event.roomToken,
      actorId: item.event.actorId,
      messageId: item.event.messageId,
      receivedAt: item.event.receivedAt,
      fileId: item.event.attachment.fileId,
      archivePath: item.shadow.archivePath,
      mediaType: item.event.attachment.mediaType,
      sourceSha256: item.shadow.sourceSha256,
      extractedAt: item.shadow.updatedAt,
      modelMetadata: item.shadow.modelMetadata,
      receipt: canonicalizeHouseholdReceiptCurrency(proposal.data),
      ...(item.event.captionHint === undefined
        ? {}
        : { captionHint: item.event.captionHint }),
    });
  }
  return { candidates, invalid };
}

function latestRecord(
  latest: ReceiptNoteOutboxLatestInternal | undefined,
): HouseholdFinanceReceiptRecordV1 | undefined {
  if (latest === undefined) {
    return undefined;
  }
  try {
    return parseHouseholdFinanceReceiptRecord(
      JSON.parse(latest.payload.desiredCanonicalJson) as unknown,
    );
  } catch (error) {
    throw new TypeError('Persisted receipt-note intent is invalid', {
      cause: error,
    });
  }
}

function requiredLatestRecord(
  latest: ReceiptNoteOutboxLatestInternal,
): HouseholdFinanceReceiptRecordV1 {
  const record = latestRecord(latest);
  if (record === undefined) {
    throw new TypeError('Persisted receipt-note intent is missing');
  }
  return record;
}

function latestCanonicalRecords(
  recordsInput: readonly HouseholdFinanceReceiptRecordV1[],
  maximumRecords: number,
): readonly HouseholdFinanceReceiptRecordV1[] {
  if (recordsInput.length > maximumRecords * 2) {
    throw new RangeError('Canonical receipt merge exceeds its safe bound');
  }
  const latest = new Map<string, HouseholdFinanceReceiptRecordV1>();
  for (const recordInput of recordsInput) {
    const record = parseHouseholdFinanceReceiptRecord(recordInput);
    const existing = latest.get(record.receiptId);
    if (existing === undefined || record.revision > existing.revision) {
      latest.set(record.receiptId, record);
      continue;
    }
    if (
      record.revision === existing.revision &&
      householdFinanceReceiptSha256(record) !==
        householdFinanceReceiptSha256(existing)
    ) {
      throw new Error('Canonical receipt revision has conflicting content');
    }
  }
  if (latest.size > maximumRecords) {
    throw new RangeError('Canonical receipt count exceeds its safe bound');
  }
  return [...latest.values()].sort((left, right) =>
    left.receiptId.localeCompare(right.receiptId),
  );
}

function selectPreviousRecord(
  local: ReceiptNoteOutboxLatestInternal | undefined,
  actual: HouseholdFinanceReceiptRecordV1 | undefined,
):
  | {
      readonly record: HouseholdFinanceReceiptRecordV1;
      readonly applied: boolean;
    }
  | undefined {
  const localRecord = latestRecord(local);
  if (localRecord === undefined) {
    return actual === undefined ? undefined : { record: actual, applied: true };
  }
  if (actual === undefined || localRecord.revision > actual.revision) {
    return { record: localRecord, applied: local?.status === 'applied' };
  }
  if (actual.revision > localRecord.revision) {
    return { record: actual, applied: true };
  }
  if (
    householdFinanceReceiptSha256(localRecord) !==
    householdFinanceReceiptSha256(actual)
  ) {
    throw new Error('Local and Actual receipt revisions conflict');
  }
  return { record: actual, applied: true };
}

function sameRecordFacts(
  previous: HouseholdFinanceReceiptRecordV1,
  candidate: HouseholdFinanceReceiptRecordV1,
): boolean {
  const previousFacts = JSON.parse(
    canonicalHouseholdFinanceReceiptJson(previous),
  ) as Record<string, unknown>;
  const candidateFacts = JSON.parse(
    canonicalHouseholdFinanceReceiptJson(candidate),
  ) as Record<string, unknown>;
  delete previousFacts.revision;
  delete previousFacts.createdAt;
  delete previousFacts.updatedAt;
  delete candidateFacts.revision;
  delete candidateFacts.createdAt;
  delete candidateFacts.updatedAt;
  return (
    canonicalReceiptNoteOperationJson(previousFacts) ===
    canonicalReceiptNoteOperationJson(candidateFacts)
  );
}

function isSettled(
  bundle: ReceiptPhotoBundle,
  now: Date,
  settleMs: number,
): boolean {
  const latestCompletion = Math.max(
    ...bundle.sources.map((source) => Date.parse(source.extractedAt)),
  );
  return now.valueOf() - latestCompletion >= settleMs;
}
