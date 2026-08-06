import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureActualTransactionObservation,
  createActualUpdateUndoIntent,
  type ActualUpdateTransactionRecord,
} from '../../src/actual-update/index.js';
import { ActualUpdateEnvelopeAuthenticator } from '../../src/actual-update/workflow.js';
import {
  ActualUpdateIntentStore,
  actualUpdatePublicProposalSchema,
  type ActualUpdateInternalEnvelopePayloadV2,
} from '../../src/storage/actual-update-store.js';

const firstInstant = '2026-07-28T12:00:00.000Z';
const secondInstant = '2026-07-28T12:00:01.000Z';
const expiredInstant = '2026-07-28T12:00:03.000Z';
const key = 'test-only-authentication-key-material-32-bytes-minimum';

function record(
  overrides: Partial<ActualUpdateTransactionRecord> = {},
): ActualUpdateTransactionRecord {
  return {
    id: 'raw-actual-transaction-id',
    account: 'raw-actual-account-id',
    date: '2026-07-28',
    amount: -1_000,
    category: 'raw-actual-category-old',
    payee: 'raw-actual-payee-old',
    notes: 'before',
    imported_id: 'raw-bank-import-id',
    imported_payee: 'Synthetic Store',
    cleared: true,
    reconciled: false,
    transfer_id: null,
    starting_balance_flag: false,
    is_parent: false,
    is_child: false,
    parent_id: null,
    tombstone: false,
    error: null,
    subtransactions: [],
    ...overrides,
  };
}

function authenticator(): ActualUpdateEnvelopeAuthenticator {
  return new ActualUpdateEnvelopeAuthenticator({
    activeKeyId: 'update-key-1',
    keys: { 'update-key-1': key },
    targetReferenceKey: key,
  });
}

function payload(
  auth: ActualUpdateEnvelopeAuthenticator,
): ActualUpdateInternalEnvelopePayloadV2 {
  const observed = captureActualTransactionObservation(record());
  return {
    schemaVersion: 'actual-update-internal-payload.v2',
    publicProposal: {
      schemaVersion: 'actual-update-public-proposal.v2',
      intentId: 'intent-1',
      idempotencyKey: 'update-idempotency-1',
      targetRef: auth.createTargetRef({
        transactionId: observed.transactionId,
        importedId: observed.importedId ?? '',
      }),
      accountAlias: 'daily-chequing',
      summary: {
        date: '2026-07-28',
        amountMinorUnits: -1_000,
        payeeName: 'Synthetic Store',
      },
      payee: { kind: 'preserve' },
      notes: { kind: 'set', value: 'after' },
      categorization: {
        kind: 'single',
        categoryAlias: 'groceries',
      },
      sourceId: 'receipt-source-1',
      auditId: 'audit-source-1',
      createdAt: firstInstant,
    },
    writerRequest: {
      idempotencyKey: 'update-idempotency-1',
      observed,
      edit: {
        payee: { kind: 'preserve' },
        notes: { kind: 'set', value: 'after' },
        categorization: {
          kind: 'single',
          categoryId: 'raw-actual-category-new',
        },
      },
    },
  };
}

function competingPayload(
  input: ActualUpdateInternalEnvelopePayloadV2,
  suffix = '2',
  createdAt = secondInstant,
): ActualUpdateInternalEnvelopePayloadV2 {
  const idempotencyKey = `update-idempotency-${suffix}`;
  return {
    ...structuredClone(input),
    publicProposal: {
      ...input.publicProposal,
      intentId: `intent-${suffix}`,
      idempotencyKey,
      sourceId: `receipt-source-${suffix}`,
      auditId: `audit-source-${suffix}`,
      createdAt,
    },
    writerRequest: {
      ...input.writerRequest,
      idempotencyKey,
    },
  };
}

function appliedResult(input: ActualUpdateInternalEnvelopePayloadV2) {
  const applied = captureActualTransactionObservation(
    record({
      category: 'raw-actual-category-new',
      notes: 'after',
    }),
  );
  return {
    status: 'updated' as const,
    applied,
    undoIntent: createActualUpdateUndoIntent({
      idempotencyKey: input.writerRequest.idempotencyKey,
      original: input.writerRequest.observed,
      expectedApplied: applied,
      createdAt: secondInstant,
    }),
  };
}

