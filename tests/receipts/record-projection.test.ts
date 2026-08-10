import { describe, expect, it } from 'vitest';

import {
  ReceiptNoteEnvelopeAuthenticator,
  ReceiptNoteOutboxStore,
} from '../../src/actual-receipt-note/index.js';
import {
  actualReceiptNoteId,
  householdFinanceReceiptSha256,
  parseHouseholdFinanceReceiptNote,
  parseHouseholdFinanceReceiptRecord,
} from '../../src/receipt-record/index.js';
import {
  CanonicalReceiptRecordHydrator,
  CanonicalReceiptRecordProjectionSource,
  ReceiptRecordPublicationWorkflow,
} from '../../src/receipts/record-projection.js';
import { ReceiptRecordPublisher } from '../../src/receipts/publication.js';
import type {
  CompletedAttachmentShadow,
  ReceiptAttachmentReference,
} from '../../src/storage/index.js';
import type { ReceiptModelProposalV1 } from '../../src/model/index.js';

const receiptId = '00000000-0000-4000-8000-000000000001';

function field<T>(value: T | null) {
  return {
    value,
    evidence: value === null ? ('absent' as const) : ('explicit' as const),
    confidence: value === null ? 0 : 1,
    sourcePage: value === null ? null : 1,
  };
}

function amount(valueMinor: number | null) {
  return {
    valueMinor,
    evidence: valueMinor === null ? ('absent' as const) : ('explicit' as const),
    confidence: valueMinor === null ? 0 : 1,
    sourcePage: valueMinor === null ? null : 1,
  };
}

function proposal(
  merchant: string,
  totalMinor: number | null,
  item: string,
  itemTotalMinor = totalMinor,
): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'single-receipt',
    merchant: field(merchant),
    purchaseDate: field('2026-07-28'),
    purchaseTime: field<string>(null),
    timezoneOffset: field<string>(null),
    currency: field('CAD'),
    amounts: {
      subtotal: amount(totalMinor),
      tax: amount(0),
      discount: amount(0),
      tip: amount(0),
      total: amount(totalMinor),
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    },
    receiptReference: field<string>(null),
    lineItems: [
      {
        description: item,
        quantity: 1,
        unitPriceMinor: itemTotalMinor,
        totalMinor: itemTotalMinor,
        confidence: 1,
        sourcePage: 1,
      },
    ],
    uncertainties: [],
  };
}

function completed(
  index: number,
  input: {
    readonly captionHint?: string;
    readonly messageId?: string;
    readonly sourceSha256?: string;
    readonly totalMinor?: number | null;
    readonly itemTotalMinor?: number | null;
    readonly item?: string;
    readonly extractedAt?: string;
    readonly receivedAt?: string;
  } = {},
): CompletedAttachmentShadow {
  const receivedAt = input.receivedAt ?? '2026-07-29T12:00:00.000Z';
  return {
    event: {
      id:
        index === 1
          ? receiptId
          : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      idempotencyKey: `attachment-${String(index)}`,
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household',
      actorId: 'alex',
      messageId: input.messageId ?? `message-${String(index)}`,
      attachment: {
        fileId: `file-${String(index)}`,
        etag: `etag-${String(index)}`,
        sizeBytes: 100,
        mediaType: 'image/jpeg',
      },
      ...(input.captionHint === undefined
        ? {}
        : { captionHint: input.captionHint }),
      receivedAt,
    },
    shadow: {
      eventId:
        index === 1
          ? receiptId
          : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      status: 'completed',
      archivePath: `Receipts/source-${String(index)}.jpg`,
      sourceSha256: input.sourceSha256 ?? String(index).padStart(64, '0'),
      proposal: proposal(
        'Example Market',
        input.totalMinor === undefined ? 1_725 : input.totalMinor,
        input.item ?? `Item ${String(index)}`,
        input.itemTotalMinor === undefined
          ? input.totalMinor === null
            ? 1_725
            : (input.totalMinor ?? 1_725)
          : input.itemTotalMinor,
      ),
      modelMetadata: {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        preflightAttempts: 1,
        documentAttempts: 1,
        durationMs: 100,
        zeroDataRetention: true,
      },
      createdAt: receivedAt,
      updatedAt: input.extractedAt ?? '2026-07-29T12:00:01.000Z',
    },
  };
}

function setup(
  completedShadows: CompletedAttachmentShadow[],
  now: string | (() => Date) = '2026-07-29T12:16:00.000Z',
  findReceiptsByRoomMessage?: (
    roomToken: string,
    messageId: string,
  ) => readonly ReceiptAttachmentReference[],
) {
  const store = new ReceiptNoteOutboxStore(':memory:');
  const authenticator = new ReceiptNoteEnvelopeAuthenticator({
    activeKeyId: 'test',
    keys: { test: 'k'.repeat(48) },
  });
  const projection = new CanonicalReceiptRecordProjectionSource();
  const workflow = new ReceiptRecordPublicationWorkflow({
    attachments: {
      listCompletedShadows: () => completedShadows,
      ...(findReceiptsByRoomMessage === undefined
        ? {}
        : { findReceiptsByRoomMessage }),
    },
    outbox: store,
    publisher: new ReceiptRecordPublisher({ store, authenticator }),
    projection,
    roomToken: 'household',
    now: typeof now === 'string' ? () => new Date(now) : now,
  });
  return { authenticator, projection, store, workflow };
}

