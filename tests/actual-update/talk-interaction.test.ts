import { describe, expect, it, vi } from 'vitest';

import { createApprovalDecision } from '../../src/approval/decision.js';
import type { ActualUpdateTalkDecisionError } from '../../src/actual-update/talk-interaction.js';
import {
  ActualUpdateTalkDecisionHandler,
  ActualUpdateTalkInteractionWorker,
  type ActualUpdateTalkInteractionWorkerOptions,
  createActualUpdateUndoDecision,
  isActualUpdateApprovalPrompt,
  isActualUpdateUndoPrompt,
  renderActualUpdateApprovalMessage,
  renderActualUpdateAutoOutcomeMessage,
} from '../../src/actual-update/talk-interaction.js';
import type {
  ActualUpdateOperationalStatus,
  ActualUpdatePublicIntent,
} from '../../src/storage/actual-update-store.js';
import { ActualUpdateTalkStore } from '../../src/storage/actual-update-talk-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const later = '2026-07-28T12:01:00.000Z';
const backendUrl = 'https://cloud.example.test';
const roomToken = 'finance-room';
const botActorId = `bots/bot-${'a'.repeat(40)}`;

function publicIntent(
  status: ActualUpdateOperationalStatus = 'awaiting-approval',
): ActualUpdatePublicIntent {
  return {
    proposal: {
      schemaVersion: 'actual-update-public-proposal.v2',
      intentId: 'intent-1',
      idempotencyKey: 'intent-idempotency-1',
      targetRef: `actual-target/${'b'.repeat(64)}`,
      accountAlias: 'mastercard',
      summary: {
        date: '2026-07-28',
        amountMinorUnits: -1_725,
        payeeName: 'Example Market',
      },
      payee: { kind: 'preserve' },
      notes: { kind: 'preserve' },
      categorization: { kind: 'single', categoryAlias: 'groceries' },
      sourceId: 'transaction-categorization/source-1',
      auditId: 'audit-1',
      createdAt: instant,
    },
    status,
    approval: null,
    applyAttemptCount: 0,
    undoAttemptCount: 0,
    lastErrorCode: null,
    applyOutcome: null,
    undoOutcome: null,
    updatedAt: status === 'awaiting-approval' ? instant : later,
  };
}

class FakeIntentSource {
  readonly intents = new Map<string, ActualUpdatePublicIntent>();

  constructor(intent: ActualUpdatePublicIntent) {
    this.intents.set(intent.proposal.intentId, intent);
  }

  getPublicIntent(intentId: string): ActualUpdatePublicIntent | undefined {
    return this.intents.get(intentId);
  }

  listPublicIntentsByStatus(
    status: ActualUpdateOperationalStatus,
    maximum = 100,
    order: 'oldest' | 'newest' = 'oldest',
    offset = 0,
  ): readonly ActualUpdatePublicIntent[] {
    const direction = order === 'oldest' ? 1 : -1;
    return [...this.intents.values()]
      .filter((intent) => intent.status === status)
      .sort(
        (left, right) =>
          direction * left.updatedAt.localeCompare(right.updatedAt),
      )
      .slice(offset, offset + maximum);
  }
}

function talkSender() {
  let nextMessageId = 40;
  return vi.fn(
    async (reply: {
      roomToken: string;
      message: string;
      referenceId: string;
      replyTo?: string;
    }) => ({
      roomToken: reply.roomToken,
      botActorId,
      messageId: String(++nextMessageId),
      referenceId: reply.referenceId,
      ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    }),
  );
}

function worker(input: {
  store: ActualUpdateTalkStore;
  source: FakeIntentSource;
  approve: ActualUpdateTalkInteractionWorkerOptions['workflow']['approve'];
  send: ReturnType<typeof talkSender>;
  autoApprovalEnabled: boolean;
  now?: () => Date;
}) {
  return new ActualUpdateTalkInteractionWorker({
    store: input.store,
    intents: input.source,
    workflow: { approve: input.approve },
    talk: { sendReplyWithIdentity: input.send },
    backendUrl,
    roomToken,
    autoApprovalEnabled: input.autoApprovalEnabled,
    now: input.now ?? (() => new Date(instant)),
  });
}

