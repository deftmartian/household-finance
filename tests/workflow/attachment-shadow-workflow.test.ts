import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import {
  ReceiptDocumentPreparer,
  type PdfRasterizer,
} from '../../src/documents/index.js';
import {
  XaiResponsesAdapterError,
  type ReceiptModelAdapter,
  type ReceiptModelProposalV1,
} from '../../src/model/index.js';
import {
  WebDavFileSourceError,
  type RetrievedNextcloudFile,
} from '../../src/nextcloud/index.js';
import { AttachmentShadowStore } from '../../src/storage/index.js';
import {
  AttachmentShadowWorkflow,
  type AttachmentConversationSink,
  type AttachmentDocumentPreparer,
  type AttachmentFileSource,
  type AttachmentTalkReplySender,
  type BinaryOriginalArchive,
} from '../../src/workflow/index.js';
import { RemoteReceiptDocumentPreparationError } from '../../src/documents/index.js';

const now = new Date('2026-07-27T01:30:00.000Z');

function unknownField() {
  return {
    value: null,
    evidence: 'absent' as const,
    confidence: 0,
    sourcePage: null,
  };
}

function unknownAmount() {
  return {
    valueMinor: null,
    evidence: 'absent' as const,
    confidence: 0,
    sourcePage: null,
  };
}

function proposal(): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'uncertain',
    merchant: {
      value: 'Example Market',
      evidence: 'explicit',
      confidence: 0.9,
      sourcePage: 1,
    },
    purchaseDate: unknownField(),
    purchaseTime: unknownField(),
    timezoneOffset: unknownField(),
    currency: {
      value: 'CAD',
      evidence: 'explicit',
      confidence: 0.9,
      sourcePage: 1,
    },
    amounts: {
      subtotal: unknownAmount(),
      tax: unknownAmount(),
      discount: unknownAmount(),
      tip: unknownAmount(),
      total: {
        valueMinor: 1725,
        evidence: 'explicit',
        confidence: 0.9,
        sourcePage: 1,
      },
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    },
    receiptReference: unknownField(),
    lineItems: [],
    uncertainties: [],
  };
}

