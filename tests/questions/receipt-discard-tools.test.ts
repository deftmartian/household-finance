import { describe, expect, it, vi } from 'vitest';

import { receiptIgnoreTool } from '../../src/questions/receipt-discard-tools.js';
import type { ReceiptRecordPublicationWorkflow } from '../../src/receipts/record-projection.js';
import type {
  FinanceAgentConversationTurn,
  FinanceQuestionAgentInput,
} from '../../src/questions/xai-finance-agent.js';
import type { ReceiptAttachmentReference } from '../../src/storage/attachment-shadow-store.js';
import type { ReceiptMatchStore } from '../../src/storage/receipt-match-store.js';

const receivedAt = '2026-07-29T20:30:00.000Z';
const receiptEventId = '5a40ca9b-5bb8-42c7-b928-04459a373b43';

function receipt(
  messageId = '500',
  eventId = receiptEventId,
): ReceiptAttachmentReference {
  return {
    event: {
      id: eventId,
      idempotencyKey: 'receipt-upload:one',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId,
      attachment: {
        fileId: '1000',
        etag: 'receipt-etag',
        sizeBytes: 10_000,
        mediaType: 'image/png',
      },
      receivedAt: '2026-07-29T20:00:00.000Z',
    },
    shadow: {
      eventId,
      status: 'completed',
      archivePath: 'receipts/2026/07/example.png',
      sourceSha256: 'a'.repeat(64),
      proposal: {},
      createdAt: '2026-07-29T20:00:00.000Z',
      updatedAt: '2026-07-29T20:01:00.000Z',
    },
    ignored: false,
  };
}

function input(
  currentReplyTo?: FinanceQuestionAgentInput['currentReplyTo'],
  recentConversation: readonly FinanceAgentConversationTurn[] = [],
): FinanceQuestionAgentInput {
  return {
    question: 'Ignore this receipt.',
    currentDate: '2026-07-29',
    timezone: 'America/Halifax',
    ...(currentReplyTo === undefined ? {} : { currentReplyTo }),
    recentConversation,
    actionContext: {
      idempotencyKey: 'question:ignore-receipt',
      eventId: '246cc237-f394-4778-b8a6-b0ecbd346ac9',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '700',
      message: 'Ignore this receipt.',
      receivedAt,
    },
  };
}

function setup(
  agentInput: FinanceQuestionAgentInput,
  findReceiptsByRoomMessage = vi.fn<
    (
      roomToken: string,
      messageId: string,
    ) => readonly ReceiptAttachmentReference[]
  >((_roomToken, messageId) =>
    messageId === '500' ? [receipt(messageId)] : [],
  ),
  findReceiptByIdempotencyKey = vi.fn<
    (idempotencyKey: string) => ReceiptAttachmentReference | undefined
  >(() => undefined),
) {
  const ignoreAttachment = vi.fn(() => ({ status: 'ignored' as const }));
  const ignoreCategorization = vi.fn(() => ({
    status: 'ignored' as const,
  }));
  const ignoreMatch = vi.fn<ReceiptMatchStore['ignoreReceipt']>(() => ({
    status: 'ignored',
  }));
  const getMatch = vi.fn<ReceiptMatchStore['getReceipt']>(() => undefined);
  const resolveCanonicalReceiptId = vi.fn<
    ReceiptRecordPublicationWorkflow['resolveCanonicalReceiptId']
  >(() => receiptEventId);
  const discardCanonicalReceipt = vi.fn<
    ReceiptRecordPublicationWorkflow['discard']
  >(() => ({
    status: 'recorded',
    receiptId: receiptEventId,
    revision: 2,
    inserted: true,
    outboxStatus: 'queued',
  }));
  const removeSource = vi.fn<ReceiptRecordPublicationWorkflow['removeSource']>(
    () => ({
      status: 'recorded',
      receiptId: receiptEventId,
      revision: 2,
      inserted: true,
      outboxStatus: 'queued',
      remainingSourceCount: 1,
    }),
  );
  const tool = receiptIgnoreTool({
    attachments: {
      findReceiptByIdempotencyKey,
      findReceiptsByRoomMessage,
      ignoreReceipt: ignoreAttachment,
    },
    categorizations: {
      ignoreReceipt: ignoreCategorization,
    },
    matches: { getReceipt: getMatch, ignoreReceipt: ignoreMatch },
    records: {
      resolveCanonicalReceiptId,
      discard: discardCanonicalReceipt,
      removeSource,
    },
    input: agentInput,
  });
  return {
    tool,
    findReceiptByIdempotencyKey,
    findReceiptsByRoomMessage,
    ignoreAttachment,
    ignoreCategorization,
    ignoreMatch,
    getMatch,
    resolveCanonicalReceiptId,
    discardCanonicalReceipt,
    removeSource,
  };
}