function persistAppliedIntent(
  store: ActualUpdateIntentStore,
  auth: ActualUpdateEnvelopeAuthenticator,
  input: ActualUpdateInternalEnvelopePayloadV2,
  decisionId: string,
): void {
  store.createSealedIntent(auth.seal(input));
  store.approve({
    intentId: input.publicProposal.intentId,
    decisionId,
    actorId: 'alex',
    approvedAt: secondInstant,
  });
  const claim = store.claimNextApply(secondInstant);
  if (claim === undefined) {
    throw new Error('Synthetic apply claim was not created');
  }
  store.markApplyApplying(claim.intentId, claim.leaseToken, secondInstant);
  store.completeApply(
    claim.intentId,
    claim.leaseToken,
    appliedResult(input),
    secondInstant,
  );
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('Actual update durable intent store', () => {
  it('requires a strict review summary', () => {
    const auth = authenticator();
    const proposal = payload(auth).publicProposal;
    expect(
      actualUpdatePublicProposalSchema.parse({
        ...proposal,
      }).summary,
    ).toEqual({
      date: '2026-07-28',
      amountMinorUnits: -1_000,
      payeeName: 'Synthetic Store',
    });
    expect(() =>
      actualUpdatePublicProposalSchema.parse({
        ...proposal,
        summary: {
          date: '2026-07-28',
          amountMinorUnits: 0,
          payeeName: ' Synthetic Store',
          rawTransactionId: 'must-not-be-accepted',
        },
      }),
    ).toThrow();
    expect(() =>
      actualUpdatePublicProposalSchema.parse({
        ...proposal,
        summary: undefined,
      }),
    ).toThrow();
    auth.destroy();
  });

  it('keeps bot-facing intent data alias-only and records an approval', () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:');
    const input = payload(auth);

    const created = store.createSealedIntent(auth.seal(input));

    expect(created).toMatchObject({
      inserted: true,
      intent: {
        status: 'awaiting-approval',
        proposal: {
          targetRef: expect.stringMatching(/^actual-target\/[a-f0-9]{64}$/),
          accountAlias: 'daily-chequing',
          categorization: { categoryAlias: 'groceries' },
        },
      },
    });
    const publicJson = JSON.stringify(created.intent);
    expect(publicJson).not.toContain('raw-actual-transaction-id');
    expect(publicJson).not.toContain('raw-bank-import-id');
    expect(publicJson).not.toContain('raw-actual-category-new');
    expect(store.listPublicIntentsByStatus('awaiting-approval', 1)).toEqual([
      created.intent,
    ]);
    expect(store.listPublicIntentsByStatus('queued', 1)).toEqual([]);
    expect(
      store.approve({
        intentId: 'intent-1',
        decisionId: 'approval-1',
        actorId: 'alex',
        approvedAt: secondInstant,
      }).intent,
    ).toMatchObject({
      status: 'queued',
      approval: {
        decision: 'approved',
      },
    });
    expect(store.listPublicIntentsByStatus('awaiting-approval', 1)).toEqual([]);
    expect(store.listPublicIntentsByStatus('queued', 1)).toHaveLength(1);
    store.close();
    auth.destroy();
  });

  it('preserves exact replay but locks one target through the apply boundary', () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:');
    const input = payload(auth);
    const sealed = auth.seal(input);
    const competing = auth.seal(competingPayload(input));

    store.createSealedIntent(sealed);
    expect(store.createSealedIntent(sealed)).toMatchObject({
      inserted: false,
      intent: { status: 'awaiting-approval' },
    });
    const expectTargetLocked = () =>
      expect(() => store.createSealedIntent(competing)).toThrowError(
        'Another update for this transaction is still in progress',
      );

    expectTargetLocked();
    store.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    expectTargetLocked();
    const claim = store.claimNextApply(secondInstant);
    if (claim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    expectTargetLocked();
    store.markApplyApplying(claim.intentId, claim.leaseToken, secondInstant);
    expectTargetLocked();

    store.completeApply(
      claim.intentId,
      claim.leaseToken,
      appliedResult(input),
      secondInstant,
    );
    expect(store.createSealedIntent(competing)).toMatchObject({
      inserted: true,
      intent: { status: 'awaiting-approval' },
    });
    expect(() =>
      store.requestUndo({
        intentId: 'intent-1',
        requestId: 'undo-request-1',
        actorId: 'alex',
        requestedAt: secondInstant,
      }),
    ).toThrowError('Another update for this transaction is still in progress');
    store.close();
    auth.destroy();
  });

  it('keeps the target locked while an undo is active', () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:');
    const input = payload(auth);
    const competing = auth.seal(competingPayload(input));
    store.createSealedIntent(auth.seal(input));
    store.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    const claim = store.claimNextApply(secondInstant);
    if (claim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    store.markApplyApplying(claim.intentId, claim.leaseToken, secondInstant);
    store.completeApply(
      claim.intentId,
      claim.leaseToken,
      appliedResult(input),
      secondInstant,
    );
    store.requestUndo({
      intentId: 'intent-1',
      requestId: 'undo-request-1',
      actorId: 'alex',
      requestedAt: secondInstant,
    });

    const expectTargetLocked = () =>
      expect(() => store.createSealedIntent(competing)).toThrowError(
        'Another update for this transaction is still in progress',
      );
    expectTargetLocked();
    const undoClaim = store.claimNextUndo(secondInstant);
    if (undoClaim === undefined) {
      throw new Error('Synthetic undo claim was not created');
    }
    expectTargetLocked();
    store.markUndoApplying(
      undoClaim.intentId,
      undoClaim.leaseToken,
      secondInstant,
    );
    expectTargetLocked();
    store.completeUndo(
      undoClaim.intentId,
      undoClaim.leaseToken,
      {
        status: 'undone',
        restored: input.writerRequest.observed,
      },
      secondInstant,
    );
    expect(store.createSealedIntent(competing).inserted).toBe(true);
    store.close();
    auth.destroy();
  });

  it('blocks an older undo after a later same-target apply or undo failure', () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:');
    const first = payload(auth);
    const later = competingPayload(first, '2', firstInstant);
    persistAppliedIntent(store, auth, first, 'approval-1');
    persistAppliedIntent(store, auth, later, 'approval-2');

    const undoFirst = () =>
      store.requestUndo({
        intentId: 'intent-1',
        requestId: 'undo-request-1',
        actorId: 'alex',
        requestedAt: secondInstant,
      });
    expect(undoFirst).toThrowError(
      'A later update for this transaction prevents undoing this one',
    );

    store.requestUndo({
      intentId: 'intent-2',
      requestId: 'undo-request-2',
      actorId: 'alex',
      requestedAt: secondInstant,
    });
    const undoClaim = store.claimNextUndo(secondInstant);
    if (undoClaim === undefined) {
      throw new Error('Synthetic undo claim was not created');
    }
    store.failUndo(
      undoClaim.intentId,
      undoClaim.leaseToken,
      'undo-write-failed',
      secondInstant,
    );
    expect(undoFirst).toThrowError(
      'A later update for this transaction prevents undoing this one',
    );
    store.close();
    auth.destroy();
  });

  it('ignores later rejected, failed, or fully undone same-target attempts for undo order', () => {
    const auth = authenticator();
    const first = payload(auth);
    const later = competingPayload(first, '2', firstInstant);

    const rejectedStore = new ActualUpdateIntentStore(':memory:');
    persistAppliedIntent(rejectedStore, auth, first, 'approval-1');
    rejectedStore.createSealedIntent(auth.seal(later));
    rejectedStore.reject({
      intentId: 'intent-2',
      decisionId: 'rejection-2',
      actorId: 'alex',
      reasonCode: 'not-approved',
      rejectedAt: secondInstant,
    });
    expect(
      rejectedStore.requestUndo({
        intentId: 'intent-1',
        requestId: 'undo-request-1',
        actorId: 'alex',
        requestedAt: secondInstant,
      }).outcome,
    ).toBe('recorded');
    rejectedStore.close();

    const failedStore = new ActualUpdateIntentStore(':memory:');
    persistAppliedIntent(failedStore, auth, first, 'approval-1');
    failedStore.createSealedIntent(auth.seal(later));
    failedStore.approve({
      intentId: 'intent-2',
      decisionId: 'approval-2',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    const failedClaim = failedStore.claimNextApply(secondInstant);
    if (failedClaim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    failedStore.failApply(
      failedClaim.intentId,
      failedClaim.leaseToken,
      'write-failed',
      secondInstant,
    );
    expect(
      failedStore.requestUndo({
        intentId: 'intent-1',
        requestId: 'undo-request-1',
        actorId: 'alex',
        requestedAt: secondInstant,
      }).outcome,
    ).toBe('recorded');
    failedStore.close();

    const undoneStore = new ActualUpdateIntentStore(':memory:');
    persistAppliedIntent(undoneStore, auth, first, 'approval-1');
    persistAppliedIntent(undoneStore, auth, later, 'approval-2');
    undoneStore.requestUndo({
      intentId: 'intent-2',
      requestId: 'undo-request-2',
      actorId: 'alex',
      requestedAt: secondInstant,
    });
    const undoClaim = undoneStore.claimNextUndo(secondInstant);
    if (undoClaim === undefined) {
      throw new Error('Synthetic undo claim was not created');
    }
    undoneStore.markUndoApplying(
      undoClaim.intentId,
      undoClaim.leaseToken,
      secondInstant,
    );
    undoneStore.completeUndo(
      undoClaim.intentId,
      undoClaim.leaseToken,
      {
        status: 'undone',
        restored: later.writerRequest.observed,
      },
      secondInstant,
    );
    expect(
      undoneStore.requestUndo({
        intentId: 'intent-1',
        requestId: 'undo-request-1',
        actorId: 'alex',
        requestedAt: secondInstant,
      }).outcome,
    ).toBe('recorded');
    undoneStore.close();
    auth.destroy();
  });

  it('keeps uncertain apply and undo outcomes locked for reconciliation', () => {
    const auth = authenticator();
    const applyStore = new ActualUpdateIntentStore(':memory:');
    const input = payload(auth);
    const competing = auth.seal(competingPayload(input));
    applyStore.createSealedIntent(auth.seal(input));
    applyStore.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    const applyClaim = applyStore.claimNextApply(secondInstant);
    if (applyClaim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    applyStore.markApplyApplying(
      applyClaim.intentId,
      applyClaim.leaseToken,
      secondInstant,
    );
    applyStore.markApplyAmbiguous(
      applyClaim.intentId,
      applyClaim.leaseToken,
      'readback-uncertain',
      secondInstant,
    );
    expect(() => applyStore.createSealedIntent(competing)).toThrowError(
      'Another update for this transaction is still in progress',
    );
    applyStore.close();

    const undoStore = new ActualUpdateIntentStore(':memory:');
    undoStore.createSealedIntent(auth.seal(input));
    undoStore.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    const claim = undoStore.claimNextApply(secondInstant);
    if (claim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    undoStore.markApplyApplying(
      claim.intentId,
      claim.leaseToken,
      secondInstant,
    );
    undoStore.completeApply(
      claim.intentId,
      claim.leaseToken,
      appliedResult(input),
      secondInstant,
    );
    undoStore.requestUndo({
      intentId: 'intent-1',
      requestId: 'undo-request-1',
      actorId: 'alex',
      requestedAt: secondInstant,
    });
    const undoClaim = undoStore.claimNextUndo(secondInstant);
    if (undoClaim === undefined) {
      throw new Error('Synthetic undo claim was not created');
    }
    undoStore.markUndoApplying(
      undoClaim.intentId,
      undoClaim.leaseToken,
      secondInstant,
    );
    undoStore.markUndoAmbiguous(
      undoClaim.intentId,
      undoClaim.leaseToken,
      'readback-uncertain',
      secondInstant,
    );
    expect(() => undoStore.createSealedIntent(competing)).toThrowError(
      'Another update for this transaction is still in progress',
    );
    undoStore.close();
    auth.destroy();
  });

  it('allows a fresh same-target intent after rejection or apply failure', () => {
    const auth = authenticator();
    const input = payload(auth);
    const competing = auth.seal(competingPayload(input));

    const rejectedStore = new ActualUpdateIntentStore(':memory:');
    rejectedStore.createSealedIntent(auth.seal(input));
    rejectedStore.reject({
      intentId: 'intent-1',
      decisionId: 'rejection-1',
      actorId: 'alex',
      reasonCode: 'not-approved',
      rejectedAt: secondInstant,
    });
    expect(rejectedStore.createSealedIntent(competing).inserted).toBe(true);
    rejectedStore.close();

    const failedStore = new ActualUpdateIntentStore(':memory:');
    failedStore.createSealedIntent(auth.seal(input));
    failedStore.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    const claim = failedStore.claimNextApply(secondInstant);
    if (claim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    failedStore.failApply(
      claim.intentId,
      claim.leaseToken,
      'write-failed',
      secondInstant,
    );
    expect(failedStore.createSealedIntent(competing).inserted).toBe(true);
    failedStore.close();
    auth.destroy();
  });

  it('persists exact apply/readback/undo outcomes through the leased queues', () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:', {
      leaseDurationMs: 1_000,
      retryDelaysMs: [0],
    });
    const input = payload(auth);
    const result = appliedResult(input);
    store.createSealedIntent(auth.seal(input));
    store.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });

    const claim = store.claimNextApply(secondInstant);
    expect(claim).toMatchObject({
      mode: 'apply',
      targetTransactionId: 'raw-actual-transaction-id',
      targetImportedId: 'raw-bank-import-id',
      expectedFingerprint: input.writerRequest.observed.fullFingerprint,
    });
    if (claim === undefined) {
      throw new Error('Synthetic apply claim was not created');
    }
    store.markApplyApplying(claim.intentId, claim.leaseToken, secondInstant);
    expect(
      store.completeApply(
        claim.intentId,
        claim.leaseToken,
        result,
        secondInstant,
      ),
    ).toBe('recorded');
    expect(store.getApplyOutcome('intent-1')).toEqual(result);

    expect(
      store.requestUndo({
        intentId: 'intent-1',
        requestId: 'undo-request-1',
        actorId: 'alex',
        requestedAt: secondInstant,
      }).intent.status,
    ).toBe('undo-queued');
    const undoClaim = store.claimNextUndo(secondInstant);
    if (undoClaim === undefined) {
      throw new Error('Synthetic undo claim was not created');
    }
    expect(undoClaim.undoIntent).toEqual(result.undoIntent);
    store.markUndoApplying(
      undoClaim.intentId,
      undoClaim.leaseToken,
      secondInstant,
    );
    const undoResult = {
      status: 'undone' as const,
      restored: input.writerRequest.observed,
    };
    store.completeUndo(
      undoClaim.intentId,
      undoClaim.leaseToken,
      undoResult,
      secondInstant,
    );
    expect(store.getUndoOutcome('intent-1')).toEqual(undoResult);
    expect(store.getPublicIntent('intent-1')).toMatchObject({
      status: 'undone',
      applyOutcome: { status: 'updated' },
      undoOutcome: { status: 'undone' },
    });
    expect(
      store.listAuditEvents('intent-1').map((event) => event.action),
    ).toContain('actual-update.undo-completed');
    store.close();
    auth.destroy();
  });

  it('requeues pre-boundary crashes but reconciles post-boundary crashes', () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:', {
      leaseDurationMs: 1_000,
      retryDelaysMs: [0, 0, 0],
    });
    const input = payload(auth);
    store.createSealedIntent(auth.seal(input));
    store.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });

    expect(store.claimNextApply(secondInstant)?.mode).toBe('apply');
    expect(store.recoverExpiredLeases(expiredInstant)).toEqual({
      requeuedApply: 1,
      ambiguousApply: 0,
      requeuedUndo: 0,
      ambiguousUndo: 0,
    });
    const secondClaim = store.claimNextApply(expiredInstant);
    if (secondClaim === undefined) {
      throw new Error('Recovered apply was not requeued');
    }
    store.markApplyApplying(
      secondClaim.intentId,
      secondClaim.leaseToken,
      expiredInstant,
    );
    const afterSecondLease = '2026-07-28T12:00:05.000Z';
    expect(store.recoverExpiredLeases(afterSecondLease)).toEqual({
      requeuedApply: 0,
      ambiguousApply: 1,
      requeuedUndo: 0,
      ambiguousUndo: 0,
    });
    expect(store.claimNextApply(afterSecondLease)?.mode).toBe('reconcile');
    store.close();
    auth.destroy();
  });

  it('survives process restart with immutable intent and queue state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-update-store-'));
    cleanupPaths.push(directory);
    const path = join(directory, 'updates.sqlite');
    const auth = authenticator();
    const input = payload(auth);
    const first = new ActualUpdateIntentStore(path);
    first.createSealedIntent(auth.seal(input));
    first.approve({
      intentId: 'intent-1',
      decisionId: 'approval-1',
      actorId: 'alex',
      approvedAt: secondInstant,
    });
    first.close();

    const reopened = new ActualUpdateIntentStore(path);
    expect(reopened.getPublicIntent('intent-1')).toMatchObject({
      status: 'queued',
      proposal: { sourceId: 'receipt-source-1', auditId: 'audit-source-1' },
    });
    expect(reopened.claimNextApply(secondInstant)?.mode).toBe('apply');
    reopened.close();
    auth.destroy();
  });
});