function markLatestApplied(
  store: ReceiptNoteOutboxStore,
  now = '2026-07-29T12:16:01.000Z',
): void {
  const claim = store.claimNext(now);
  expect(claim).toBeDefined();
  store.markApplying(claim!, now);
  store.complete(
    claim!,
    {
      status: 'updated',
      receiptId: claim!.receiptId,
      noteId: actualReceiptNoteId(claim!.receiptId),
      revision: claim!.revision,
      desiredSha256: claim!.envelope.payload.desiredSha256,
    },
    now,
  );
}

describe('ReceiptRecordPublicationWorkflow', () => {
  it('bundles same-message photos, publishes once, and gates projection on Actual read-back', () => {
    const shadows = [
      completed(1, {
        messageId: 'same-message',
        totalMinor: 3_450,
        itemTotalMinor: 1_725,
        item: 'Front page item',
      }),
      completed(2, {
        messageId: 'same-message',
        totalMinor: null,
        item: 'Back page item',
      }),
    ];
    const { authenticator, projection, store, workflow } = setup(shadows);
    try {
      expect(workflow.runOnce()).toMatchObject({
        scanned: 2,
        candidates: 2,
        bundles: 1,
        published: 1,
        waitingForActual: 1,
        visible: 0,
      });
      const latest = store.getLatestInternal(receiptId);
      const record = JSON.parse(latest!.payload.desiredCanonicalJson) as Record<
        string,
        unknown
      >;
      expect(record).toMatchObject({
        receiptId,
        revision: 1,
        sources: [
          {
            talk: {
              roomToken: 'household',
              actorId: 'alex',
              messageId: 'same-message',
            },
          },
          {
            talk: {
              roomToken: 'household',
              actorId: 'alex',
              messageId: 'same-message',
            },
          },
        ],
      });
      expect(record.extraction).not.toHaveProperty(
        'automaticProcessingBlocked',
      );
      expect(projection.listActiveRecords()).toEqual([]);

      expect(workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 1,
        visible: 0,
      });
      expect(store.getLatestInternal(receiptId)?.payload.revision).toBe(1);

      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(projection.listActiveRecords()).toMatchObject([
        {
          receiptId,
          status: 'active',
          sources: [
            {
              talk: {
                roomToken: 'household',
                messageId: 'same-message',
              },
            },
            {
              talk: {
                roomToken: 'household',
                messageId: 'same-message',
              },
            },
          ],
        },
      ]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('does not revise or unsettle a canonical receipt for an exact-content resend', () => {
    const sourceSha256 = 'a'.repeat(64);
    const shadows = [
      completed(1, {
        sourceSha256,
        extractedAt: '2026-07-29T12:00:01.000Z',
      }),
    ];
    let now = new Date('2026-07-29T12:16:00.000Z');
    const { authenticator, projection, store, workflow } = setup(
      shadows,
      () => now,
    );
    try {
      expect(workflow.runOnce()).toMatchObject({
        published: 1,
        waitingForActual: 1,
      });
      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 0,
        visible: 1,
      });

      shadows.push(
        completed(2, {
          sourceSha256,
          receivedAt: '2026-07-29T12:20:00.000Z',
          extractedAt: '2026-07-29T12:20:01.000Z',
          item: 'Item 1',
        }),
      );
      now = new Date('2026-07-29T12:20:02.000Z');

      expect(workflow.runOnce()).toMatchObject({
        scanned: 2,
        candidates: 2,
        bundles: 1,
        unsettled: 0,
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(store.getLatestInternal(receiptId)?.payload.revision).toBe(1);
      expect(projection.listActiveRecords()).toMatchObject([
        {
          receiptId,
          revision: 1,
          extraction: { extractedAt: '2026-07-29T12:00:01.000Z' },
        },
      ]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('adds a caption from an exact-content resend without changing extraction provenance', () => {
    const sourceSha256 = 'a'.repeat(64);
    const shadows = [
      completed(1, {
        sourceSha256,
        extractedAt: '2026-07-29T12:00:01.000Z',
      }),
    ];
    let now = new Date('2026-07-29T12:16:00.000Z');
    const { authenticator, projection, store, workflow } = setup(
      shadows,
      () => now,
    );
    try {
      workflow.runOnce();
      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({ visible: 1 });
      const original = parseHouseholdFinanceReceiptRecord(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      );
      if (original.status !== 'active') {
        throw new Error('Expected an active synthetic receipt');
      }

      shadows.push(
        completed(2, {
          sourceSha256,
          receivedAt: '2026-07-29T12:20:00.000Z',
          extractedAt: '2026-07-29T12:20:01.000Z',
          item: 'Item 1',
          captionHint: 'Birthday present.',
        }),
      );
      now = new Date('2026-07-29T12:20:02.000Z');

      expect(workflow.runOnce()).toMatchObject({
        unsettled: 0,
        published: 1,
        waitingForActual: 1,
        visible: 0,
      });
      const revised = parseHouseholdFinanceReceiptRecord(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      );
      expect(revised).toMatchObject({
        receiptId,
        revision: 2,
        updatedAt: '2026-07-29T12:20:01.000Z',
        merchant: original.merchant,
        purchaseDate: original.purchaseDate,
        currency: original.currency,
        amounts: original.amounts,
        paymentEvidence: original.paymentEvidence,
        items: original.items,
        householdNotes: [{ text: 'Birthday present.' }],
        extraction: {
          extractedAt: '2026-07-29T12:00:01.000Z',
          sourceSha256s: [sourceSha256],
        },
      });

      markLatestApplied(store, '2026-07-29T12:20:03.000Z');
      now = new Date('2026-07-29T12:20:04.000Z');
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 0,
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(projection.listActiveRecords()).toHaveLength(1);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('preserves legacy extraction provenance for an unchanged source set after restart', () => {
    const sourceSha256 = 'a'.repeat(64);
    const shadow = completed(1, {
      sourceSha256,
      extractedAt: '2026-07-29T12:00:01.000Z',
    });
    const legacy = (() => {
      const seeded = setup([shadow]);
      try {
        seeded.workflow.runOnce();
        const record = parseHouseholdFinanceReceiptRecord(
          JSON.parse(
            seeded.store.getLatestInternal(receiptId)!.payload
              .desiredCanonicalJson,
          ),
        );
        if (record.status !== 'active') {
          throw new Error('Expected an active synthetic receipt');
        }
        return parseHouseholdFinanceReceiptRecord({
          ...record,
          updatedAt: '2026-07-29T12:10:01.000Z',
          extraction: {
            ...record.extraction,
            extractedAt: '2026-07-29T12:10:01.000Z',
          },
        });
      } finally {
        seeded.authenticator.destroy();
        seeded.store.close();
      }
    })();
    const { authenticator, projection, store, workflow } = setup(
      [shadow],
      '2026-07-29T12:30:00.000Z',
    );
    try {
      expect(workflow.replaceActualCanonicalRecords([legacy])).toBe(1);
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 0,
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(store.getLatestInternal(receiptId)).toBeUndefined();
      expect(projection.listActiveRecords()).toMatchObject([
        {
          receiptId,
          revision: 1,
          extraction: { extractedAt: '2026-07-29T12:10:01.000Z' },
        },
      ]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('keeps a receipt-level safety blocker in Actual and out of automatic projection', () => {
    const shadow = completed(1);
    const unsafe = shadow.shadow.proposal as ReceiptModelProposalV1;
    shadow.shadow.proposal = {
      ...unsafe,
      uncertainties: [
        {
          code: 'split-tender',
          message: 'The receipt appears to use two payment methods.',
          material: true,
          sourcePage: 1,
        },
      ],
    };
    const { authenticator, projection, store, workflow } = setup([shadow]);
    try {
      expect(workflow.runOnce()).toMatchObject({
        published: 1,
        waitingForActual: 1,
        visible: 0,
      });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        receiptId,
        status: 'active',
        extraction: { automaticProcessingBlocked: true },
      });

      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({
        waitingForActual: 0,
        visible: 0,
      });
      expect(projection.listActiveRecords()).toEqual([]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('waits when another photo in the same post failed, then resumes after it is ignored', () => {
    const first = completed(1, { messageId: 'same-message' });
    const failedSource = completed(2, { messageId: 'same-message' });
    let failedIgnored = false;
    const { authenticator, projection, store, workflow } = setup(
      [first],
      '2026-07-29T12:16:00.000Z',
      () => [
        { event: first.event, shadow: first.shadow, ignored: false },
        {
          event: failedSource.event,
          shadow: {
            eventId: failedSource.event.id,
            status: 'failed',
            errorCode: 'model-document-invalid',
            createdAt: failedSource.shadow.createdAt,
            updatedAt: failedSource.shadow.updatedAt,
          },
          ignored: failedIgnored,
        },
      ],
    );
    try {
      expect(workflow.runOnce()).toMatchObject({
        published: 1,
        visible: 0,
      });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        revision: 1,
        extraction: { automaticProcessingBlocked: true },
      });

      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({ published: 0, visible: 0 });

      failedIgnored = true;
      expect(workflow.runOnce()).toMatchObject({
        published: 1,
        waitingForActual: 1,
        visible: 0,
      });
      const repaired = JSON.parse(
        store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
      ) as { revision: number; extraction: Record<string, unknown> };
      expect(repaired.revision).toBe(2);
      expect(repaired.extraction).not.toHaveProperty(
        'automaticProcessingBlocked',
      );

      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({ visible: 1 });
      expect(projection.listActiveRecords()).toHaveLength(1);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('does not let one optimistic photo erase a related photo document blocker', () => {
    const first = completed(1, {
      messageId: 'same-message',
      item: 'Shared item',
    });
    const second = completed(2, {
      messageId: 'same-message',
      item: 'Shared item',
    });
    const secondProposal = second.shadow.proposal as ReceiptModelProposalV1;
    second.shadow.proposal = {
      ...secondProposal,
      documentDisposition: 'multiple-receipts',
    };
    const { authenticator, projection, store, workflow } = setup([
      first,
      second,
    ]);
    try {
      expect(workflow.runOnce()).toMatchObject({
        bundles: 1,
        published: 1,
      });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({ sha256: String(1).padStart(64, '0') }),
          expect.objectContaining({ sha256: String(2).padStart(64, '0') }),
        ]),
        extraction: { automaticProcessingBlocked: true },
      });
      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({ visible: 0 });
      expect(projection.listActiveRecords()).toEqual([]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('preserves unclear item-split evidence through the Actual projection', () => {
    const shadow = completed(1);
    const unclearItems = shadow.shadow.proposal as ReceiptModelProposalV1;
    shadow.shadow.proposal = {
      ...unclearItems,
      uncertainties: [
        {
          code: 'line-items-unclear',
          message: 'The printed item descriptions are unclear.',
          material: true,
          sourcePage: 1,
        },
      ],
    };
    const { authenticator, projection, store, workflow } = setup([shadow]);
    try {
      workflow.runOnce();
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        extraction: { itemSplitBlocked: true },
      });
      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({ visible: 1 });
      expect(projection.listActiveRecords()).toMatchObject([
        {
          receiptId,
          status: 'active',
          extraction: { itemSplitBlocked: true },
        },
      ]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('adopts the existing canonical receipt when an earlier photo finishes later', () => {
    const laterReceiptId = '00000000-0000-4000-8000-000000000002';
    const shadows = [
      completed(2, {
        item: 'Shared item',
        receivedAt: '2026-07-29T12:01:00.000Z',
        extractedAt: '2026-07-29T12:01:01.000Z',
      }),
    ];
    const { store, workflow } = setup(shadows);
    try {
      expect(workflow.runOnce()).toMatchObject({ published: 1, bundles: 1 });
      expect(store.getLatestInternal(laterReceiptId)?.payload).toMatchObject({
        receiptId: laterReceiptId,
        revision: 1,
      });
      markLatestApplied(store);

      shadows.unshift(
        completed(1, {
          item: 'Shared item',
          receivedAt: '2026-07-29T12:00:00.000Z',
          extractedAt: '2026-07-29T12:02:00.000Z',
        }),
      );
      expect(workflow.runOnce()).toMatchObject({ published: 1, bundles: 1 });

      expect(store.getLatestInternal(receiptId)).toBeUndefined();
      expect(store.getLatestInternal(laterReceiptId)?.payload).toMatchObject({
        receiptId: laterReceiptId,
        revision: 2,
      });
      const revised = JSON.parse(
        store.getLatestInternal(laterReceiptId)!.payload.desiredCanonicalJson,
      ) as {
        readonly receiptId: string;
        readonly revision: number;
        readonly sources: readonly { readonly sha256: string }[];
      };
      expect(revised).toMatchObject({
        receiptId: laterReceiptId,
        revision: 2,
      });
      expect(revised.sources.map((source) => source.sha256)).toEqual([
        String(1).padStart(64, '0'),
        String(2).padStart(64, '0'),
      ]);
    } finally {
      store.close();
    }
  });

  it('rebuilds a canonical receipt after one bad photo is removed', () => {
    const shadows = [
      completed(1, {
        messageId: 'same-message',
        totalMinor: 3_450,
        itemTotalMinor: 1_725,
        item: 'Keep this item',
      }),
      completed(2, {
        messageId: 'same-message',
        totalMinor: null,
        item: 'Bad OCR item',
      }),
    ];
    const { store, workflow } = setup(shadows);
    try {
      workflow.runOnce();
      markLatestApplied(store);

      expect(
        workflow.removeSource(
          receiptId,
          {
            roomToken: 'household',
            messageId: 'same-message',
            nextcloudFileId: 'file-2',
            sourceSha256: String(2).padStart(64, '0'),
          },
          '2026-07-29T12:20:00.000Z',
        ),
      ).toMatchObject({
        status: 'recorded',
        receiptId,
        revision: 2,
        remainingSourceCount: 1,
      });
      const latest = store.getLatestInternal(receiptId);
      expect(JSON.parse(latest!.payload.desiredCanonicalJson)).toMatchObject({
        revision: 2,
        status: 'active',
        sources: [{ sha256: String(1).padStart(64, '0') }],
        items: [{ description: 'Keep this item' }],
      });
    } finally {
      store.close();
    }
  });

  it('uses the receipt tombstone when its only picture is removed', () => {
    const { store, workflow } = setup([completed(1)]);
    try {
      workflow.runOnce();
      markLatestApplied(store);

      expect(
        workflow.removeSource(
          receiptId,
          {
            roomToken: 'household',
            messageId: 'message-1',
            nextcloudFileId: 'file-1',
            sourceSha256: String(1).padStart(64, '0'),
          },
          '2026-07-29T12:20:00.000Z',
        ),
      ).toMatchObject({
        status: 'discarded',
        result: { status: 'recorded', receiptId, revision: 2 },
      });
    } finally {
      store.close();
    }
  });

  it('does not remove canonical evidence for a content-only duplicate upload', () => {
    const { store, workflow } = setup([completed(1)]);
    try {
      workflow.runOnce();
      markLatestApplied(store);

      expect(
        workflow.removeSource(
          receiptId,
          {
            roomToken: 'household',
            messageId: 'duplicate-message',
            nextcloudFileId: 'duplicate-file',
            sourceSha256: String(1).padStart(64, '0'),
          },
          '2026-07-29T12:20:00.000Z',
        ),
      ).toEqual({ status: 'blocked', reason: 'source-not-found' });
      expect(store.getLatestInternal(receiptId)?.payload).toMatchObject({
        receiptId,
        revision: 1,
      });
    } finally {
      store.close();
    }
  });

  it('appends an authenticated household note to the canonical Actual record', () => {
    let now = new Date('2026-07-29T12:16:00.000Z');
    const { projection, store, workflow } = setup([completed(1)], () => now);
    try {
      workflow.runOnce();
      markLatestApplied(store);

      expect(
        workflow.appendHouseholdNote(receiptId, {
          text: "This was for Elia's birthday.",
          receivedAt: '2026-07-29T12:20:00.000Z',
          talk: {
            roomToken: 'household',
            actorId: 'alex',
            messageId: 'note-message',
          },
        }),
      ).toMatchObject({
        status: 'recorded',
        receiptId,
        revision: 2,
      });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        householdNotes: [
          {
            text: "This was for Elia's birthday.",
            receivedAt: '2026-07-29T12:20:00.000Z',
            talk: { actorId: 'alex', messageId: 'note-message' },
          },
        ],
      });
      now = new Date('2026-07-29T12:21:00.000Z');
      expect(workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 1,
      });
      markLatestApplied(store, '2026-07-29T12:20:01.000Z');
      expect(workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 0,
      });
      expect(store.getLatestInternal(receiptId)?.payload.revision).toBe(2);
      expect(projection.listActiveRecords()).toHaveLength(1);
      expect(
        projection
          .listActiveRecords()[0]
          ?.householdNotes?.map((note) => note.text),
      ).toEqual(["This was for Elia's birthday."]);
    } finally {
      store.close();
    }
  });

  it('orders a delayed older note before a later-authored correction', () => {
    const { store, workflow } = setup([completed(1)]);
    try {
      workflow.runOnce();
      markLatestApplied(store);
      expect(
        workflow.appendHouseholdNote(receiptId, {
          text: "Correction: this was for Elia's birthday.",
          receivedAt: '2026-07-29T12:20:00.000Z',
          talk: {
            roomToken: 'household',
            actorId: 'alex',
            messageId: 'later-correction',
          },
        }),
      ).toMatchObject({ status: 'recorded', revision: 2 });
      markLatestApplied(store, '2026-07-29T12:20:01.000Z');

      expect(
        workflow.appendHouseholdNote(receiptId, {
          text: 'Maybe this was office supplies.',
          receivedAt: '2026-07-29T12:10:00.000Z',
          talk: {
            roomToken: 'household',
            actorId: 'alex',
            messageId: 'earlier-guess',
          },
        }),
      ).toMatchObject({ status: 'recorded', revision: 3 });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        revision: 3,
        householdNotes: [
          { text: 'Maybe this was office supplies.' },
          { text: "Correction: this was for Elia's birthday." },
        ],
      });
    } finally {
      store.close();
    }
  });

  it('changes the projection version when canonical receipt facts are revised', () => {
    const shadows = [completed(1)];
    let now = new Date('2026-07-29T12:16:00.000Z');
    const { authenticator, projection, store, workflow } = setup(
      shadows,
      () => now,
    );
    try {
      workflow.runOnce();
      markLatestApplied(store);
      workflow.runOnce();
      const firstProjectionSha = householdFinanceReceiptSha256(
        projection.listActiveRecords()[0]!,
      );
      expect(
        projection.isCurrentReceiptSource(receiptId, firstProjectionSha),
      ).toBe(true);

      shadows[0] = completed(1, {
        sourceSha256: 'f'.repeat(64),
        totalMinor: 2_000,
        item: 'Corrected item',
        extractedAt: '2026-07-29T12:10:00.000Z',
      });
      expect(workflow.runOnce()).toMatchObject({
        published: 1,
        waitingForActual: 1,
        visible: 0,
      });
      expect(store.getLatestInternal(receiptId)?.payload).toMatchObject({
        receiptId,
        revision: 2,
      });
      const revisedRecord = parseHouseholdFinanceReceiptRecord(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      );
      const revisedProjectionSha = householdFinanceReceiptSha256(revisedRecord);
      expect(
        projection.isCurrentReceiptSource(receiptId, firstProjectionSha),
      ).toBe(false);
      expect(
        projection.isCurrentReceiptSource(receiptId, revisedProjectionSha),
      ).toBe(false);
      markLatestApplied(store);
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 1,
        visible: 0,
      });
      expect(projection.listActiveRecords()).toEqual([]);
      expect(
        projection.isCurrentReceiptSource(receiptId, revisedProjectionSha),
      ).toBe(false);
      now = new Date('2026-07-29T12:26:00.000Z');
      expect(workflow.runOnce()).toMatchObject({ visible: 1 });
      expect(
        householdFinanceReceiptSha256(projection.listActiveRecords()[0]!),
      ).not.toBe(firstProjectionSha);
      expect(
        projection.isCurrentReceiptSource(receiptId, revisedProjectionSha),
      ).toBe(true);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('publishes an idempotent contiguous discard tombstone', () => {
    const { authenticator, projection, store, workflow } = setup([
      completed(1),
    ]);
    try {
      workflow.runOnce();
      markLatestApplied(store);
      workflow.runOnce();
      expect(projection.listActiveRecords()).toHaveLength(1);

      expect(
        workflow.discard(receiptId, '2026-07-29T12:20:00.000Z'),
      ).toMatchObject({
        status: 'recorded',
        inserted: true,
        revision: 2,
        outboxStatus: 'queued',
      });
      expect(
        workflow.discard(receiptId, '2026-07-29T12:21:00.000Z'),
      ).toMatchObject({
        status: 'recorded',
        inserted: false,
        revision: 2,
        outboxStatus: 'queued',
      });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        receiptId,
        revision: 2,
        status: 'discarded',
        discardedAt: '2026-07-29T12:20:00.000Z',
      });

      workflow.runOnce();
      expect(projection.listActiveRecords()).toEqual([]);
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('resolves every bundled source and queues discard behind its pending active note', () => {
    const shadows = [
      completed(1, {
        messageId: 'same-message',
        totalMinor: 3_450,
        itemTotalMinor: 1_725,
      }),
      completed(2, { messageId: 'same-message', totalMinor: null }),
    ];
    const { authenticator, store, workflow } = setup(shadows);
    try {
      workflow.runOnce();
      expect(
        workflow.resolveCanonicalReceiptId({
          roomToken: 'household',
          messageId: 'same-message',
          nextcloudFileId: 'file-2',
          sourceSha256: '2'.padStart(64, '0'),
        }),
      ).toBe(receiptId);
      expect(
        workflow.resolveCanonicalReceiptId({
          roomToken: 'household',
          messageId: 'same-message',
          nextcloudFileId: 'missing',
          sourceSha256: undefined,
        }),
      ).toBe(receiptId);
      expect(
        workflow.resolveCanonicalReceiptId({
          roomToken: 'household',
          messageId: 'missing',
          nextcloudFileId: 'missing',
          sourceSha256: undefined,
        }),
      ).toBeUndefined();
      expect(
        workflow.discard(receiptId, '2026-07-29T12:20:00.000Z'),
      ).toMatchObject({
        status: 'recorded',
        inserted: true,
        revision: 2,
        outboxStatus: 'queued',
      });
      expect(store.claimNext('2026-07-29T12:21:00.000Z')).toMatchObject({
        receiptId,
        revision: 1,
      });
      expect(
        workflow.discard(
          '8dfc1bd9-e07a-4c62-9d58-9529361536b9',
          '2026-07-29T12:20:00.000Z',
        ),
      ).toEqual({ status: 'not-found' });
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('resolves a later exact-duplicate upload by its unique active content hash', () => {
    const duplicateSha256 = 'a'.repeat(64);
    const shadows = [
      completed(1, {
        messageId: 'first-message',
        sourceSha256: duplicateSha256,
      }),
      completed(2, {
        messageId: 'duplicate-message',
        sourceSha256: duplicateSha256,
      }),
    ];
    const { authenticator, store, workflow } = setup(shadows);
    try {
      workflow.runOnce();
      expect(
        workflow.resolveCanonicalReceiptId({
          roomToken: 'household',
          messageId: 'duplicate-message',
          nextcloudFileId: 'file-2',
          sourceSha256: duplicateSha256,
        }),
      ).toBe(receiptId);
      expect(store.getLatestInternal(receiptId)).toBeDefined();
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('does not resurrect another photo from a discarded multi-photo receipt', () => {
    const shadows = [
      completed(1, {
        messageId: 'same-message',
        totalMinor: 3_450,
        itemTotalMinor: 1_725,
      }),
      completed(2, { messageId: 'same-message', totalMinor: null }),
    ];
    const secondReceiptId = shadows[1]!.event.id;
    const { authenticator, store, workflow } = setup(shadows);
    try {
      workflow.runOnce();
      markLatestApplied(store);
      workflow.runOnce();
      expect(
        workflow.discard(receiptId, '2026-07-29T12:20:00.000Z'),
      ).toMatchObject({ status: 'recorded', revision: 2 });
      markLatestApplied(store, '2026-07-29T12:20:01.000Z');

      shadows.splice(0, 1);
      expect(workflow.runOnce()).toMatchObject({
        scanned: 1,
        candidates: 0,
        bundles: 0,
        published: 0,
        visible: 0,
      });
      expect(store.getLatestInternal(secondReceiptId)).toBeUndefined();
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('uses a monotonic tombstone time when an older ignore request follows a newer photo', () => {
    const shadows = [
      completed(1, {
        messageId: 'same-message',
        totalMinor: 3_450,
        itemTotalMinor: 1_725,
      }),
    ];
    const { authenticator, store, workflow } = setup(shadows);
    try {
      workflow.runOnce();
      markLatestApplied(store);
      workflow.runOnce();
      shadows.push(
        completed(2, {
          messageId: 'same-message',
          totalMinor: null,
          receivedAt: '2026-07-29T12:10:00.000Z',
          extractedAt: '2026-07-29T12:30:01.000Z',
        }),
      );
      expect(workflow.runOnce()).toMatchObject({ published: 1 });

      expect(
        workflow.discard(receiptId, '2026-07-29T12:05:00.000Z'),
      ).toMatchObject({ status: 'recorded', revision: 3 });
      expect(
        JSON.parse(
          store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
        ),
      ).toMatchObject({
        status: 'discarded',
        updatedAt: '2026-07-29T12:30:01.000Z',
        discardedAt: '2026-07-29T12:30:01.000Z',
      });
    } finally {
      authenticator.destroy();
      store.close();
    }
  });

  it('publishes immediately but waits for settlement before categorization', () => {
    let now = new Date('2026-07-29T12:16:00.000Z');
    const { authenticator, projection, store, workflow } = setup(
      [completed(1, { extractedAt: '2026-07-29T12:15:30.000Z' })],
      () => now,
    );
    try {
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 1,
        nextSettlementAt: null,
        published: 1,
        visible: 0,
      });
      expect(store.getLatestInternal(receiptId)?.payload).toMatchObject({
        receiptId,
        revision: 1,
      });
      expect(projection.listActiveRecords()).toEqual([]);
      markLatestApplied(store, '2026-07-29T12:16:01.000Z');
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 1,
        nextSettlementAt: '2026-07-29T12:30:30.000Z',
        published: 0,
        visible: 0,
      });
      now = new Date('2026-07-29T12:31:00.000Z');
      expect(workflow.runOnce()).toMatchObject({
        unsettled: 0,
        nextSettlementAt: null,
        published: 0,
        visible: 1,
      });
    } finally {
      authenticator.destroy();
      store.close();
    }
  });
});

describe('CanonicalReceiptRecordHydrator', () => {
  it('rebuilds a fresh projection from Actual and prevents a duplicate revision-one publication', async () => {
    const original = setup([completed(1)]);
    const restarted = setup([completed(1)]);
    try {
      original.workflow.runOnce();
      const canonicalJson =
        original.store.getLatestInternal(receiptId)!.payload
          .desiredCanonicalJson;
      const actualRecord = parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        canonicalJson,
      );
      let reads = 0;
      let now = new Date('2026-07-29T12:30:00.000Z');
      const hydrator = new CanonicalReceiptRecordHydrator({
        actual: {
          receiptRecords: () => {
            reads += 1;
            return Promise.resolve({
              records: [actualRecord],
              nextAfterNoteId: null,
              truncated: false,
            });
          },
        },
        publication: restarted.workflow,
        now: () => now,
      });

      await expect(hydrator.kick()).resolves.toMatchObject({
        pages: 1,
        records: 1,
        visible: 1,
      });
      expect(restarted.projection.listActiveRecords()).toHaveLength(1);
      expect(restarted.workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(restarted.store.getLatestInternal(receiptId)).toBeUndefined();

      await hydrator.kick();
      expect(reads).toBe(1);
      now = new Date('2026-07-29T12:31:01.000Z');
      await hydrator.kick();
      expect(reads).toBe(2);
    } finally {
      original.authenticator.destroy();
      original.store.close();
      restarted.authenticator.destroy();
      restarted.store.close();
    }
  });

  it('suppresses an exact reupload already owned by one active Actual record', () => {
    const sourceHash = 'd'.repeat(64);
    const original = setup([
      completed(1, {
        sourceSha256: sourceHash,
        messageId: 'original-message',
      }),
    ]);
    const restarted = setup([
      completed(2, {
        sourceSha256: sourceHash,
        messageId: 'reuploaded-message',
      }),
    ]);
    try {
      original.workflow.runOnce();
      const canonicalJson =
        original.store.getLatestInternal(receiptId)!.payload
          .desiredCanonicalJson;
      const actualRecord = parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        canonicalJson,
      );
      restarted.workflow.replaceActualCanonicalRecords([actualRecord.record]);

      expect(restarted.workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(
        restarted.store.getLatestInternal(
          '00000000-0000-4000-8000-000000000002',
        ),
      ).toBeUndefined();
      expect(restarted.projection.listActiveRecords()).toHaveLength(1);
    } finally {
      original.authenticator.destroy();
      original.store.close();
      restarted.authenticator.destroy();
      restarted.store.close();
    }
  });

  it('suppresses a reuploaded subset of an owned multi-photo receipt', () => {
    const firstSourceHash = 'd'.repeat(64);
    const secondSourceHash = 'e'.repeat(64);
    const original = setup([
      completed(1, {
        sourceSha256: firstSourceHash,
        messageId: 'multi-photo-message',
        totalMinor: 3_450,
        itemTotalMinor: 1_725,
      }),
      completed(2, {
        sourceSha256: secondSourceHash,
        messageId: 'multi-photo-message',
        totalMinor: null,
      }),
    ]);
    const restarted = setup([
      completed(3, {
        sourceSha256: firstSourceHash,
        messageId: 'reuploaded-first-photo',
      }),
    ]);
    try {
      original.workflow.runOnce();
      const canonicalJson =
        original.store.getLatestInternal(receiptId)!.payload
          .desiredCanonicalJson;
      const actualRecord = parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        canonicalJson,
      );
      expect(actualRecord.record.sources).toHaveLength(2);
      restarted.workflow.replaceActualCanonicalRecords([actualRecord.record]);

      expect(restarted.workflow.runOnce()).toMatchObject({
        published: 0,
        waitingForActual: 0,
        visible: 1,
      });
      expect(
        restarted.store.getLatestInternal(
          '00000000-0000-4000-8000-000000000003',
        ),
      ).toBeUndefined();
    } finally {
      original.authenticator.destroy();
      original.store.close();
      restarted.authenticator.destroy();
      restarted.store.close();
    }
  });

  it('applies the same settlement gate after a projection-only restart', async () => {
    const original = setup(
      [completed(1, { extractedAt: '2026-07-29T12:15:30.000Z' })],
      '2026-07-29T12:16:00.000Z',
    );
    let now = new Date('2026-07-29T12:16:00.000Z');
    const restarted = setup([], () => now);
    try {
      original.workflow.runOnce();
      const canonicalJson =
        original.store.getLatestInternal(receiptId)!.payload
          .desiredCanonicalJson;
      const actualRecord = parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        canonicalJson,
      );
      const hydrator = new CanonicalReceiptRecordHydrator({
        actual: {
          receiptRecords: () =>
            Promise.resolve({
              records: [actualRecord],
              nextAfterNoteId: null,
              truncated: false,
            }),
        },
        publication: restarted.workflow,
      });

      await expect(hydrator.kick()).resolves.toMatchObject({
        records: 1,
        visible: 0,
      });
      expect(restarted.projection.listActiveRecords()).toEqual([]);
      now = new Date('2026-07-29T12:31:00.000Z');
      expect(restarted.workflow.runOnce()).toMatchObject({ visible: 1 });
      expect(restarted.projection.listActiveRecords()).toHaveLength(1);
    } finally {
      original.authenticator.destroy();
      original.store.close();
      restarted.authenticator.destroy();
      restarted.store.close();
    }
  });

  it('keeps the newest discarded tombstone when Actual is stale', async () => {
    const active = setup([completed(1)]);
    const restarted = setup([]);
    try {
      active.workflow.runOnce();
      const activeCanonicalJson =
        active.store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson;
      const staleActualRecord = parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        activeCanonicalJson,
      );
      markLatestApplied(active.store);
      active.workflow.runOnce();
      active.workflow.discard(receiptId, '2026-07-29T12:20:00.000Z');
      markLatestApplied(active.store, '2026-07-29T12:21:00.000Z');

      const hydrator = new CanonicalReceiptRecordHydrator({
        actual: {
          receiptRecords: () =>
            Promise.resolve({
              records: [staleActualRecord],
              nextAfterNoteId: null,
              truncated: false,
            }),
        },
        publication: active.workflow,
      });
      await expect(hydrator.kick()).resolves.toMatchObject({
        records: 1,
        visible: 0,
      });
      expect(active.projection.listActiveRecords()).toEqual([]);

      const discarded = parseHouseholdFinanceReceiptRecord(
        JSON.parse(
          active.store.getLatestInternal(receiptId)!.payload
            .desiredCanonicalJson,
        ),
      );
      expect(discarded.status).toBe('discarded');
      const discardedActualRecord = parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        active.store.getLatestInternal(receiptId)!.payload.desiredCanonicalJson,
      );
      const restartHydrator = new CanonicalReceiptRecordHydrator({
        actual: {
          receiptRecords: () =>
            Promise.resolve({
              records: [discardedActualRecord],
              nextAfterNoteId: null,
              truncated: false,
            }),
        },
        publication: restarted.workflow,
      });
      await expect(restartHydrator.kick()).resolves.toMatchObject({
        records: 1,
        visible: 0,
      });
      expect(restarted.projection.listActiveRecords()).toEqual([]);
    } finally {
      active.authenticator.destroy();
      active.store.close();
      restarted.authenticator.destroy();
      restarted.store.close();
    }
  });

  it('rejects incomplete pagination instead of dropping tombstones', async () => {
    const restarted = setup([]);
    try {
      const hydrator = new CanonicalReceiptRecordHydrator({
        actual: {
          receiptRecords: () =>
            Promise.resolve({
              records: [],
              nextAfterNoteId:
                'household-finance:receipt:8dfc1bd9-e07a-4c62-9d58-9529361536b9',
              truncated: true,
            }),
        },
        publication: restarted.workflow,
        maximumPages: 2,
      });
      await expect(hydrator.kick()).rejects.toThrow(
        'pagination did not advance',
      );
      expect(restarted.projection.listActiveRecords()).toEqual([]);
    } finally {
      restarted.authenticator.destroy();
      restarted.store.close();
    }
  });
});
