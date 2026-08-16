import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { recentReceiptReadTool } from '../../src/questions/recent-receipt-tools.js';
import {
  actualReceiptNoteId,
  canonicalHouseholdFinanceReceiptJson,
  householdFinanceReceiptSha256,
  type ActualReceiptNoteRecord,
  type HouseholdFinanceActiveReceiptRecordV1,
  type HouseholdFinanceReceiptRecordV1,
  type HouseholdFinanceReceiptSource,
} from '../../src/receipt-record/domain.js';
import type { ReceiptAttachmentReference } from '../../src/storage/attachment-shadow-store.js';
import type { ReceiptMatchRecord } from '../../src/storage/receipt-match-store.js';

function source(
  messageId: string,
  roomToken: string,
  receivedAt: string,
): HouseholdFinanceReceiptSource {
  const sha256 = createHash('sha256').update(messageId).digest('hex');
  return {
    nextcloudFileId: `private-file-${messageId}`,
    archivePath: `Receipts/private-${messageId}.png`,
    sha256,
    mediaType: 'image/png',
    receivedAt,
    talk: {
      roomToken,
      actorId: 'private-actor',
      messageId,
    },
  };
}

function activeNote(input: {
  receiptId: string;
  sources: readonly HouseholdFinanceReceiptSource[];
  merchant?: string | null;
  purchaseDate?: string | null;
  currency?: string | null;
  descriptions?: readonly (string | null)[];
  householdNotes?: readonly string[];
  automaticProcessingBlocked?: boolean;
  status?: 'active' | 'discarded';
}): ActualReceiptNoteRecord {
  const createdAt = input.sources[0]!.receivedAt;
  const updatedAt = input.sources.at(-1)!.receivedAt;
  if (input.status === 'discarded') {
    const record: HouseholdFinanceReceiptRecordV1 = {
      schemaVersion: 'household-finance.receipt.v1',
      receiptId: input.receiptId,
      revision: 2,
      status: 'discarded',
      createdAt,
      updatedAt,
      discardedAt: updatedAt,
      sources: [...input.sources],
    };
    return {
      noteId: actualReceiptNoteId(input.receiptId),
      record,
      canonicalJson: canonicalHouseholdFinanceReceiptJson(record),
      sha256: householdFinanceReceiptSha256(record),
    };
  }
  const record: HouseholdFinanceActiveReceiptRecordV1 = {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId: input.receiptId,
    revision: 1,
    status: 'active',
    createdAt,
    updatedAt,
    sources: [...input.sources],
    merchant: input.merchant === undefined ? 'VEVOR Store' : input.merchant,
    purchaseDate: input.purchaseDate === undefined ? null : input.purchaseDate,
    purchaseTime: null,
    timezoneOffset: null,
    currency: input.currency === undefined ? 'CAD' : input.currency,
    amounts: {
      subtotalMinor: 5_005,
      taxMinor: 0,
      discountMinor: 0,
      tipMinor: 0,
      totalMinor: 5_005,
    },
    paymentEvidence: { kind: 'unknown', lastFour: null },
    receiptReference: 'PRIVATE-REFERENCE',
    ...(input.householdNotes === undefined
      ? {}
      : {
          householdNotes: input.householdNotes.map((text, noteIndex) => ({
            text,
            receivedAt: createdAt,
            talk: {
              roomToken: 'private-room-token',
              actorId: 'private-actor',
              messageId: `note-${String(noteIndex).padStart(3, '0')}`,
            },
          })),
        }),
    items: (
      input.descriptions ?? ['Photo studio light box 4111 1111 1111 1111']
    ).map((description) => ({
      description,
      quantity: 1,
      unitPriceMinor: 5_005,
      totalMinor: 5_005,
    })),
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      zeroDataRetention: true,
      extractedAt: updatedAt,
      ...(input.automaticProcessingBlocked === true
        ? { automaticProcessingBlocked: true }
        : {}),
      sourceSha256s: input.sources.map(({ sha256 }) => sha256),
    },
  };
  return {
    noteId: actualReceiptNoteId(input.receiptId),
    record,
    canonicalJson: canonicalHouseholdFinanceReceiptJson(record),
    sha256: householdFinanceReceiptSha256(record),
  };
}

