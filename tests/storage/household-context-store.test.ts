import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from '../../src/context/profile.js';
import {
  HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES,
  HouseholdContextIdentityConflictError,
  HouseholdContextSnapshotConflictError,
  HouseholdContextStore,
} from '../../src/storage/household-context-store.js';

const requestedAt = '2026-07-28T03:00:00.000Z';
const appliedAt = '2026-07-28T03:01:00.000Z';

function mutation(
  mutationId = '11111111-1111-4111-8111-111111111111',
  messageId = '100',
  idempotencyKey = `context:${messageId}`,
) {
  return {
    idempotencyKey,
    backendUrl: 'https://cloud.example.test',
    roomToken: 'household-finance',
    mutation: {
      schemaVersion: 'household-context-mutation.v1' as const,
      mutationId,
      expectedRevision: 0,
      actorId: 'alex',
      messageId,
      requestedAt,
      operation: {
        kind: 'set-risk-policy' as const,
        policy: 'safeBudgetRiskPreference' as const,
        value: {
          value: 'conservative' as const,
          status: 'confirmed' as const,
          provenance: {
            source: 'talk-explicit' as const,
            actorId: 'alex',
            messageId,
            recordedAt: requestedAt,
          },
        },
      },
    },
  };
}

function reply(replyTo = '100', reference = 'a') {
  return {
    roomToken: 'household-finance',
    message: 'Household context was updated.',
    replyTo,
    referenceId: reference.repeat(64),
    silent: false,
  };
}

function claimApply(
  store: HouseholdContextStore,
  eventId: string,
  now = requestedAt,
) {
  const acknowledgement = store.claimNextOutbox(now);
  expect(acknowledgement).toMatchObject({
    kind: 'send-context-mutation-acknowledgement',
    eventId,
    payload: {
      replyTo: '100',
      message: 'Got it — I’m saving that household detail now.',
    },
  });
  store.completeOutbox(acknowledgement?.id ?? -1, now);
  const apply = store.claimNextOutbox(now);
  expect(apply).toMatchObject({
    kind: 'apply-context-mutation',
    eventId,
  });
  return apply;
}

function applyMutation(
  store: HouseholdContextStore,
  current: HouseholdProfile,
) {
  const recorded = store.recordMutation(mutation());
  const apply = claimApply(store, recorded.record.id);
  const prepared = store.prepareMutationApply(
    recorded.record.id,
    current,
    appliedAt,
  );
  store.completeMutationAppliedAndEnqueueResult(
    apply?.id ?? -1,
    recorded.record.id,
    reply(),
    'context-result:100',
    appliedAt,
  );
  return { recorded, prepared };
}

