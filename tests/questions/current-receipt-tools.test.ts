import { describe, expect, it, vi } from 'vitest';

import type { ReceiptModelProposalV1 } from '../../src/model/index.js';
import { currentReceiptReadTool } from '../../src/questions/current-receipt-tools.js';
import type { FinanceQuestionAgentInput } from '../../src/questions/xai-finance-agent.js';
import { AttachmentShadowStore } from '../../src/storage/attachment-shadow-store.js';

const receivedAt = '2026-08-02T12:00:00.000Z';

function field(value: string | null) {
  return {
    value,
    evidence: value === null ? ('absent' as const) : ('explicit' as const),
    confidence: value === null ? 0 : 1,
    sourcePage: value === null ? null : 1,
  };
}

function amount(valueMinor: number) {
  return {
    valueMinor,
    evidence: 'explicit' as const,
    confidence: 1,
    sourcePage: 1,
  };
}

function receiptProposal(merchant: string): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'single-receipt',
    merchant: field(merchant),
    purchaseDate: field('2026-08-01'),
    purchaseTime: field(null),
    timezoneOffset: field(null),
    currency: field('CAD'),
    amounts: {
      subtotal: amount(2_799),
      tax: amount(419),
      discount: amount(0),
      tip: amount(0),
      total: amount(3_218),
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    },
    receiptReference: field(null),
    lineItems: [],
    uncertainties: [
      {
        code: 'line-items-unclear',
        message: 'The item rows are unreadable.',
        material: true,
        sourcePage: 1,
      },
    ],
  };
}

function input(
  idempotencyKey: string,
  messageId = '700',
): FinanceQuestionAgentInput {
  return {
    question: 'This was groceries.',
    currentDate: '2026-08-02',
    timezone: 'America/Halifax',
    actionContext: {
      idempotencyKey,
      eventId: 'e8ee088e-3409-49dd-a204-4944d7c697fa',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId,
      message: 'This was groceries.',
      receivedAt,
    },
  };
}

function complete(
  store: AttachmentShadowStore,
  idempotencyKey: string,
  merchant: string,
  fileId: string,
  proposal: ReceiptModelProposalV1 = receiptProposal(merchant),
  messageId = '700',
) {
  const recorded = store.recordInbound({
    idempotencyKey,
    backendUrl: 'https://cloud.example.test',
    roomToken: 'household-finance',
    actorId: 'alex',
    messageId,
    attachment: {
      fileId,
      etag: `etag-${fileId}`,
      sizeBytes: 10_000,
      mediaType: 'image/jpeg',
    },
    captionHint: 'This was groceries.',
    receivedAt,
  });
  store.markPreserved(
    recorded.event.id,
    `Finance/Receipts/${fileId}.jpg`,
    fileId.padStart(64, 'a'),
    receivedAt,
  );
  store.completeShadowAndEnqueueConversation(
    recorded.event.id,
    proposal,
    {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      preflightAttempts: 1,
      documentAttempts: 1,
      durationMs: 100,
      zeroDataRetention: true,
    },
    receivedAt,
  );
  return recorded.event;
}