function unsettledReceipt(messageId = '90'): ReceiptAttachmentReference {
  const observed = (value: string | null) => ({
    value,
    evidence: value === null ? ('absent' as const) : ('explicit' as const),
    confidence: value === null ? 0 : 1,
    sourcePage: value === null ? null : 1,
  });
  const money = (valueMinor: number) => ({
    valueMinor,
    evidence: 'explicit' as const,
    confidence: 1,
    sourcePage: 1,
  });
  const eventId = '99999999-9999-4999-8999-999999999999';
  return {
    event: {
      id: eventId,
      idempotencyKey: 'attachment:unsettled',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'current-room',
      actorId: 'alex',
      messageId,
      attachment: {
        fileId: '900',
        etag: 'private-etag',
        sizeBytes: 10_000,
        mediaType: 'image/jpeg',
      },
      receivedAt: '2026-08-02T12:00:00.000Z',
    },
    shadow: {
      eventId,
      status: 'completed',
      archivePath: 'Finance/Receipts/private.jpg',
      sourceSha256: 'a'.repeat(64),
      proposal: {
        schemaVersion: 'receipt-model-proposal.v1',
        documentDisposition: 'single-receipt',
        merchant: observed('Fresh Market'),
        purchaseDate: observed('2026-08-02'),
        purchaseTime: observed(null),
        timezoneOffset: observed(null),
        currency: observed('CAD'),
        amounts: {
          subtotal: money(1_000),
          tax: money(150),
          discount: money(0),
          tip: money(0),
          total: money(1_150),
        },
        paymentEvidence: {
          kind: 'unknown',
          lastFour: null,
          confidence: 0,
          sourcePage: null,
        },
        receiptReference: observed(null),
        lineItems: [
          {
            description: 'Fresh bread',
            quantity: 1,
            unitPriceMinor: 1_000,
            totalMinor: 1_000,
            confidence: 1,
            sourcePage: 1,
          },
        ],
        uncertainties: [],
      },
      createdAt: '2026-08-02T12:00:00.000Z',
      updatedAt: '2026-08-02T12:00:01.000Z',
    },
    ignored: false,
  };
}