describe('Actual update Talk interaction', () => {
  it('renders a plain alias-only approval message', () => {
    const message = renderActualUpdateApprovalMessage(publicIntent());
    expect(isActualUpdateApprovalPrompt(message)).toBe(true);
    expect(message).toContain('Example Market');
    expect(message).toContain('$17.25');
    expect(message).toContain('Groceries');
    expect(message).not.toMatch(
      /intent-|idempotency|audit|actual-target|minor units/u,
    );
    expect(isActualUpdateUndoPrompt('reply undo')).toBe(false);
    expect(
      isActualUpdateUndoPrompt(
        renderActualUpdateAutoOutcomeMessage(
          publicIntent('applied'),
          'applied',
        ),
      ),
    ).toBe(true);
  });

  it('delivers one explicit prompt and binds approval to its exact parent', async () => {
    const store = new ActualUpdateTalkStore(':memory:');
    const intent = publicIntent();
    const source = new FakeIntentSource(intent);
    const approve = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const reject = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const requestUndo = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const send = talkSender();
    const interaction = worker({
      store,
      source,
      approve,
      send,
      autoApprovalEnabled: false,
    });

    await expect(interaction.reconcileAvailable()).resolves.toMatchObject({
      steps: [{ status: 'approval-delivered' }],
    });
    await expect(interaction.reconcileAvailable()).resolves.toMatchObject({
      steps: [{ status: 'already-delivered' }],
    });
    expect(send).toHaveBeenCalledTimes(1);
    const delivery = store.getDelivery(intent.proposal.intentId);
    if (delivery?.botMessageId === null || delivery === undefined) {
      throw new Error('Synthetic approval parent was not delivered');
    }
    const handler = new ActualUpdateTalkDecisionHandler({
      store,
      intents: source,
      workflow: { approve, reject, requestUndo },
      expectedBackendUrl: backendUrl,
      allowedApproverIds: new Set(['alex', 'sam']),
      now: () => new Date(later),
    });
    handler.handleApproval(
      createApprovalDecision({
        backendUrl,
        roomToken,
        approverId: 'alex',
        inboundMessageId: '50',
        proposalBotId: delivery.botActorId!,
        proposalMessageId: delivery.botMessageId,
        proposalMessageText: delivery.message,
        decision: 'approve',
      }),
    );
    expect(approve).toHaveBeenLastCalledWith({
      intentId: 'intent-1',
      decisionId: expect.stringMatching(/^[a-f0-9]{64}$/),
      actorId: 'alex',
      approvedAt: later,
    });
    store.close();
  });

  it('uses the runtime flag alone to auto-approve and durably report success', async () => {
    const store = new ActualUpdateTalkStore(':memory:');
    const intent = publicIntent();
    const source = new FakeIntentSource(intent);
    const approve = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const send = talkSender();
    const interaction = worker({
      store,
      source,
      approve,
      send,
      autoApprovalEnabled: true,
    });

    await expect(interaction.reconcileAvailable()).resolves.toEqual({
      steps: [{ intentId: 'intent-1', status: 'auto-approved' }],
    });
    expect(send).not.toHaveBeenCalled();
    expect(store.getAutoApproval('intent-1')).toMatchObject({
      actorId: 'household-finance-automation',
    });

    source.intents.set('intent-1', {
      ...intent,
      status: 'applied',
      approval: {
        decision: 'approved',
        decisionId: store.getAutoApproval('intent-1')!.decisionId,
        actorId: 'household-finance-automation',
        reasonCode: null,
        decidedAt: instant,
      },
      applyOutcome: { status: 'updated', completedAt: later },
      updatedAt: later,
    });
    const outcomeWorker = worker({
      store,
      source,
      approve,
      send,
      autoApprovalEnabled: true,
      now: () => new Date(later),
    });
    await expect(outcomeWorker.reconcileAvailable()).resolves.toMatchObject({
      steps: [{ status: 'outcome-delivered' }],
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.getAutoOutcomeStatus('intent-1')).toBe('applied');
    await expect(outcomeWorker.reconcileAvailable()).resolves.toEqual({
      steps: [],
    });
    store.close();
  });

  it('supports reject for an explicit prompt and undo for an automatic outcome', async () => {
    const store = new ActualUpdateTalkStore(':memory:');
    const intent = publicIntent();
    const source = new FakeIntentSource(intent);
    const approve = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const reject = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const requestUndo = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const send = talkSender();
    const explicit = worker({
      store,
      source,
      approve,
      send,
      autoApprovalEnabled: false,
    });
    await explicit.reconcileAvailable();
    const parent = store.getDelivery('intent-1')!;
    const handler = new ActualUpdateTalkDecisionHandler({
      store,
      intents: source,
      workflow: { approve, reject, requestUndo },
      expectedBackendUrl: backendUrl,
      allowedApproverIds: new Set(['alex']),
      now: () => new Date(later),
    });
    handler.handleApproval(
      createApprovalDecision({
        backendUrl,
        roomToken,
        approverId: 'alex',
        inboundMessageId: '51',
        proposalBotId: parent.botActorId!,
        proposalMessageId: parent.botMessageId!,
        proposalMessageText: parent.message,
        decision: 'reject',
      }),
    );
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'intent-1',
        reasonCode: 'talk-rejected',
      }),
    );

    const autoStore = new ActualUpdateTalkStore(':memory:');
    const applied = {
      ...publicIntent('applied'),
      applyOutcome: { status: 'updated' as const, completedAt: later },
    };
    const autoSource = new FakeIntentSource(applied);
    autoStore.planAutoApproval({
      intentId: 'intent-1',
      actorId: 'household-finance-automation',
      approvedAt: instant,
    });
    const autoSend = talkSender();
    const autoWorker = worker({
      store: autoStore,
      source: autoSource,
      approve,
      send: autoSend,
      autoApprovalEnabled: true,
      now: () => new Date(later),
    });
    await autoWorker.reconcileAvailable();
    const outcome = autoStore.getDelivery('intent-1')!;
    const undoHandler = new ActualUpdateTalkDecisionHandler({
      store: autoStore,
      intents: autoSource,
      workflow: { approve, reject, requestUndo },
      expectedBackendUrl: backendUrl,
      allowedApproverIds: new Set(['alex']),
      now: () => new Date(later),
    });
    undoHandler.handleUndo(
      createActualUpdateUndoDecision({
        backendUrl,
        roomToken,
        actorId: 'alex',
        inboundMessageId: '52',
        proposalBotId: outcome.botActorId!,
        proposalMessageId: outcome.botMessageId!,
        proposalMessageText: outcome.message,
      }),
    );
    expect(requestUndo).toHaveBeenCalledWith(
      expect.objectContaining({
        intentId: 'intent-1',
        actorId: 'alex',
      }),
    );
    store.close();
    autoStore.close();
  });

  it('rejects an unapproved actor and altered parent content', async () => {
    const store = new ActualUpdateTalkStore(':memory:');
    const intent = publicIntent();
    const source = new FakeIntentSource(intent);
    const approve = vi.fn(() => ({ outcome: 'recorded' as const, intent }));
    const send = talkSender();
    await worker({
      store,
      source,
      approve,
      send,
      autoApprovalEnabled: false,
    }).reconcileAvailable();
    const parent = store.getDelivery('intent-1')!;
    const handler = new ActualUpdateTalkDecisionHandler({
      store,
      intents: source,
      workflow: {
        approve,
        reject: vi.fn(() => ({ outcome: 'recorded' as const, intent })),
        requestUndo: vi.fn(() => ({ outcome: 'recorded' as const, intent })),
      },
      expectedBackendUrl: backendUrl,
      allowedApproverIds: new Set(['alex']),
    });
    const decision = createApprovalDecision({
      backendUrl,
      roomToken,
      approverId: 'sam',
      inboundMessageId: '53',
      proposalBotId: parent.botActorId!,
      proposalMessageId: parent.botMessageId!,
      proposalMessageText: parent.message,
      decision: 'approve',
    });
    expect(() => handler.handleApproval(decision)).toThrowError(
      expect.objectContaining<Partial<ActualUpdateTalkDecisionError>>({
        code: 'approver-not-allowed',
      }),
    );
    expect(() =>
      handler.handleApproval({
        ...decision,
        approverId: 'alex',
        proposalMessageText: `${parent.message} changed`,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ActualUpdateTalkDecisionError>>({
        code: 'parent-content-mismatch',
      }),
    );
    store.close();
  });
});