describe('HouseholdContextStore', () => {
  it('records one exact mutation and prioritizes its durable acknowledgement', () => {
    const store = new HouseholdContextStore(':memory:');

    const first = store.recordMutation(mutation());
    const duplicate = store.recordMutation(mutation());

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({
      inserted: false,
      record: { id: first.record.id },
    });
    expect(first.record.mutationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(store.getMutationItem(first.record.id)).toMatchObject({
      status: 'pending',
    });
    expect(store.hasPendingFirstResponse('household-finance')).toBe(true);
    const acknowledgement = store.claimNextOutbox(requestedAt);
    expect(acknowledgement).toMatchObject({
      kind: 'send-context-mutation-acknowledgement',
      eventId: first.record.id,
    });
    store.completeOutbox(acknowledgement!.id, requestedAt);
    expect(store.hasPendingFirstResponse('household-finance')).toBe(false);
    store.close();
  });

  it('rejects identity reuse with a different exact mutation', () => {
    const store = new HouseholdContextStore(':memory:');
    store.recordMutation(mutation());
    const changed = mutation('22222222-2222-4222-8222-222222222222', '100');

    expect(() => store.recordMutation(changed)).toThrowError(
      HouseholdContextIdentityConflictError,
    );
    store.close();
  });

  it('records distinct mutations from one Talk message when their durable identities differ', () => {
    const store = new HouseholdContextStore(':memory:');
    const firstInput = mutation();
    const secondInput = mutation(
      '22222222-2222-4222-8222-222222222222',
      '100',
      'context:100:second-operation',
    );

    const first = store.recordMutation(firstInput);
    const second = store.recordMutation(secondInput);

    expect(first).toMatchObject({
      inserted: true,
      record: {
        mutation: { actorId: 'alex', messageId: '100' },
      },
    });
    expect(second).toMatchObject({
      inserted: true,
      record: {
        mutation: { actorId: 'alex', messageId: '100' },
      },
    });
    expect(second.record.id).not.toBe(first.record.id);
    expect(store.getMutationItem(first.record.id)).toMatchObject({
      status: 'pending',
    });
    expect(store.getMutationItem(second.record.id)).toMatchObject({
      status: 'pending',
    });
    expect(store.recordMutation(firstInput)).toMatchObject({
      inserted: false,
      record: { id: first.record.id },
    });
    expect(store.recordMutation(secondInput)).toMatchObject({
      inserted: false,
      record: { id: second.record.id },
    });
    store.close();
  });

  it('does not expose an OCR or receipt-shaped intake API', () => {
    const store = new HouseholdContextStore(':memory:');
    expect(() =>
      store.recordMutation({
        ...mutation(),
        sourceDocumentId: 'receipt-1',
      } as never),
    ).toThrow();
    store.close();
  });

  it('prepares immutable exact before/after snapshots and atomically queues the result', () => {
    const store = new HouseholdContextStore(':memory:');
    const empty = createEmptyHouseholdProfile(requestedAt);
    const { recorded, prepared } = applyMutation(store, empty);

    expect(prepared).toMatchObject({
      mode: 'write',
      targetProfile: {
        revision: 1,
        updatedAt: appliedAt,
        policies: {
          safeBudgetRiskPreference: {
            value: 'conservative',
          },
        },
      },
    });
    expect(store.getMutationItem(recorded.record.id)).toMatchObject({
      status: 'applied',
      beforeSnapshot: { revision: 0 },
      afterSnapshot: { revision: 1 },
    });
    expect(store.claimNextOutbox(appliedAt)).toMatchObject({
      kind: 'send-context-mutation-result',
      eventId: recorded.record.id,
    });
    expect(
      store.listMutationAudit(recorded.record.id).map((entry) => entry.action),
    ).toEqual([
      'context.mutation-recorded',
      'context.mutation-snapshots-prepared',
      'context.mutation-applied',
    ]);
    store.close();
  });

  it('can apply a bundled merchant rule without sending a second Talk result', () => {
    const store = new HouseholdContextStore(':memory:');
    const empty = createEmptyHouseholdProfile(requestedAt);
    const recorded = store.recordMutation(mutation(), {
      enqueueAcknowledgement: false,
      enqueueResultReply: false,
    });
    const apply = store.claimNextOutbox(requestedAt);
    expect(apply).toMatchObject({
      kind: 'apply-context-mutation',
      eventId: recorded.record.id,
    });
    store.prepareMutationApply(recorded.record.id, empty, appliedAt);
    store.completeMutationAppliedAndEnqueueResult(
      apply?.id ?? -1,
      recorded.record.id,
      reply(),
      'context-result:100',
      appliedAt,
    );

    expect(recorded.record.resultReplyEnabled).toBe(false);
    expect(store.getMutationItem(recorded.record.id)).toMatchObject({
      status: 'applied',
    });
    expect(store.claimNextOutbox(appliedAt)).toBeUndefined();
    store.close();
  });

  it('recovers a crash after the external write without proposing a second write', () => {
    const store = new HouseholdContextStore(':memory:');
    const empty = createEmptyHouseholdProfile(requestedAt);
    const recorded = store.recordMutation(mutation());
    claimApply(store, recorded.record.id);
    const first = store.prepareMutationApply(
      recorded.record.id,
      empty,
      appliedAt,
    );

    expect(store.recoverInterruptedOutbox(appliedAt)).toBe(1);
    expect(store.claimNextOutbox(appliedAt)).toMatchObject({
      kind: 'apply-context-mutation',
      attemptCount: 2,
    });
    expect(
      store.prepareMutationApply(
        recorded.record.id,
        first.targetProfile,
        appliedAt,
      ),
    ).toMatchObject({ mode: 'already-applied' });
    store.close();
  });

  it('fails closed when prepared context changed before retry', () => {
    const store = new HouseholdContextStore(':memory:');
    const empty = createEmptyHouseholdProfile(requestedAt);
    const recorded = store.recordMutation(mutation());
    claimApply(store, recorded.record.id);
    store.prepareMutationApply(recorded.record.id, empty, appliedAt);
    store.retryOutbox(
      2,
      'temporary-webdav-failure',
      '2026-07-28T03:02:00.000Z',
    );
    store.claimNextOutbox('2026-07-28T03:02:00.000Z');
    const changed = {
      ...empty,
      revision: 1,
      updatedAt: '2026-07-28T03:01:30.000Z',
    };

    expect(() =>
      store.prepareMutationApply(
        recorded.record.id,
        changed,
        '2026-07-28T03:02:00.000Z',
      ),
    ).toThrowError(HouseholdContextSnapshotConflictError);
    store.close();
  });

  it('atomically records a revision conflict and queues its Talk result', () => {
    const store = new HouseholdContextStore(':memory:');
    const recorded = store.recordMutation(mutation());
    const apply = claimApply(store, recorded.record.id);

    store.completeMutationConflictAndEnqueueResult(
      apply?.id ?? -1,
      recorded.record.id,
      1,
      {
        ...reply(),
        message:
          'That context changed before I could apply the update, so I left it unchanged.',
      },
      'context-result:conflict',
      appliedAt,
    );

    expect(store.getMutationItem(recorded.record.id)).toMatchObject({
      status: 'conflict',
      observedRevision: 1,
      errorCode: 'revision-conflict',
    });
    expect(store.claimNextOutbox(appliedAt)).toMatchObject({
      kind: 'send-context-mutation-result',
      eventId: recorded.record.id,
    });
    store.close();
  });

  it('records a separate undo intent and restores its unchanged target', () => {
    const store = new HouseholdContextStore(':memory:');
    const empty = createEmptyHouseholdProfile(requestedAt);
    const { recorded, prepared } = applyMutation(store, empty);
    expect(store.findLatestUndoableMutation('household-finance')).toMatchObject(
      {
        id: recorded.record.id,
      },
    );
    expect(
      store.latestAppliedMutationAtOrBefore(
        'household-finance',
        '2026-07-28T03:01:30.000Z',
      ),
    ).toMatchObject({ id: recorded.record.id });
    expect(
      store.latestAppliedMutationAtOrBefore(
        'another-room',
        '2026-07-28T03:01:30.000Z',
      ),
    ).toBeUndefined();
    const undo = store.recordUndoIntent({
      idempotencyKey: 'context-undo:200',
      originalEventId: recorded.record.id,
      actorId: 'alex',
      messageId: '200',
      requestedAt: '2026-07-28T03:02:00.000Z',
    });
    expect(
      store.findLatestUndoableMutation('household-finance'),
    ).toBeUndefined();
    const duplicate = store.recordUndoIntent({
      idempotencyKey: 'context-undo:200',
      originalEventId: recorded.record.id,
      actorId: 'alex',
      messageId: '200',
      requestedAt: '2026-07-28T03:02:00.000Z',
    });
    expect(duplicate).toMatchObject({
      inserted: false,
      intent: { id: undo.intent.id },
    });

    const pendingResult = store.claimNextOutbox('2026-07-28T03:02:00.000Z');
    expect(pendingResult).toMatchObject({
      kind: 'send-context-undo-acknowledgement',
      payload: {
        message: 'Got it — I’m checking the latest saved household change now.',
      },
    });
    store.completeOutbox(pendingResult?.id ?? -1, '2026-07-28T03:02:00.000Z');
    const undoApply = store.claimNextOutbox('2026-07-28T03:02:00.000Z');
    expect(undoApply).toMatchObject({
      kind: 'apply-context-undo',
      undoIntentId: undo.intent.id,
    });
    const restored = store.prepareUndoApply(
      undo.intent.id,
      prepared.targetProfile,
      '2026-07-28T03:03:00.000Z',
    );
    expect(restored).toMatchObject({
      mode: 'write',
      targetProfile: {
        revision: 2,
        updatedAt: '2026-07-28T03:03:00.000Z',
        policies: {},
      },
    });
    store.completeUndoAppliedAndEnqueueResult(
      undoApply?.id ?? -1,
      undo.intent.id,
      reply('200', 'b'),
      'context-undo-result:200',
      '2026-07-28T03:03:00.000Z',
    );
    expect(store.getUndoIntent(undo.intent.id)).toMatchObject({
      status: 'applied',
      expectedSnapshot: { revision: 1 },
      priorSnapshot: { revision: 0 },
      targetSnapshot: { revision: 2 },
    });
    store.close();
  });

  it('rejects undo when the targeted household detail changed afterward', () => {
    const store = new HouseholdContextStore(':memory:');
    const empty = createEmptyHouseholdProfile(requestedAt);
    const { recorded, prepared } = applyMutation(store, empty);
    const originalResult = store.claimNextOutbox(appliedAt);
    expect(originalResult?.kind).toBe('send-context-mutation-result');
    store.completeOutbox(originalResult?.id ?? -1, appliedAt);
    const undo = store.recordUndoIntent({
      idempotencyKey: 'context-undo:200',
      originalEventId: recorded.record.id,
      actorId: 'alex',
      messageId: '200',
      requestedAt: '2026-07-28T03:02:00.000Z',
    });
    const undoAcknowledgement = store.claimNextOutbox(
      '2026-07-28T03:02:00.000Z',
    );
    store.completeOutbox(
      undoAcknowledgement?.id ?? -1,
      '2026-07-28T03:02:00.000Z',
    );
    store.claimNextOutbox('2026-07-28T03:02:00.000Z');
    const intervening = structuredClone(prepared.targetProfile);
    intervening.revision = 2;
    intervening.updatedAt = '2026-07-28T03:02:30.000Z';
    intervening.policies.safeBudgetRiskPreference!.value = 'flexible';

    expect(() =>
      store.prepareUndoApply(
        undo.intent.id,
        intervening,
        '2026-07-28T03:03:00.000Z',
      ),
    ).toThrowError(HouseholdContextSnapshotConflictError);
    store.close();
  });

  it('persists and recovers claimed work across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-store-test-'));
    const databasePath = join(directory, 'context.sqlite');
    try {
      const first = new HouseholdContextStore(databasePath);
      const recorded = first.recordMutation(mutation());
      const acknowledgement = first.claimNextOutbox(requestedAt);
      first.completeOutbox(acknowledgement?.id ?? -1, requestedAt);
      first.claimNextOutbox(requestedAt);
      first.close();

      const restarted = new HouseholdContextStore(databasePath);
      expect(restarted.recoverInterruptedOutbox(appliedAt)).toBe(1);
      expect(restarted.claimNextOutbox(appliedAt)).toMatchObject({
        kind: 'apply-context-mutation',
        eventId: recorded.record.id,
        attemptCount: 2,
      });
      expect(restarted.recordMutation(mutation())).toMatchObject({
        inserted: false,
        record: { id: recorded.record.id },
      });
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enforces the documented snapshot byte bound', () => {
    expect(HOUSEHOLD_CONTEXT_SNAPSHOT_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
