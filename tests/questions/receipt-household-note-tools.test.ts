import { describe, expect, it, vi } from 'vitest';

import { receiptHouseholdNoteTool } from '../../src/questions/receipt-household-note-tools.js';
import type { ReceiptRecordPublicationWorkflow } from '../../src/receipts/record-projection.js';
import type { ReceiptAttachmentReference } from '../../src/storage/attachment-shadow-store.js';

const receiptId = '5a40ca9b-5bb8-42c7-b928-04459a373b43';
const receivedAt = '2026-07-30T12:00:00.000Z';

function receipt(eventId = receiptId): ReceiptAttachmentReference {
  return {
    event: {
      id: eventId,
      idempotencyKey: `receipt:${eventId}`,
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '500',
      attachment: {
        fileId: eventId,
        etag: 'etag',
        sizeBytes: 100,
        mediaType: 'image/jpeg',
      },
      receivedAt: '2026-07-30T11:00:00.000Z',
    },
    shadow: {
      eventId,
      status: 'completed',
      archivePath: `Receipts/${eventId}.jpg`,
      sourceSha256: 'a'.repeat(64),
      proposal: {},
      createdAt: '2026-07-30T11:00:00.000Z',
      updatedAt: '2026-07-30T11:01:00.000Z',
    },
    ignored: false,
  };
}

function setup(receipts: readonly ReceiptAttachmentReference[] = [receipt()]) {
  const findReceiptByIdempotencyKey = vi.fn(() => undefined);
  const findReceiptsByRoomMessage = vi.fn(() => receipts);
  const resolveCanonicalReceiptId = vi.fn<
    ReceiptRecordPublicationWorkflow['resolveCanonicalReceiptId']
  >(() => receiptId);
  const appendHouseholdNote = vi.fn<
    ReceiptRecordPublicationWorkflow['appendHouseholdNote']
  >(() => ({
    status: 'recorded',
    receiptId,
    revision: 2,
    inserted: true,
    outboxStatus: 'queued',
  }));
  const tool = receiptHouseholdNoteTool({
    attachments: { findReceiptByIdempotencyKey, findReceiptsByRoomMessage },
    records: { appendHouseholdNote, resolveCanonicalReceiptId },
    input: {
      question: "That was for Elia's birthday.",
      currentDate: '2026-07-30',
      timezone: 'America/Halifax',
      currentReplyTo: { messageId: '500' },
      actionContext: {
        idempotencyKey: 'question:receipt-note',
        eventId: '0df9b817-dfde-4f5f-b34a-a10fd027d35d',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '700',
        message: "That was for Elia's birthday.",
        receivedAt,
      },
    },
  });
  return {
    tool,
    findReceiptByIdempotencyKey,
    findReceiptsByRoomMessage,
    resolveCanonicalReceiptId,
    appendHouseholdNote,
  };
}

describe('receipt household note tool', () => {
  it('stores an explicit correction with the focused canonical receipt', async () => {
    const test = setup();

    await expect(test.tool.execute({})).resolves.toEqual({
      status: 'saved',
      message: 'I saved that note with the receipt.',
    });
    expect(test.appendHouseholdNote).toHaveBeenCalledWith(receiptId, {
      text: "That was for Elia's birthday.",
      receivedAt,
      talk: {
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '700',
      },
    });
  });

  it('accepts a multi-photo focus only when all photos resolve to one receipt', async () => {
    const test = setup([
      receipt(),
      receipt('8b63cb6f-81bf-4f99-bb5a-8c34699bcf6b'),
    ]);

    await expect(test.tool.execute({})).resolves.toMatchObject({
      status: 'saved',
    });
    expect(test.resolveCanonicalReceiptId).toHaveBeenCalledTimes(2);
    expect(test.appendHouseholdNote).toHaveBeenCalledOnce();
  });

  it('does not guess when the focused message resolves to multiple receipts', async () => {
    const test = setup([
      receipt(),
      receipt('8b63cb6f-81bf-4f99-bb5a-8c34699bcf6b'),
    ]);
    test.resolveCanonicalReceiptId
      .mockReturnValueOnce(receiptId)
      .mockReturnValueOnce('8b63cb6f-81bf-4f99-bb5a-8c34699bcf6b');

    await expect(test.tool.execute({})).resolves.toEqual({
      status: 'no-change',
      message:
        'That message contains more than one receipt, so I could not safely save the note. Reply to one receipt by itself.',
    });
    expect(test.appendHouseholdNote).not.toHaveBeenCalled();
  });

  it('reports a pending canonical write without claiming the note is saved', async () => {
    const test = setup();
    test.appendHouseholdNote.mockReturnValue({
      status: 'blocked',
      reason: 'prior-write-pending',
    });

    await expect(test.tool.execute({})).resolves.toEqual({
      status: 'pending',
      message:
        'That receipt is still being saved. Try the note again in a moment.',
    });
  });

  it('calmly rejects an older note outside the bounded receipt history', async () => {
    const test = setup();
    test.appendHouseholdNote.mockReturnValue({ status: 'stale' });

    await expect(test.tool.execute({})).resolves.toEqual({
      status: 'no-change',
      message:
        'I left that older note out because a newer receipt update is already saved.',
    });
  });
});
