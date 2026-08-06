import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ActualUpdateTalkStore,
  ActualUpdateTalkStoreConflictError,
} from '../../src/storage/actual-update-talk-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const later = '2026-07-28T12:01:00.000Z';
const botActorId = `bots/bot-${'a'.repeat(40)}`;
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function digest(character: string): string {
  return character.repeat(64);
}

function plan(intentId = 'intent-1') {
  return {
    intentId,
    deliveryIdempotencyKey: digest('b'),
    backendUrl: 'https://cloud.example.test/',
    roomToken: 'finance-room',
    referenceId: digest('c'),
    message: 'Please approve this update.',
    createdAt: instant,
  };
}

function completeParent(store: ActualUpdateTalkStore, intentId = 'intent-1') {
  const input = plan(intentId);
  store.planDelivery(input);
  const claim = store.claimDelivery(intentId, instant);
  if (claim === undefined) {
    throw new Error('Synthetic Talk delivery was not claimable');
  }
  return store.completeDelivery(
    intentId,
    claim.leaseToken,
    {
      roomToken: input.roomToken,
      botActorId,
      messageId: '41',
      referenceId: input.referenceId,
    },
    later,
  );
}

describe('Actual update Talk store', () => {
  it('persists one ordinary delivery and enforces exact replay across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-update-talk-'));
    cleanupPaths.push(directory);
    const databasePath = join(directory, 'talk.sqlite');
    const first = new ActualUpdateTalkStore(databasePath);
    expect(first.planDelivery(plan())).toMatchObject({
      inserted: true,
      delivery: { state: 'pending', backendUrl: 'https://cloud.example.test' },
    });
    expect(first.planDelivery(plan())).toMatchObject({ inserted: false });
    expect(() =>
      first.planDelivery({ ...plan(), message: 'Different content' }),
    ).toThrow(ActualUpdateTalkStoreConflictError);
    first.close();

    const reopened = new ActualUpdateTalkStore(databasePath);
    expect(reopened.getDelivery('intent-1')).toMatchObject({
      state: 'pending',
      message: 'Please approve this update.',
    });
    reopened.close();
  });

  it('retries a failed lease and completes one immutable parent identity', () => {
    const store = new ActualUpdateTalkStore(':memory:', {
      leaseDurationMs: 1_000,
    });
    store.planDelivery(plan());
    const first = store.claimDelivery('intent-1', instant);
    expect(first).toMatchObject({ state: 'delivering' });
    if (first === undefined) {
      throw new Error('Synthetic Talk delivery was not claimed');
    }
    store.retryDelivery('intent-1', first.leaseToken, 'network-error', later);
    expect(store.claimDelivery('intent-1', instant)).toBeUndefined();
    const second = store.claimDelivery('intent-1', later);
    if (second === undefined) {
      throw new Error('Synthetic Talk retry was not claimed');
    }
    const delivered = store.completeDelivery(
      'intent-1',
      second.leaseToken,
      {
        roomToken: 'finance-room',
        botActorId,
        messageId: '41',
        referenceId: digest('c'),
      },
      later,
    );
    expect(delivered).toMatchObject({ state: 'delivered', botMessageId: '41' });
    expect(
      store.findDeliveredParent({
        roomToken: 'finance-room',
        botActorId,
        botMessageId: '41',
      }),
    ).toEqual(delivered);
    store.close();
  });

  it('durably plans one automatic approval and one standalone terminal outcome', () => {
    const store = new ActualUpdateTalkStore(':memory:');
    const approval = store.planAutoApproval({
      intentId: 'intent-1',
      actorId: 'household-finance-automation',
      approvedAt: instant,
    });
    expect(
      store.planAutoApproval({
        intentId: 'intent-1',
        actorId: 'household-finance-automation',
        approvedAt: later,
      }),
    ).toEqual(approval);

    const outcome = store.planAutoOutcomeDelivery({
      ...plan(),
      outcomeStatus: 'applied',
      message: 'Done.',
      createdAt: later,
    });
    expect(outcome).toMatchObject({
      inserted: true,
      delivery: { state: 'pending' },
    });
    expect(store.getAutoOutcomeStatus('intent-1')).toBe('applied');
    expect(
      store.planAutoOutcomeDelivery({
        ...plan(),
        outcomeStatus: 'applied',
        message: 'Done.',
        createdAt: later,
      }),
    ).toMatchObject({ inserted: false });
    store.close();
  });

  it('binds an explicit outcome and inbound action to the delivered parent', () => {
    const store = new ActualUpdateTalkStore(':memory:');
    const parent = completeParent(store);
    const planned = store.planOutcomeDelivery({
      intentId: 'intent-1',
      outcomeStatus: 'applied',
      deliveryIdempotencyKey: digest('d'),
      referenceId: digest('e'),
      message: 'Done.',
      createdAt: later,
    });
    expect(planned.delivery.state).toBe('pending');
    const claim = store.claimOutcomeDelivery('intent-1', later);
    if (claim === undefined) {
      throw new Error('Synthetic outcome was not claimable');
    }
    if (parent.botMessageId === null) {
      throw new Error('Synthetic approval parent has no message ID');
    }
    expect(claim).toMatchObject({
      roomToken: parent.roomToken,
      replyTo: parent.botMessageId,
    });
    const delivered = store.completeOutcomeDelivery(
      'intent-1',
      claim.leaseToken,
      {
        roomToken: parent.roomToken,
        botActorId,
        messageId: '42',
        referenceId: digest('e'),
        replyTo: parent.botMessageId,
      },
      later,
    );
    expect(delivered.state).toBe('delivered');

    const action = store.recordInboundAction({
      idempotencyKey: digest('f'),
      intentId: 'intent-1',
      action: 'undo',
      actorId: 'alex',
      roomToken: parent.roomToken,
      botActorId,
      botMessageId: '42',
      parentMessageSha256: delivered.messageSha256,
      occurredAt: later,
    });
    expect(action).toMatchObject({
      inserted: true,
      action: { action: 'undo' },
    });
    expect(
      store.recordInboundAction({
        idempotencyKey: digest('f'),
        intentId: 'intent-1',
        action: 'undo',
        actorId: 'alex',
        roomToken: parent.roomToken,
        botActorId,
        botMessageId: '42',
        parentMessageSha256: delivered.messageSha256,
        occurredAt: later,
      }),
    ).toMatchObject({ inserted: false });
    store.close();
  });
});