async function fixture(): Promise<RetrievedNextcloudFile> {
  const bytes = await sharp({
    create: {
      width: 200,
      height: 400,
      channels: 3,
      background: '#ffffff',
    },
  })
    .jpeg()
    .toBuffer();
  return {
    bytes,
    etag: 'test-etag',
    mediaType: 'image/jpeg',
    sizeBytes: bytes.length,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function setup(
  model: ReceiptModelAdapter,
  signal?: AbortSignal,
  preparer?: AttachmentDocumentPreparer,
  clock?: () => Date,
) {
  let defaultTime = new Date(now);
  const effectiveClock = clock ?? (() => new Date(defaultTime));
  const store = new AttachmentShadowStore(':memory:');
  const retrieved = await fixture();
  const source: AttachmentFileSource = {
    retrieve: vi.fn(async () => ({
      ...retrieved,
      bytes: Buffer.from(retrieved.bytes),
    })),
  };
  const archive: BinaryOriginalArchive = {
    preserveBinaryOriginal: vi.fn(async () => ({
      path: 'Finance/Receipts/opaque.jpg',
      created: true,
    })),
  };
  const talk = {
    sendReplyWithIdentity: vi.fn<
      AttachmentTalkReplySender['sendReplyWithIdentity']
    >(async (reply) => ({
      roomToken: reply.roomToken,
      botActorId: `bots/bot-${'a'.repeat(40)}`,
      messageId: '101',
      referenceId: reply.referenceId,
      ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    })),
  } satisfies AttachmentTalkReplySender;
  const conversation = {
    enqueueCompletedAttachment: vi.fn<
      AttachmentConversationSink['enqueueCompletedAttachment']
    >(async () => undefined),
  } satisfies AttachmentConversationSink;
  const rasterizer: PdfRasterizer = {
    rasterize: vi.fn(async () => []),
  };
  const workflow = new AttachmentShadowWorkflow({
    store,
    source,
    archive,
    preparer: preparer ?? new ReceiptDocumentPreparer(rasterizer),
    model,
    talk,
    conversation,
    ...(signal === undefined ? {} : { signal }),
    now: effectiveClock,
  });
  const event = store.recordInbound({
    idempotencyKey: 'attachment:test',
    backendUrl: 'https://cloud.example.test',
    roomToken: 'finance-room',
    actorId: 'alex',
    messageId: '42',
    attachment: {
      fileId: '123',
      etag: 'test-etag',
      sizeBytes: retrieved.sizeBytes,
      mediaType: 'image/jpeg',
    },
    receivedAt: now.toISOString(),
  }).event;
  return {
    store,
    workflow,
    event,
    talk,
    conversation,
    source,
    archive,
    advanceDefaultClock: (milliseconds: number) => {
      if (clock !== undefined) {
        throw new Error('The supplied test clock must be advanced directly');
      }
      defaultTime = new Date(defaultTime.valueOf() + milliseconds);
    },
  };
}

describe('AttachmentShadowWorkflow', () => {
  it('retries a signed file that is not yet visible in WebDAV', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(),
    };
    const { store, workflow, event, talk, source } = await setup(model);
    vi.mocked(source.retrieve).mockRejectedValueOnce(
      new WebDavFileSourceError('file-not-found'),
    );

    expect(await workflow.processAvailable()).toBe(1);
    expect(store.getShadowItem(event.id)?.status).toBe('received');
    expect(talk.sendReplyWithIdentity).not.toHaveBeenCalled();
    expect(
      store.claimNextOutbox(new Date(now.valueOf() + 2_000).toISOString()),
    ).toMatchObject({
      kind: 'process-attachment-shadow',
      attemptCount: 2,
    });
    store.close();
  });

  it('does not claim another attachment after shutdown is requested', async () => {
    const controller = new AbortController();
    const model: ReceiptModelAdapter = {
      extract: vi.fn(),
    };
    const { store, workflow, event, source } = await setup(
      model,
      controller.signal,
    );
    controller.abort();

    expect(await workflow.processAvailable()).toBe(0);
    expect(source.retrieve).not.toHaveBeenCalled();
    expect(store.getShadowItem(event.id)?.status).toBe('received');
    store.close();
  });

  it('cancels remote preparation on shutdown before calling the model', async () => {
    const controller = new AbortController();
    const model: ReceiptModelAdapter = {
      extract: vi.fn(),
    };
    const remotePreparer: AttachmentDocumentPreparer = {
      prepare: vi.fn(async (_source, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        throw new RemoteReceiptDocumentPreparationError('request-aborted');
      }),
    };
    const { store, workflow } = await setup(
      model,
      controller.signal,
      remotePreparer,
    );

    expect(await workflow.processAvailable(1)).toBe(1);
    expect(remotePreparer.prepare).toHaveBeenCalledOnce();
    expect(model.extract).not.toHaveBeenCalled();
    store.close();
  });

  it('clears the call marker when shutdown wins before the preflight request', async () => {
    const controller = new AbortController();
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => {
        controller.abort();
        throw new XaiResponsesAdapterError(
          'request-aborted-before-send',
          'preflight',
        );
      }),
    };
    const { store, workflow, event } = await setup(model, controller.signal);

    expect(await workflow.processAvailable(1)).toBe(1);
    expect(model.extract).toHaveBeenCalledOnce();
    expect(store.getShadowItem(event.id)?.status).toBe('preserved');
    expect(store.listAudit(event.id).map((entry) => entry.action)).toContain(
      'attachment.provider-call-not-sent',
    );
    store.close();
  });

  it('archives, extracts, records, and hands the exact event to conversation without any Actual dependency', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
          usage: { costInUsdTicks: 1_000 },
        },
      })),
    };
    const {
      store,
      workflow,
      event,
      talk,
      conversation,
      source,
      archive,
      advanceDefaultClock,
    } = await setup(model);

    expect(await workflow.processAvailable()).toBe(1);
    advanceDefaultClock(1_000);
    expect(await workflow.processAvailable()).toBe(1);

    expect(source.retrieve).toHaveBeenCalledOnce();
    expect(archive.preserveBinaryOriginal).toHaveBeenCalledOnce();
    expect(model.extract).toHaveBeenCalledOnce();
    expect(talk.sendReplyWithIdentity).not.toHaveBeenCalled();
    expect(conversation.enqueueCompletedAttachment).toHaveBeenCalledOnce();
    expect(conversation.enqueueCompletedAttachment).toHaveBeenCalledWith(event);
    expect(store.getShadowItem(event.id)).toMatchObject({
      status: 'completed',
      proposal: {
        schemaVersion: 'receipt-model-proposal.v1',
      },
    });
    store.close();
  });

  it('retries a failed conversation handoff without re-extracting or posting a canned reply', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
          usage: { costInUsdTicks: 1_000 },
        },
      })),
    };
    let currentTime = now;
    const { store, workflow, event, talk, conversation } = await setup(
      model,
      undefined,
      undefined,
      () => new Date(currentTime),
    );
    vi.mocked(conversation.enqueueCompletedAttachment)
      .mockRejectedValueOnce(new Error('synthetic handoff interruption'))
      .mockResolvedValueOnce(undefined);

    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 1_000);
    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 2_000);
    expect(await workflow.processAvailable()).toBe(1);

    expect(model.extract).toHaveBeenCalledOnce();
    expect(talk.sendReplyWithIdentity).not.toHaveBeenCalled();
    expect(conversation.enqueueCompletedAttachment).toHaveBeenCalledTimes(2);
    expect(conversation.enqueueCompletedAttachment).toHaveBeenNthCalledWith(
      1,
      event,
    );
    expect(conversation.enqueueCompletedAttachment).toHaveBeenNthCalledWith(
      2,
      event,
    );
    store.close();
  });

  it('falls back to the durable success reply after repeated conversation handoff failures', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
        },
      })),
    };
    let currentTime = now;
    const { store, workflow, talk, conversation } = await setup(
      model,
      undefined,
      undefined,
      () => new Date(currentTime),
    );
    vi.mocked(conversation.enqueueCompletedAttachment).mockRejectedValue(
      new Error('synthetic handoff interruption'),
    );

    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 1_000);
    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 2_000);
    expect(await workflow.processAvailable()).toBe(1);

    expect(model.extract).toHaveBeenCalledOnce();
    expect(conversation.enqueueCompletedAttachment).toHaveBeenCalledTimes(2);
    expect(talk.sendReplyWithIdentity).toHaveBeenCalledOnce();
    expect(talk.sendReplyWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "I saved the receipt, but I couldn't finish checking it right now. Nothing changed in Actual.",
      }),
    );
    store.close();
  });

  it('retries the durable fallback when its first Talk delivery is interrupted', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
        },
      })),
    };
    let currentTime = now;
    const { store, workflow, talk, conversation } = await setup(
      model,
      undefined,
      undefined,
      () => new Date(currentTime),
    );
    vi.mocked(conversation.enqueueCompletedAttachment).mockRejectedValue(
      new Error('synthetic handoff interruption'),
    );
    vi.mocked(talk.sendReplyWithIdentity).mockRejectedValueOnce(
      new Error('synthetic Talk interruption'),
    );

    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 1_000);
    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 2_000);
    expect(await workflow.processAvailable()).toBe(1);
    currentTime = new Date(now.valueOf() + 4_000);
    expect(await workflow.processAvailable()).toBe(1);

    expect(conversation.enqueueCompletedAttachment).toHaveBeenCalledTimes(3);
    expect(talk.sendReplyWithIdentity).toHaveBeenCalledTimes(2);
    expect(talk.sendReplyWithIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message:
          "I saved the receipt, but I couldn't finish checking it right now. Nothing changed in Actual.",
      }),
    );
    store.close();
  });

  it('reuses an identical completed source without another model call', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
          usage: { costInUsdTicks: 1_000 },
        },
      })),
    };
    const { store, workflow, talk, conversation, advanceDefaultClock } =
      await setup(model);

    expect(await workflow.processAvailable()).toBe(1);
    advanceDefaultClock(1_000);
    expect(await workflow.processAvailable()).toBe(1);
    const repeated = store.recordInbound({
      idempotencyKey: 'attachment:repeated-content',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'finance-room',
      actorId: 'alex',
      messageId: '43',
      attachment: {
        fileId: '124',
        etag: 'another-etag',
        sizeBytes: 1,
        mediaType: 'image/jpeg',
      },
      receivedAt: now.toISOString(),
    }).event;
    expect(await workflow.processAvailable()).toBe(1);
    advanceDefaultClock(1_000);
    expect(await workflow.processAvailable()).toBe(1);

    expect(model.extract).toHaveBeenCalledOnce();
    expect(talk.sendReplyWithIdentity).not.toHaveBeenCalled();
    expect(conversation.enqueueCompletedAttachment).toHaveBeenCalledTimes(2);
    expect(conversation.enqueueCompletedAttachment).toHaveBeenNthCalledWith(
      2,
      repeated,
    );
    expect(store.getShadowItem(repeated.id)).toMatchObject({
      status: 'completed',
      proposal: { schemaVersion: 'receipt-model-proposal.v1' },
      modelMetadata: {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        zeroDataRetention: true,
      },
    });
    expect(store.listAudit(repeated.id).map((entry) => entry.action)).toContain(
      'attachment.shadow-reused',
    );
    store.close();
  });

  it('fails closed on a provider error', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => {
        throw new XaiResponsesAdapterError('zdr-required', 'document');
      }),
    };
    const { store, workflow, event, talk, conversation } = await setup(model);

    expect(await workflow.processAvailable()).toBe(2);

    expect(store.getShadowItem(event.id)).toMatchObject({
      status: 'failed',
      errorCode: 'model-zdr-required',
    });
    expect(talk.sendReplyWithIdentity).toHaveBeenCalledOnce();
    expect(conversation.enqueueCompletedAttachment).not.toHaveBeenCalled();
    const failureReply = vi.mocked(talk.sendReplyWithIdentity).mock
      .calls[0]?.[0].message;
    expect(failureReply).toContain("I didn't change the budget");
    expect(failureReply).not.toContain('Audit ID');
    expect(failureReply).not.toContain('zdr-required');
    expect(failureReply).not.toContain('stopped safely');
    expect(failureReply).not.toContain('shadow');
    store.close();
  });

  it('does not require local cost accounting to save a valid result', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
        },
      })),
    };
    const { store, workflow, event } = await setup(model);

    expect(await workflow.processAvailable()).toBe(1);

    expect(store.getShadowItem(event.id)).toMatchObject({
      status: 'completed',
    });
    store.close();
  });

  it('records provider usage without imposing a local dollar gate', async () => {
    const model: ReceiptModelAdapter = {
      extract: vi.fn(async () => ({
        proposal: proposal(),
        metadata: {
          provider: 'xai',
          requestedModel: 'grok-4.5',
          resolvedModel: 'grok-4.5',
          preflightAttempts: 1,
          documentAttempts: 1,
          durationMs: 100,
          zeroDataRetention: true as const,
          usage: { costInUsdTicks: 20_001 },
        },
      })),
    };
    const { store, workflow, event } = await setup(model);

    expect(await workflow.processAvailable()).toBe(1);

    expect(store.getShadowItem(event.id)).toMatchObject({
      status: 'completed',
      modelMetadata: {
        usage: { costInUsdTicks: 20_001 },
      },
    });
    store.close();
  });
});