describe('recent receipt read tool', () => {
  it.each([
    [undefined, 'not-enrolled'],
    ['awaiting-bank-transaction', 'waiting-for-bank-transaction'],
    ['ambiguous', 'needs-transaction-selection'],
    ['matched', 'matched-pending-application'],
    ['applied', 'applied'],
    ['attention', 'attention'],
  ] as const)('maps receipt match state %s to %s', async (status, expected) => {
    const note = activeNote({
      receiptId: '22222222-2222-4222-8222-222222222222',
      sources: [source('42', 'current-room', '2026-07-28T12:00:00.000Z')],
    });
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [note],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      matches: {
        getReceipt: () =>
          status === undefined ? undefined : ({ status } as ReceiptMatchRecord),
      },
      roomToken: 'current-room',
      focusedMessageIds: ['42'],
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      selectedReceipt: {
        receipt: { receiptMatchStatus: expected },
      },
    });
  });

  it('paginates canonical Actual notes and returns only active facts from the current room', async () => {
    const otherRoom = activeNote({
      receiptId: '11111111-1111-4111-8111-111111111111',
      sources: [source('40', 'other-room', '2026-07-28T10:00:00.000Z')],
    });
    const focused = activeNote({
      receiptId: '22222222-2222-4222-8222-222222222222',
      sources: [
        source('41', 'current-room', '2026-07-28T11:00:00.000Z'),
        source('42', 'current-room', '2026-07-28T12:00:00.000Z'),
      ],
      householdNotes: [
        'Initial purpose.',
        'Maybe office.',
        'Household supplies.',
        "Correction: Elia's birthday present.",
      ],
    });
    const discarded = activeNote({
      receiptId: '33333333-3333-4333-8333-333333333333',
      sources: [source('43', 'current-room', '2026-07-28T13:00:00.000Z')],
      status: 'discarded',
    });
    const receiptRecords = vi
      .fn()
      .mockResolvedValueOnce({
        records: [otherRoom],
        nextAfterNoteId: otherRoom.noteId,
        truncated: true,
      })
      .mockResolvedValueOnce({
        records: [focused, discarded],
        nextAfterNoteId: null,
        truncated: false,
      });
    const tool = recentReceiptReadTool({
      actual: { receiptRecords },
      roomToken: 'current-room',
      focusedMessageIds: ['42'],
    });

    const result = await tool.execute({});
    expect(result).toEqual({
      receiptFactsAvailable: true,
      selectedReceipt: {
        selection: 'focused-message',
        receipt: {
          receivedAt: '2026-07-28T12:00:00.000Z',
          receiptMatchStatus: 'not-enrolled',
          merchant: 'VEVOR Store',
          purchaseDate: null,
          total: {
            currency: 'CAD',
            valueMinor: 5_005,
            display: 'CAD 50.05',
          },
          householdNotes: [
            'Maybe office.',
            'Household supplies.',
            "Correction: Elia's birthday present.",
          ],
          itemDetailsComplete: true,
          allRecordedItems: {
            recordedCount: 1,
            entries: [
              {
                description: 'Photo studio light box [redacted number]',
                quantity: 1,
                total: {
                  currency: 'CAD',
                  valueMinor: 5_005,
                  display: 'CAD 50.05',
                },
              },
            ],
          },
          missingOrUnclear: ['purchase date'],
          readyForAutomaticReceiptMatching: false,
        },
      },
      recentReceipts: [
        expect.objectContaining({
          receivedAt: '2026-07-28T12:00:00.000Z',
          merchant: 'VEVOR Store',
          itemPreview: {
            recordedCount: 1,
            returnedCount: 1,
            omittedRecordedCount: 0,
            entries: [
              {
                description: 'Photo studio light box [redacted number]',
                quantity: 1,
                total: {
                  currency: 'CAD',
                  valueMinor: 5_005,
                  display: 'CAD 50.05',
                },
              },
            ],
          },
        }),
      ],
      moreReceiptsMayExist: false,
    });
    expect(receiptRecords).toHaveBeenNthCalledWith(1, {
      afterNoteId: null,
      limit: 50,
    });
    expect(receiptRecords).toHaveBeenNthCalledWith(2, {
      afterNoteId: otherRoom.noteId,
      limit: 50,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('other-room');
    expect(serialized).not.toContain('current-room');
    expect(serialized).not.toContain('PRIVATE-REFERENCE');
    expect(serialized).not.toContain('private-file');
    expect(serialized).not.toContain(focused.record.receiptId);
    expect(serialized).not.toContain(focused.record.sources[0]!.sha256);
  });

  it('returns every focused item while marking the recent list as a preview', async () => {
    const descriptions = [
      'Item one',
      'Item two',
      null,
      'Item four',
      'Item five',
      'Item six',
      'Item seven',
      'Item eight',
    ];
    const note = activeNote({
      receiptId: '88888888-8888-4888-8888-888888888888',
      sources: [source('88', 'current-room', '2026-07-30T12:00:00.000Z')],
      descriptions,
    });
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [note],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      roomToken: 'current-room',
    });

    const result = await tool.execute({});
    expect(result).toMatchObject({
      selectedReceipt: {
        selection: 'latest-room-receipt',
        receipt: {
          allRecordedItems: {
            recordedCount: 8,
          },
        },
      },
      recentReceipts: [
        {
          itemPreview: {
            recordedCount: 8,
            returnedCount: 5,
            omittedRecordedCount: 3,
          },
        },
      ],
    });
    const selectedItems = (
      result as {
        selectedReceipt: {
          receipt: {
            allRecordedItems: {
              entries: Array<{ description: string | null }>;
            };
          };
        };
      }
    ).selectedReceipt.receipt.allRecordedItems.entries;
    expect(selectedItems).toHaveLength(8);
    expect(selectedItems.map(({ description }) => description)).toEqual(
      descriptions,
    );
  });

  it('uses the canonical currency without inventing household currency facts', async () => {
    const note = activeNote({
      receiptId: '44444444-4444-4444-8444-444444444444',
      sources: [source('51', 'current-room', '2026-07-29T12:00:00.000Z')],
      purchaseDate: '2026-07-29',
      currency: 'USD',
    });
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [note],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      roomToken: 'current-room',
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      recentReceipts: [
        {
          total: {
            currency: 'USD',
            valueMinor: 5_005,
            display: 'USD 50.05',
          },
          missingOrUnclear: [],
          readyForAutomaticReceiptMatching: true,
        },
      ],
    });
  });

  it('does not substitute an older receipt for an unmatched reply target', async () => {
    const note = activeNote({
      receiptId: '55555555-5555-4555-8555-555555555555',
      sources: [source('51', 'current-room', '2026-07-29T12:00:00.000Z')],
    });
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [note],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      roomToken: 'current-room',
      focusedMessageIds: ['still-processing-upload'],
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      receiptFactsAvailable: true,
      selectedReceipt: null,
      recentReceipts: [expect.objectContaining({ merchant: 'VEVOR Store' })],
    });
  });

  it('reads a focused local extraction before its Actual note has settled', async () => {
    const receiptRecords = vi.fn(async () => ({
      records: [],
      nextAfterNoteId: null,
      truncated: false,
    }));
    const findReceiptsByRoomMessage = vi.fn(() => [unsettledReceipt()]);
    const tool = recentReceiptReadTool({
      actual: { receiptRecords },
      attachments: { findReceiptsByRoomMessage },
      roomToken: 'current-room',
      focusedMessageIds: ['90'],
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      receiptFactsAvailable: true,
      selectedReceipt: {
        selection: 'focused-unsettled-upload',
        receipt: {
          merchant: 'Fresh Market',
          purchaseDate: '2026-08-02',
          total: { currency: 'CAD', valueMinor: 1_150 },
          itemDetailsComplete: true,
          allRecordedItems: {
            recordedCount: 1,
            entries: [expect.objectContaining({ description: 'Fresh bread' })],
          },
        },
      },
      focusedUpload: { status: 'awaiting-canonical-receipt' },
    });
    expect(findReceiptsByRoomMessage).toHaveBeenCalledWith(
      'current-room',
      '90',
    );
    expect(receiptRecords).toHaveBeenCalledOnce();
  });

  it('distinguishes a failed sibling photo from photos still being combined', async () => {
    const completed = unsettledReceipt();
    const failed: ReceiptAttachmentReference = {
      event: {
        ...completed.event,
        id: '30303030-3030-4030-8030-303030303030',
        idempotencyKey: 'attachment:unsettled:failed',
        attachment: { ...completed.event.attachment, fileId: '901' },
      },
      shadow: {
        eventId: '30303030-3030-4030-8030-303030303030',
        status: 'failed',
        archivePath: 'Finance/Receipts/private-failed.jpg',
        sourceSha256: 'b'.repeat(64),
        errorCode: 'model-output-invalid',
        createdAt: '2026-08-02T12:00:00.000Z',
        updatedAt: '2026-08-02T12:00:01.000Z',
      },
      ignored: false,
    };
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      attachments: { findReceiptsByRoomMessage: () => [completed, failed] },
      roomToken: 'current-room',
      focusedMessageIds: ['90'],
    });

    await expect(tool.execute({})).resolves.toEqual({
      receiptFactsAvailable: false,
      selectedReceipt: null,
      focusedUpload: {
        status: 'related-photo-failed',
        photoCount: 2,
        failedPhotoCount: 1,
      },
      recentReceipts: [],
      moreReceiptsMayExist: false,
    });
  });

  it('does not let a partial canonical receipt hide its failed sibling photo', async () => {
    const canonical = activeNote({
      receiptId: '40404040-4040-4040-8040-404040404040',
      sources: [source('90', 'current-room', '2026-08-02T12:00:00.000Z')],
      merchant: 'Partial Market',
      automaticProcessingBlocked: true,
    });
    const completed = unsettledReceipt();
    const failed: ReceiptAttachmentReference = {
      event: {
        ...completed.event,
        id: '50505050-5050-4050-8050-505050505050',
        idempotencyKey: 'attachment:unsettled:failed-canonical',
        attachment: { ...completed.event.attachment, fileId: '902' },
      },
      shadow: {
        eventId: '50505050-5050-4050-8050-505050505050',
        status: 'failed',
        errorCode: 'model-output-invalid',
        createdAt: '2026-08-02T12:00:00.000Z',
        updatedAt: '2026-08-02T12:00:01.000Z',
      },
      ignored: false,
    };
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [canonical],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      attachments: { findReceiptsByRoomMessage: () => [completed, failed] },
      roomToken: 'current-room',
      focusedMessageIds: ['90'],
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      receiptFactsAvailable: false,
      selectedReceipt: null,
      focusedUpload: {
        status: 'related-photo-failed',
        photoCount: 2,
        failedPhotoCount: 1,
      },
    });
  });

  it('prefers the merged canonical receipt over stale same-message photos', async () => {
    const canonical = activeNote({
      receiptId: '10101010-1010-4010-8010-101010101010',
      sources: [source('90', 'current-room', '2026-08-02T12:00:00.000Z')],
      merchant: 'Merged Market',
    });
    const findReceiptsByRoomMessage = vi.fn(() => [
      unsettledReceipt(),
      {
        ...unsettledReceipt(),
        event: {
          ...unsettledReceipt().event,
          id: '20202020-2020-4020-8020-202020202020',
          idempotencyKey: 'attachment:unsettled:second',
          attachment: {
            ...unsettledReceipt().event.attachment,
            fileId: '901',
          },
        },
      },
    ]);
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [canonical],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      attachments: { findReceiptsByRoomMessage },
      roomToken: 'current-room',
      focusedMessageIds: ['90'],
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      selectedReceipt: {
        selection: 'focused-message',
        receipt: { merchant: 'Merged Market' },
      },
    });
    expect(findReceiptsByRoomMessage).not.toHaveBeenCalled();
  });

  it('selects a receipt reached through a bot-reply ancestry chain', async () => {
    const receipt = activeNote({
      receiptId: '66666666-6666-4666-8666-666666666666',
      sources: [source('61', 'current-room', '2026-07-29T12:00:00.000Z')],
      merchant: 'Earlier Market',
    });
    const newer = activeNote({
      receiptId: '77777777-7777-4777-8777-777777777777',
      sources: [source('71', 'current-room', '2026-07-30T12:00:00.000Z')],
      merchant: 'Newer Market',
    });
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => ({
          records: [receipt, newer],
          nextAfterNoteId: null,
          truncated: false,
        }),
      },
      roomToken: 'current-room',
      focusedMessageIds: ['bot-reply', '61'],
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      selectedReceipt: {
        selection: 'focused-message',
        receipt: { merchant: 'Earlier Market' },
      },
      recentReceipts: [
        expect.objectContaining({ merchant: 'Newer Market' }),
        expect.objectContaining({ merchant: 'Earlier Market' }),
      ],
    });
  });

  it('returns a calm empty result if canonical receipt facts are unavailable', async () => {
    const tool = recentReceiptReadTool({
      actual: {
        receiptRecords: async () => {
          throw new Error('private Actual failure');
        },
      },
      roomToken: 'current-room',
    });

    await expect(tool.execute({})).resolves.toEqual({
      receiptFactsAvailable: false,
      selectedReceipt: null,
      recentReceipts: [],
      moreReceiptsMayExist: false,
    });
  });

  it('rejects arguments before reading Actual', async () => {
    const receiptRecords = vi.fn();
    const tool = recentReceiptReadTool({
      actual: { receiptRecords },
      roomToken: 'current-room',
    });

    await expect(tool.execute({ unexpected: true })).resolves.toEqual({
      error: 'invalid_arguments',
    });
    expect(receiptRecords).not.toHaveBeenCalled();
  });
});