describe('current receipt read tool', () => {
  it('reports a zero-item receipt as background-pending without claiming a match or update', async () => {
    const store = new AttachmentShadowStore(':memory:');
    complete(
      store,
      'attachment:first',
      'Wrong Market',
      '1',
      receiptProposal('Wrong Market'),
      '699',
    );
    complete(store, 'attachment:current', 'Highland Market', '2');
    const tool = currentReceiptReadTool({
      attachments: store,
      input: input('attachment:current'),
    });

    const result = await tool.execute({});
    expect(result).toMatchObject({
      receiptAvailable: true,
      authenticatedHouseholdCaption: 'This was groceries.',
      receipt: {
        merchant: 'Highland Market',
        purchaseDate: '2026-08-01',
        currency: 'CAD',
        total: {
          currency: 'CAD',
          valueMinor: 3_218,
          display: 'CAD 32.18',
        },
        items: [],
        recordedItemCount: 0,
        itemDetailsComplete: false,
        missingOrUnclear: ['line items'],
        paymentKind: 'unknown',
      },
      workflow: {
        ignored: false,
        originalArchived: true,
        captionAlreadyStoredWithReceipt: true,
        bankTransactionCreatedFromReceipt: false,
        currentPhotoOnly: true,
        relatedPhotosCombinedBeforeLedgerUpdate: true,
        matching: {
          matchable: true,
          processingStatus: 'background-pending',
          outcome: 'not-reported',
          reason: 'matchable',
          explanation:
            'The merchant, date, currency, and total make this receipt eligible for automatic background matching after the canonical receipt pipeline reaches it. This does not mean a matcher job is already queued, a bank transaction has been matched, or Actual has been updated.',
        },
      },
    });
    expect(result).not.toHaveProperty('workflow.matching.ready');
    expect(result).not.toHaveProperty('workflow.matching.matched');
    expect(result).not.toHaveProperty('workflow.matching.applied');
    store.close();
  });

  it('does not expose an attachment when the trusted Talk identity differs', async () => {
    const lookup = vi.fn(() => ({
      event: {
        id: '866ced8f-1d9b-48bd-9422-279b90ce09d3',
        idempotencyKey: 'attachment:current',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'another-room',
        actorId: 'alex',
        messageId: '700',
        attachment: {
          fileId: '2',
          etag: 'etag-2',
          sizeBytes: 10_000,
          mediaType: 'image/jpeg' as const,
        },
        receivedAt,
      },
      shadow: {
        eventId: '866ced8f-1d9b-48bd-9422-279b90ce09d3',
        status: 'completed' as const,
        proposal: receiptProposal('Highland Market'),
        createdAt: receivedAt,
        updatedAt: receivedAt,
      },
      ignored: false,
    }));
    const findReceiptsByRoomMessage = vi.fn(() => []);
    const tool = currentReceiptReadTool({
      attachments: {
        findReceiptByIdempotencyKey: lookup,
        findReceiptsByRoomMessage,
      },
      input: input('attachment:current'),
    });

    await expect(tool.execute({})).resolves.toEqual({
      receiptAvailable: false,
      reason: 'attachment-not-found',
    });
    expect(lookup).toHaveBeenCalledWith('attachment:current');
  });

  it('does not expose a receipt that was ignored before the turn ran', async () => {
    const store = new AttachmentShadowStore(':memory:');
    const event = complete(store, 'attachment:current', 'Highland Market', '2');
    expect(
      store.ignoreReceipt({
        eventId: event.id,
        roomToken: event.roomToken,
        actorId: event.actorId,
        inboundMessageId: '701',
        ignoredAt: receivedAt,
      }),
    ).toEqual({ status: 'ignored' });
    const tool = currentReceiptReadTool({
      attachments: store,
      input: input('attachment:current'),
    });

    await expect(tool.execute({})).resolves.toEqual({
      receiptAvailable: false,
      reason: 'receipt-ignored',
      workflow: { ignored: true },
    });
    store.close();
  });

  it('rejects model-supplied arguments', async () => {
    const lookup = vi.fn();
    const findReceiptsByRoomMessage = vi.fn();
    const tool = currentReceiptReadTool({
      attachments: {
        findReceiptByIdempotencyKey: lookup,
        findReceiptsByRoomMessage,
      },
      input: input('attachment:current'),
    });

    await expect(tool.execute({ receiptId: 'another' })).resolves.toEqual({
      error: 'invalid_arguments',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('explains a split-tender receipt instead of attempting a bank match', async () => {
    const store = new AttachmentShadowStore(':memory:');
    const proposal = receiptProposal('Highland Market');
    proposal.uncertainties = [
      {
        code: 'split-tender',
        message: 'Two payment methods are printed.',
        material: true,
        sourcePage: 1,
      },
    ];
    complete(store, 'attachment:current', 'Highland Market', '2', proposal);
    const tool = currentReceiptReadTool({
      attachments: store,
      input: input('attachment:current'),
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      receiptAvailable: true,
      workflow: {
        matching: {
          matchable: false,
          processingStatus: 'needs-review-before-background-matching',
          outcome: 'not-reported',
          reason: 'split-tender',
          explanation:
            'The receipt appears to use more than one payment method, so one bank charge may not equal the receipt total.',
        },
      },
    });
    store.close();
  });

  it('waits for same-message photos to be combined instead of judging one partial photo', async () => {
    const store = new AttachmentShadowStore(':memory:');
    complete(store, 'attachment:first', 'Partial Market', '1');
    complete(store, 'attachment:current', 'Complete Market', '2');
    const tool = currentReceiptReadTool({
      attachments: store,
      input: input('attachment:current'),
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      receiptAvailable: true,
      workflow: {
        relatedPhotoCount: 2,
        matching: {
          matchable: false,
          processingStatus: 'needs-review-before-background-matching',
          outcome: 'not-reported',
          reason: 'related-photos-pending-merge',
        },
      },
    });
    store.close();
  });

  it('distinguishes a failed sibling photo from photos awaiting combination', async () => {
    const store = new AttachmentShadowStore(':memory:');
    const failed = store.recordInbound({
      idempotencyKey: 'attachment:failed',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '700',
      attachment: {
        fileId: '1',
        etag: 'etag-1',
        sizeBytes: 10_000,
        mediaType: 'image/jpeg',
      },
      captionHint: 'This was groceries.',
      receivedAt,
    });
    store.markFailed(failed.event.id, 'model-output-invalid', receivedAt);
    complete(store, 'attachment:current', 'Complete Market', '2');
    const tool = currentReceiptReadTool({
      attachments: store,
      input: input('attachment:current'),
    });

    await expect(tool.execute({})).resolves.toMatchObject({
      receiptAvailable: true,
      workflow: {
        relatedPhotoCount: 2,
        matching: {
          matchable: false,
          processingStatus: 'needs-review-before-background-matching',
          outcome: 'not-reported',
          reason: 'related-photo-failed',
          explanation:
            'Another picture in this Talk post could not be read. Tell me to drop that picture, then resend it if the receipt needs it.',
        },
      },
    });
    store.close();
  });
});
