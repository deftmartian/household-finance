import { describe, expect, it } from 'vitest';

import { AttachmentShadowStore } from '../../src/storage/index.js';

const now = '2026-07-27T01:00:00.000Z';
const conversationReadyAt = '2026-07-27T01:00:01.000Z';

function input(idempotencyKey = 'attachment:test') {
  return {
    idempotencyKey,
    backendUrl: 'https://cloud.example.test',
    roomToken: 'finance-room',
    actorId: 'alex',
    messageId: '42',
    attachment: {
      fileId: '123',
      etag: 'safe-etag',
      sizeBytes: 100,
      mediaType: 'image/jpeg' as const,
    },
    receivedAt: now,
  };
}

describe('AttachmentShadowStore', () => {
  it('records an isolated attachment job exactly once', () => {
    const store = new AttachmentShadowStore(':memory:');

    const first = store.recordInbound(input());
    const duplicate = store.recordInbound(input());

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.event.id).toBe(first.event.id);
    expect(store.claimNextOutbox(now)).toMatchObject({
      kind: 'process-attachment-shadow',
      eventId: first.event.id,
      attemptCount: 1,
    });
    expect(store.claimNextOutbox(now)).toBeUndefined();
    store.close();
  });

  it('rejects a conflicting replay instead of hiding it as a duplicate', () => {
    const store = new AttachmentShadowStore(':memory:');
    store.recordInbound(input());

    expect(() =>
      store.recordInbound({
        ...input(),
        attachment: {
          ...input().attachment,
          fileId: '124',
        },
      }),
    ).toThrow('Attachment replay conflicts with persisted event');
    store.close();
  });

  it('persists an authenticated attachment caption without changing file identity', () => {
    const store = new AttachmentShadowStore(':memory:');
    const recorded = store.recordInbound({
      ...input('attachment:caption'),
      captionHint: 'Groceries for the household.',
    });

    expect(store.getInbound(recorded.event.id)).toMatchObject({
      attachment: input().attachment,
      captionHint: 'Groceries for the household.',
    });
    store.close();
  });

  it('finds the exact attachment by its inbound idempotency key', () => {
    const store = new AttachmentShadowStore(':memory:');
    const first = store.recordInbound(input('attachment:exact:first'));
    const second = store.recordInbound({
      ...input('attachment:exact:second'),
      attachment: { ...input().attachment, fileId: '124' },
    });

    expect(
      store.findReceiptByIdempotencyKey('attachment:exact:second'),
    ).toMatchObject({
      event: {
        id: second.event.id,
        idempotencyKey: 'attachment:exact:second',
        attachment: { fileId: '124' },
      },
      shadow: { eventId: second.event.id, status: 'received' },
      ignored: false,
    });
    expect(
      store.findReceiptByIdempotencyKey('attachment:missing'),
    ).toBeUndefined();
    expect(first.event.id).not.toBe(second.event.id);
    store.close();
  });

  it('returns every picture from a multi-file Talk message', () => {
    const store = new AttachmentShadowStore(':memory:');
    const conversationJobs: string[] = [];
    for (const [index, fileId] of ['123', '124'].entries()) {
      const { event } = store.recordInbound({
        ...input(`attachment:multi:${String(index)}`),
        attachment: { ...input().attachment, fileId },
      });
      const job = store.claimNextOutbox(now);
      store.markPreserved(
        event.id,
        `Finance/Receipts/opaque-${String(index)}.jpg`,
        String(index + 1).repeat(64),
        now,
      );
      store.completeShadowAndEnqueueConversation(
        event.id,
        { schemaVersion: 'receipt-model-proposal.v1' },
        {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true,
        },
        now,
      );
      store.completeOutbox(job?.id ?? -1, now);
    }

    const conversation = store.claimNextOutbox(conversationReadyAt);
    if (conversation !== undefined) {
      conversationJobs.push(conversation.eventId);
      store.completeOutbox(conversation.id, conversationReadyAt);
    }
    expect(store.claimNextOutbox(conversationReadyAt)).toBeUndefined();

    expect(store.findReceiptsByRoomMessage('finance-room', '42')).toHaveLength(
      2,
    );
    expect(conversationJobs).toHaveLength(1);
    store.close();
  });

  it('queues one corrective turn when a related photo arrives after the first turn completed', () => {
    const store = new AttachmentShadowStore(':memory:');
    const first = store.recordInbound(input('attachment:late:first')).event;
    const firstProcess = store.claimNextOutbox(now)!;
    store.markPreserved(
      first.id,
      'Finance/Receipts/first.jpg',
      '1'.repeat(64),
      now,
    );
    store.completeShadowAndEnqueueConversation(
      first.id,
      { schemaVersion: 'receipt-model-proposal.v1' },
      {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        preflightAttempts: 1,
        documentAttempts: 1,
        durationMs: 100,
        zeroDataRetention: true,
      },
      now,
    );
    store.completeOutbox(firstProcess.id, now);
    const firstConversation = store.claimNextOutbox(conversationReadyAt)!;
    store.completeOutbox(firstConversation.id, conversationReadyAt);

    const later = '2026-07-27T01:00:02.000Z';
    const laterReady = '2026-07-27T01:00:03.000Z';
    const second = store.recordInbound({
      ...input('attachment:late:second'),
      attachment: { ...input().attachment, fileId: '124' },
      receivedAt: later,
    }).event;
    const secondProcess = store.claimNextOutbox(later)!;
    store.markPreserved(
      second.id,
      'Finance/Receipts/second.jpg',
      '2'.repeat(64),
      later,
    );
    store.completeShadowAndEnqueueConversation(
      second.id,
      { schemaVersion: 'receipt-model-proposal.v1' },
      {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        preflightAttempts: 1,
        documentAttempts: 1,
        durationMs: 100,
        zeroDataRetention: true,
      },
      later,
    );
    store.completeOutbox(secondProcess.id, later);

    const secondConversation = store.claimNextOutbox(laterReady)!;
    expect(secondConversation.eventId).toBe(second.id);
    expect(secondConversation.idempotencyKey).not.toBe(
      firstConversation.idempotencyKey,
    );
    store.close();
  });

  it('persists a shadow proposal and represents its conversational turn as a rollback-safe Talk job', () => {
    const store = new AttachmentShadowStore(':memory:');
    const { event } = store.recordInbound(input());
    const processJob = store.claimNextOutbox(now);
    store.markPreserved(
      event.id,
      'Finance/Receipts/opaque.jpg',
      'a'.repeat(64),
      now,
    );
    store.completeShadowAndEnqueueConversation(
      event.id,
      { schemaVersion: 'receipt-model-proposal.v1' },
      {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        preflightAttempts: 1,
        documentAttempts: 1,
        durationMs: 100,
        zeroDataRetention: true,
        usage: { costInUsdTicks: 10_000 },
      },
      now,
    );
    store.completeOutbox(processJob?.id ?? -1, now);

    expect(store.getShadowItem(event.id)).toMatchObject({
      status: 'completed',
      sourceSha256: 'a'.repeat(64),
      proposal: { schemaVersion: 'receipt-model-proposal.v1' },
    });
    expect(store.claimNextOutbox(now)).toBeUndefined();
    expect(store.claimNextOutbox(conversationReadyAt)).toMatchObject({
      idempotencyKey: expect.stringMatching(
        /^attachment-conversation:[a-f0-9]{64}:[a-f0-9]{64}$/u,
      ),
      kind: 'deliver-attachment-result',
      eventId: event.id,
      payload: {
        type: 'conversation-handoff',
        fallbackReply: {
          roomToken: 'finance-room',
          message:
            "I saved the receipt, but I couldn't finish checking it right now. Nothing changed in Actual.",
          replyTo: '42',
          referenceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          silent: false,
        },
      },
    });
    expect(store.listAudit(event.id).map((entry) => entry.action)).toEqual([
      'attachment.received',
      'attachment.preserved',
      'attachment.shadow-completed',
    ]);
    store.close();
  });

  it('durably ignores a completed receipt and filters it from receipt reads idempotently', () => {
    const store = new AttachmentShadowStore(':memory:');
    const { event } = store.recordInbound(input('attachment:ignored'));
    const processJob = store.claimNextOutbox(now);
    store.markPreserved(
      event.id,
      'Finance/Receipts/opaque.jpg',
      'a'.repeat(64),
      now,
    );
    store.completeShadowAndEnqueueConversation(
      event.id,
      { schemaVersion: 'receipt-model-proposal.v1' },
      {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        preflightAttempts: 1,
        documentAttempts: 1,
        durationMs: 100,
        zeroDataRetention: true,
        usage: { costInUsdTicks: 10_000 },
      },
      now,
    );
    store.completeOutbox(processJob?.id ?? -1, now);

    expect(store.listCompletedShadows()).toHaveLength(1);
    expect(store.findReceiptsByRoomMessage('finance-room', '42')).toMatchObject(
      [{ event: { id: event.id }, ignored: false }],
    );
    const ignore = {
      eventId: event.id,
      roomToken: 'finance-room',
      actorId: 'alex',
      inboundMessageId: 'ignore-message-1',
      ignoredAt: '2026-07-27T01:01:00.000Z',
    };
    expect(store.ignoreReceipt(ignore)).toEqual({ status: 'ignored' });
    expect(store.ignoreReceipt(ignore)).toEqual({
      status: 'already-ignored',
    });

    expect(store.listCompletedShadows()).toEqual([]);
    expect(store.findReceiptsByRoomMessage('finance-room', '42')).toMatchObject(
      [{ event: { id: event.id }, ignored: true }],
    );
    expect(store.claimNextOutbox(now)).toBeUndefined();
    expect(store.listAudit(event.id).map((entry) => entry.action)).toContain(
      'attachment.receipt-ignored',
    );
    store.close();
  });

  it('persists an ignore while receipt extraction is pending or already in flight', () => {
    const store = new AttachmentShadowStore(':memory:');
    const pending = store.recordInbound(input('attachment:pending-ignore'));
    const pendingIgnore = {
      eventId: pending.event.id,
      roomToken: 'finance-room',
      actorId: 'alex',
      inboundMessageId: 'ignore-pending',
      ignoredAt: '2026-07-27T01:01:00.000Z',
    };

    expect(store.ignoreReceipt(pendingIgnore)).toEqual({
      status: 'still-processing',
    });
    expect(store.findReceiptsByRoomMessage('finance-room', '42')).toMatchObject(
      [{ ignored: true }],
    );
    expect(store.claimNextOutbox(now)).toBeUndefined();

    const inFlight = store.recordInbound({
      ...input('attachment:in-flight-ignore'),
      messageId: '43',
      attachment: { ...input().attachment, fileId: '124' },
    });
    const claimed = store.claimNextOutbox(now);
    expect(claimed?.eventId).toBe(inFlight.event.id);
    store.markPreserved(
      inFlight.event.id,
      'Finance/Receipts/in-flight.jpg',
      'c'.repeat(64),
      now,
    );
    expect(
      store.ignoreReceipt({
        eventId: inFlight.event.id,
        roomToken: 'finance-room',
        actorId: 'alex',
        inboundMessageId: 'ignore-in-flight',
        ignoredAt: '2026-07-27T01:01:00.000Z',
      }),
    ).toEqual({ status: 'still-processing' });
    store.completeShadowAndEnqueueConversation(
      inFlight.event.id,
      { schemaVersion: 'receipt-model-proposal.v1' },
      {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        preflightAttempts: 1,
        documentAttempts: 1,
        durationMs: 100,
        zeroDataRetention: true,
      },
      now,
    );
    store.completeOutbox(claimed!.id, now);
    expect(store.listCompletedShadows()).toEqual([]);
    expect(store.claimNextOutbox(now)).toBeUndefined();
    store.close();
  });

  it('idempotently ignores every attachment named by one Talk request', () => {
    const store = new AttachmentShadowStore(':memory:');
    const first = store.recordInbound(input('attachment:ignore-group:first'));
    const second = store.recordInbound({
      ...input('attachment:ignore-group:second'),
      attachment: { ...input().attachment, fileId: '124' },
    });
    const common = {
      roomToken: 'finance-room',
      actorId: 'alex',
      inboundMessageId: 'ignore-group-message',
      ignoredAt: '2026-07-27T01:01:00.000Z',
    };

    expect(store.ignoreReceipt({ ...common, eventId: first.event.id })).toEqual(
      { status: 'still-processing' },
    );
    expect(
      store.ignoreReceipt({ ...common, eventId: second.event.id }),
    ).toEqual({ status: 'still-processing' });
    expect(store.ignoreReceipt({ ...common, eventId: first.event.id })).toEqual(
      { status: 'already-ignored' },
    );
    expect(
      store.ignoreReceipt({ ...common, eventId: second.event.id }),
    ).toEqual({ status: 'already-ignored' });
    expect(store.findReceiptsByRoomMessage('finance-room', '42')).toMatchObject(
      [{ ignored: true }, { ignored: true }],
    );
    expect(store.claimNextOutbox(now)).toBeUndefined();
    store.close();
  });

  it('ignores every upload with the same receipt image', () => {
    const store = new AttachmentShadowStore(':memory:');
    const first = store.recordInbound(input('attachment:duplicate:first'));
    const second = store.recordInbound({
      ...input('attachment:duplicate:second'),
      messageId: '43',
      attachment: { ...input().attachment, fileId: '124' },
    });
    for (const recorded of [first, second]) {
      const processJob = store.claimNextOutbox(now);
      expect(processJob?.eventId).toBe(recorded.event.id);
      store.markPreserved(
        recorded.event.id,
        `Finance/Receipts/${recorded.event.messageId}.jpg`,
        'b'.repeat(64),
        now,
      );
      store.completeShadowAndEnqueueConversation(
        recorded.event.id,
        { schemaVersion: 'receipt-model-proposal.v1' },
        {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true,
          usage: { costInUsdTicks: 10_000 },
        },
        now,
      );
      store.completeOutbox(processJob?.id ?? -1, now);
    }

    expect(store.listCompletedShadows()).toHaveLength(2);
    expect(
      store.ignoreReceipt({
        eventId: second.event.id,
        roomToken: 'finance-room',
        actorId: 'alex',
        inboundMessageId: 'ignore-message-duplicate',
        ignoredAt: '2026-07-27T01:01:00.000Z',
      }),
    ).toEqual({ status: 'ignored' });
    expect(store.listCompletedShadows()).toEqual([]);
    expect(store.findReceiptsByRoomMessage('finance-room', '42')).toMatchObject(
      [{ ignored: true }],
    );
    expect(store.findReceiptsByRoomMessage('finance-room', '43')).toMatchObject(
      [{ ignored: true }],
    );
    expect(store.claimNextOutbox(now)).toBeUndefined();
    store.close();
  });

  it('silently inherits an existing ignore for a later exact reupload', () => {
    const store = new AttachmentShadowStore(':memory:');
    const first = store.recordInbound(input('attachment:ignored-original'));
    const firstJob = store.claimNextOutbox(now)!;
    store.markPreserved(
      first.event.id,
      'Finance/Receipts/original.jpg',
      'd'.repeat(64),
      now,
    );
    const metadata = {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      preflightAttempts: 1,
      documentAttempts: 1,
      durationMs: 100,
      zeroDataRetention: true as const,
    };
    store.completeShadowAndEnqueueConversation(
      first.event.id,
      { schemaVersion: 'receipt-model-proposal.v1' },
      metadata,
      now,
    );
    store.completeOutbox(firstJob.id, now);
    expect(
      store.ignoreReceipt({
        eventId: first.event.id,
        roomToken: 'finance-room',
        actorId: 'alex',
        inboundMessageId: 'ignore-original',
        ignoredAt: '2026-07-27T01:01:00.000Z',
      }),
    ).toEqual({ status: 'ignored' });

    const repeated = store.recordInbound({
      ...input('attachment:ignored-reupload'),
      messageId: '43',
      attachment: { ...input().attachment, fileId: '124' },
    });
    const repeatedJob = store.claimNextOutbox(now)!;
    store.markPreserved(
      repeated.event.id,
      'Finance/Receipts/repeated.jpg',
      'd'.repeat(64),
      now,
    );
    const reusable = store.findCompletedBySourceSha256(
      'd'.repeat(64),
      repeated.event.id,
    );
    expect(reusable).toMatchObject({
      eventId: first.event.id,
      modelMetadata: metadata,
    });
    store.completeReusedShadowAndEnqueueConversation(
      repeated.event.id,
      reusable!.proposal,
      reusable!.modelMetadata,
      reusable!.eventId,
      now,
    );
    store.completeOutbox(repeatedJob.id, now);

    expect(store.listCompletedShadows()).toEqual([]);
    expect(store.claimNextOutbox(now)).toBeUndefined();
    store.close();
  });

  it('clears a definitely untransmitted provider call for a safe retry', () => {
    const store = new AttachmentShadowStore(':memory:');
    const { event } = store.recordInbound(input());
    store.markPreserved(
      event.id,
      'Finance/Receipts/opaque.jpg',
      'a'.repeat(64),
      now,
    );

    store.startProviderCall(event.id, now);
    store.clearProviderCallBeforeSend(event.id, now);
    expect(store.listAudit(event.id).map((entry) => entry.action)).toContain(
      'attachment.provider-call-not-sent',
    );
    expect(() => store.startProviderCall(event.id, now)).not.toThrow();
    store.close();
  });

  it('does not retransmit an interrupted provider call', () => {
    const store = new AttachmentShadowStore(':memory:');
    const { event } = store.recordInbound(input());
    store.claimNextOutbox(now);
    store.markPreserved(
      event.id,
      'Finance/Receipts/opaque.jpg',
      'a'.repeat(64),
      now,
    );
    store.startProviderCall(event.id, now);

    expect(store.recoverInterruptedOutbox(now)).toBe(1);
    expect(store.getShadowItem(event.id)).toMatchObject({
      status: 'failed',
      errorCode: 'provider-outcome-unknown',
    });
    expect(store.claimNextOutbox(now)).toMatchObject({
      kind: 'deliver-attachment-result',
      eventId: event.id,
      attemptCount: 1,
      payload: {
        type: 'talk-reply',
        reply: {
          message:
            'Something interrupted me while I was reading this receipt. Nothing changed in Actual. Please send the receipt again.',
        },
      },
    });
    expect(store.listAudit(event.id).map((entry) => entry.action)).toContain(
      'attachment.provider-outcome-unknown',
    );
    store.close();
  });
});