describe('receipt ignore tool', () => {
  it('uses the exact current attachment when asked to ignore one picture', async () => {
    const exact = {
      ...receipt('700'),
      event: {
        ...receipt('700').event,
        idempotencyKey: 'question:ignore-receipt',
      },
    };
    const other = receipt('700', '72a8091c-9bbc-4f82-af12-13f75fc30634');
    const findReceiptsByRoomMessage = vi.fn(() => [exact, other]);
    const findReceiptByIdempotencyKey = vi.fn(() => exact);
    const test = setup(
      input(),
      findReceiptsByRoomMessage,
      findReceiptByIdempotencyKey,
    );

    await expect(test.tool.execute({ scope: 'picture' })).resolves.toEqual({
      status: 'changed',
      message:
        'Done — I removed that picture from the saved receipt and kept the other pictures.',
    });
    expect(findReceiptByIdempotencyKey).toHaveBeenCalledWith(
      'question:ignore-receipt',
    );
    expect(findReceiptsByRoomMessage).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).toHaveBeenCalledTimes(1);
    expect(test.ignoreAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: exact.event.id }),
    );
  });

  it('explains a multi-receipt message without discarding anything', async () => {
    const secondReceiptId = '72a8091c-9bbc-4f82-af12-13f75fc30634';
    const test = setup(
      input({
        messageId: '500',
      }),
      vi.fn(() => [receipt(), receipt('500', secondReceiptId)]),
    );
    test.resolveCanonicalReceiptId
      .mockReturnValueOnce(receiptEventId)
      .mockReturnValueOnce(secondReceiptId);

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'no-change',
      message:
        'That message contains more than one receipt, so I cannot safely tell which one you mean. Send the one you want ignored by itself, then reply to it.',
    });
    expect(test.ignoreAttachment).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
    expect(test.ignoreMatch).not.toHaveBeenCalled();
  });

  it('waits when a multi-picture message is only partly resolved', async () => {
    const unresolved = receipt('500', '8b63cb6f-81bf-4f99-bb5a-8c34699bcf6b');
    const test = setup(
      input({ messageId: '500' }),
      vi.fn(() => [receipt(), unresolved]),
    );
    test.resolveCanonicalReceiptId
      .mockReturnValueOnce(receiptEventId)
      .mockReturnValueOnce(undefined);

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'no-change',
      message:
        'One or more pictures are still being read, so I cannot safely tell whether they are one receipt. Try again in a moment, or send the receipt you want ignored by itself.',
    });
    expect(test.ignoreMatch).not.toHaveBeenCalled();
    expect(test.discardCanonicalReceipt).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).not.toHaveBeenCalled();
  });

  it('ignores the receipt in a direct authenticated reply', async () => {
    const test = setup(
      input({
        messageId: '500',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
      }),
    );

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'changed',
      message:
        'Done — I will ignore that receipt. The archived picture is still there if it is ever needed.',
    });

    expect(test.findReceiptsByRoomMessage).toHaveBeenCalledOnce();
    expect(test.findReceiptsByRoomMessage).toHaveBeenCalledWith(
      'household-finance',
      '500',
    );
    expect(test.ignoreMatch).toHaveBeenCalledWith({
      receiptId: receiptEventId,
      actorId: 'alex',
      inboundMessageId: '700',
      ignoredAt: receivedAt,
    });
    expect(test.resolveCanonicalReceiptId).toHaveBeenCalledWith({
      roomToken: 'household-finance',
      messageId: '500',
      nextcloudFileId: '1000',
      sourceSha256: 'a'.repeat(64),
    });
    expect(test.discardCanonicalReceipt).toHaveBeenCalledWith(
      receiptEventId,
      receivedAt,
    );
    const common = {
      eventId: receiptEventId,
      roomToken: 'household-finance',
      actorId: 'alex',
      inboundMessageId: '700',
      ignoredAt: receivedAt,
    };
    expect(test.ignoreCategorization).toHaveBeenCalledWith(common);
    expect(test.ignoreAttachment).toHaveBeenCalledWith(common);
  });

  it('walks through an assistant reply to find the parent receipt', async () => {
    const assistantTurn: FinanceAgentConversationTurn = {
      actor: 'assistant',
      actorId: 'finance-assistant',
      actorDisplayName: 'Household Finance Bot',
      messageId: '600',
      parentMessageId: '500',
      message: 'I saved this receipt.',
    };
    const test = setup(
      input(
        {
          messageId: '600',
          actor: 'assistant',
          actorId: 'finance-assistant',
          actorDisplayName: 'Household Finance Bot',
          message: 'I saved this receipt.',
        },
        [assistantTurn],
      ),
    );

    await expect(
      test.tool.execute({ scope: 'receipt' }),
    ).resolves.toMatchObject({
      status: 'changed',
    });

    expect(test.findReceiptsByRoomMessage).toHaveBeenNthCalledWith(
      1,
      'household-finance',
      '600',
    );
    expect(test.findReceiptsByRoomMessage).toHaveBeenNthCalledWith(
      2,
      'household-finance',
      '500',
    );
    expect(test.ignoreMatch).toHaveBeenCalledOnce();
    expect(test.ignoreCategorization).toHaveBeenCalledOnce();
    expect(test.ignoreAttachment).toHaveBeenCalledOnce();
  });

  it('ignores the canonical receipt when replying to a duplicate upload', async () => {
    const duplicateEventId = 'e90663bd-4f08-49ec-8691-1530176517c9';
    const duplicate = receipt('501', duplicateEventId);
    const test = setup(
      input({
        messageId: '501',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
      }),
      vi.fn((_roomToken, messageId) =>
        messageId === '501' ? [duplicate] : [],
      ),
    );

    await expect(
      test.tool.execute({ scope: 'receipt' }),
    ).resolves.toMatchObject({
      status: 'changed',
    });

    expect(test.resolveCanonicalReceiptId).toHaveBeenCalledWith({
      roomToken: 'household-finance',
      messageId: '501',
      nextcloudFileId: '1000',
      sourceSha256: 'a'.repeat(64),
    });
    expect(test.ignoreMatch).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: receiptEventId }),
    );
    expect(test.ignoreCategorization).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: receiptEventId }),
    );
    expect(test.ignoreAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: duplicateEventId }),
    );
    expect(test.discardCanonicalReceipt).toHaveBeenCalledWith(
      receiptEventId,
      receivedAt,
    );
  });

  it('makes no change when the message has no focused receipt', async () => {
    const test = setup(input(undefined));

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'no-change',
      message:
        'Reply directly to the receipt picture and say “ignore this receipt.”',
    });

    expect(test.findReceiptsByRoomMessage).not.toHaveBeenCalled();
    expect(test.ignoreMatch).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).not.toHaveBeenCalled();
    expect(test.resolveCanonicalReceiptId).not.toHaveBeenCalled();
    expect(test.discardCanonicalReceipt).not.toHaveBeenCalled();
  });

  it('discards a receipt record already linked to a transaction without changing the transaction', async () => {
    const test = setup(
      input({
        messageId: '500',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
      }),
    );
    test.ignoreMatch.mockReturnValue({ status: 'already-applied' });

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'changed',
      message:
        'Done — I will stop using that receipt, but I left the transaction exactly as it was. The archived picture is still there if it is ever needed.',
    });

    expect(test.ignoreMatch).toHaveBeenCalledOnce();
    expect(test.discardCanonicalReceipt).toHaveBeenCalledWith(
      receiptEventId,
      receivedAt,
    );
    expect(test.ignoreCategorization).toHaveBeenCalledOnce();
    expect(test.ignoreAttachment).toHaveBeenCalledOnce();
  });

  it('uses only the local ignore path before a canonical note exists', async () => {
    const test = setup(
      input({
        messageId: '500',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
      }),
    );
    test.resolveCanonicalReceiptId.mockReturnValue(undefined);

    await expect(
      test.tool.execute({ scope: 'receipt' }),
    ).resolves.toMatchObject({
      status: 'changed',
    });

    expect(test.ignoreMatch).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: receiptEventId }),
    );
    expect(test.discardCanonicalReceipt).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).toHaveBeenCalledOnce();
    expect(test.ignoreAttachment).toHaveBeenCalledOnce();
  });

  it('waits without discarding while the receipt matcher owns an active job', async () => {
    const test = setup(
      input({
        messageId: '500',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
      }),
    );
    test.ignoreMatch.mockReturnValue({ status: 'still-processing' });

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'no-change',
      message:
        'That receipt is already being applied, so I cannot safely stop it mid-update. Try again in a moment; once it finishes I can stop using the receipt without undoing the transaction.',
    });

    expect(test.discardCanonicalReceipt).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).not.toHaveBeenCalled();
  });

  it('stops local use and reports calmly when an earlier canonical write needs attention', async () => {
    const test = setup(
      input({
        messageId: '500',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
      }),
    );
    test.discardCanonicalReceipt.mockReturnValue({
      status: 'blocked',
      receiptId: receiptEventId,
      reason: 'prior-write-failed',
    });

    await expect(test.tool.execute({ scope: 'receipt' })).resolves.toEqual({
      status: 'changed',
      message:
        'I stopped using that receipt here, but I could not update the saved receipt yet. The transaction and archived picture are unchanged.',
    });

    expect(test.ignoreMatch).toHaveBeenCalledOnce();
    expect(test.ignoreCategorization).toHaveBeenCalledOnce();
    expect(test.ignoreAttachment).toHaveBeenCalledOnce();
  });

  it('discards a multi-picture message when every picture belongs to one canonical receipt', async () => {
    const second = receipt('500', '8b63cb6f-81bf-4f99-bb5a-8c34699bcf6b');
    const test = setup(
      input({ messageId: '500' }),
      vi.fn(() => [receipt(), second]),
    );

    await expect(
      test.tool.execute({ scope: 'receipt' }),
    ).resolves.toMatchObject({ status: 'changed' });
    expect(test.resolveCanonicalReceiptId).toHaveBeenCalledTimes(2);
    expect(test.ignoreMatch).toHaveBeenCalledOnce();
    expect(test.discardCanonicalReceipt).toHaveBeenCalledOnce();
    expect(test.ignoreAttachment).toHaveBeenCalledTimes(2);
    expect(test.ignoreAttachment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        eventId: receiptEventId,
        inboundMessageId: '700',
      }),
    );
    expect(test.ignoreAttachment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        eventId: second.event.id,
        inboundMessageId: '700',
      }),
    );
  });

  it('removes one bad picture while retaining the rest of the canonical receipt', async () => {
    const test = setup(input({ messageId: '500' }));

    await expect(test.tool.execute({ scope: 'picture' })).resolves.toEqual({
      status: 'changed',
      message:
        'Done — I removed that picture from the saved receipt and kept the other pictures.',
    });

    expect(test.getMatch).toHaveBeenCalledWith(receiptEventId);
    expect(test.removeSource).toHaveBeenCalledWith(
      receiptEventId,
      {
        roomToken: 'household-finance',
        messageId: '500',
        nextcloudFileId: '1000',
        sourceSha256: 'a'.repeat(64),
      },
      receivedAt,
    );
    expect(test.ignoreMatch).not.toHaveBeenCalled();
    expect(test.discardCanonicalReceipt).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: receiptEventId }),
    );
  });

  it('waits before pruning a source while its old receipt facts are still matching', async () => {
    const test = setup(input({ messageId: '500' }));
    test.getMatch.mockReturnValue({
      receiptId: receiptEventId,
      idempotencyKey: 'canonical-source-hash',
      intent: {} as never,
      status: 'awaiting-bank-transaction',
      expiresAt: '2026-08-05T20:00:00.000Z',
      matchAttemptCount: 1,
      createdAt: '2026-07-29T20:00:00.000Z',
      updatedAt: '2026-07-29T20:10:00.000Z',
    });

    await expect(test.tool.execute({ scope: 'picture' })).resolves.toEqual({
      status: 'no-change',
      message:
        'That receipt is still being matched or updated, so I cannot safely change its pictures yet. Try again in a moment.',
    });

    expect(test.removeSource).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).not.toHaveBeenCalled();
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
  });

  it('ignores a duplicate upload without removing its canonical source', async () => {
    const duplicateEventId = 'e90663bd-4f08-49ec-8691-1530176517c9';
    const test = setup(
      input({ messageId: '501' }),
      vi.fn(() => [receipt('501', duplicateEventId)]),
    );
    test.removeSource.mockReturnValue({
      status: 'blocked',
      reason: 'source-not-found',
    });

    await expect(test.tool.execute({ scope: 'picture' })).resolves.toEqual({
      status: 'changed',
      message:
        'Done — I ignored that extra picture. The saved receipt is unchanged.',
    });

    expect(test.ignoreAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: duplicateEventId }),
    );
    expect(test.ignoreCategorization).not.toHaveBeenCalled();
    expect(test.ignoreMatch).not.toHaveBeenCalled();
    expect(test.discardCanonicalReceipt).not.toHaveBeenCalled();
  });

  it('asks for one picture when a multi-picture message cannot identify a page', async () => {
    const test = setup(
      input({ messageId: '500' }),
      vi.fn(() => [
        receipt(),
        receipt('500', 'a0b596ab-e8b7-48ce-a0e0-b2de6b8e5ac3'),
      ]),
    );

    await expect(test.tool.execute({ scope: 'picture' })).resolves.toEqual({
      status: 'no-change',
      message:
        'Those pictures belong to one receipt, but I cannot tell which page you mean. Send the bad picture by itself, then reply to it.',
    });
    expect(test.removeSource).not.toHaveBeenCalled();
    expect(test.ignoreAttachment).not.toHaveBeenCalled();
  });
});
