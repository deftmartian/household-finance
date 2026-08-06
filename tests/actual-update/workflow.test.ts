import { describe, expect, it, vi } from 'vitest';

import {
  ActualUpdateOutcomeUnknownError,
  captureActualTransactionObservation,
  createActualUpdateUndoIntent,
  type ActualUpdateTransactionRecord,
} from '../../src/actual-update/index.js';
import {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateWorkflow,
  type SafeActualUpdateWriter,
} from '../../src/actual-update/workflow.js';
import {
  ActualUpdateIntentStore,
  type ActualUpdateInternalEnvelopePayloadV2,
} from '../../src/storage/actual-update-store.js';

const instant = '2026-07-28T12:00:00.000Z';
const key = 'test-only-authentication-key-material-32-bytes-minimum';

function record(
  overrides: Partial<ActualUpdateTransactionRecord> = {},
): ActualUpdateTransactionRecord {
  return {
    id: 'transaction-internal-1',
    account: 'account-internal-1',
    date: '2026-07-28',
    amount: -2_000,
    category: 'category-internal-old',
    payee: 'payee-internal-old',
    notes: null,
    imported_id: 'import-internal-1',
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
    activeKeyId: 'key-1',
    keys: { 'key-1': key },
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
      idempotencyKey: 'intent-idempotency-1',
      targetRef: auth.createTargetRef({
        transactionId: observed.transactionId,
        importedId: observed.importedId ?? '',
      }),
      accountAlias: 'mastercard',
      summary: {
        date: '2026-07-28',
        amountMinorUnits: -2_000,
        payeeName: 'Synthetic Store',
      },
      payee: { kind: 'preserve' },
      notes: { kind: 'preserve' },
      categorization: {
        kind: 'single',
        categoryAlias: 'household',
      },
      sourceId: 'receipt-1',
      auditId: 'audit-1',
      createdAt: instant,
    },
    writerRequest: {
      idempotencyKey: 'intent-idempotency-1',
      observed,
      edit: {
        payee: { kind: 'preserve' },
        notes: { kind: 'preserve' },
        categorization: {
          kind: 'single',
          categoryId: 'category-internal-new',
        },
      },
    },
  };
}

function updateResult(input: ActualUpdateInternalEnvelopePayloadV2) {
  const applied = captureActualTransactionObservation(
    record({ category: 'category-internal-new' }),
  );
  return {
    status: 'updated' as const,
    applied,
    undoIntent: createActualUpdateUndoIntent({
      idempotencyKey: input.writerRequest.idempotencyKey,
      original: input.writerRequest.observed,
      expectedApplied: applied,
      createdAt: instant,
    }),
  };
}

function approve(workflow: ActualUpdateWorkflow): void {
  workflow.approve({
    intentId: 'intent-1',
    decisionId: 'approval-1',
    actorId: 'alex',
    approvedAt: instant,
  });
}

describe('authenticated Actual update workflow', () => {
  it('executes approved apply and undo only through the safe writer', async () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:', {
      retryDelaysMs: [0],
    });
    const input = payload(auth);
    const updated = updateResult(input);
    const safeWriter: SafeActualUpdateWriter = {
      update: vi.fn(async () => updated),
      undo: vi.fn<SafeActualUpdateWriter['undo']>(async () => ({
        status: 'undone',
        restored: input.writerRequest.observed,
      })),
    };
    const workflow = new ActualUpdateWorkflow({
      store,
      writer: safeWriter,
      authenticator: auth,
      now: () => new Date(instant),
    });
    workflow.enqueue(input);
    approve(workflow);

    await expect(workflow.processNextApply()).resolves.toMatchObject({
      status: 'applied',
      resultStatus: 'updated',
      reconciliation: false,
    });
    expect(safeWriter.update).toHaveBeenCalledWith(input.writerRequest);
    workflow.requestUndo({
      intentId: 'intent-1',
      requestId: 'undo-1',
      actorId: 'alex',
      requestedAt: instant,
    });
    await expect(workflow.processNextUndo()).resolves.toMatchObject({
      status: 'undone',
      resultStatus: 'undone',
      reconciliation: false,
    });
    expect(safeWriter.undo).toHaveBeenCalledWith(updated.undoIntent);
    expect(store.getPublicIntent('intent-1')?.status).toBe('undone');
    store.close();
    auth.destroy();
  });

  it('reconciles outcome-unknown through the same idempotent safe writer', async () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:', {
      retryDelaysMs: [0, 0],
    });
    const input = payload(auth);
    const updated = updateResult(input);
    const update = vi
      .fn<SafeActualUpdateWriter['update']>()
      .mockRejectedValueOnce(
        new ActualUpdateOutcomeUnknownError(
          input.writerRequest.observed.transactionId,
          'synthetic lost response',
        ),
      )
      .mockResolvedValueOnce({ ...updated, status: 'already-applied' });
    const safeWriter: SafeActualUpdateWriter = {
      update,
      undo: vi.fn(),
    };
    const workflow = new ActualUpdateWorkflow({
      store,
      writer: safeWriter,
      authenticator: auth,
      now: () => new Date(instant),
    });
    workflow.enqueue(input);
    approve(workflow);

    await expect(workflow.processNextApply()).resolves.toMatchObject({
      status: 'ambiguous',
      errorCode: 'actual-outcome-unknown',
    });
    expect(store.getPublicIntent('intent-1')?.status).toBe('ambiguous');
    await expect(workflow.processNextApply()).resolves.toMatchObject({
      status: 'applied',
      resultStatus: 'already-applied',
      reconciliation: true,
    });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(2, input.writerRequest);
    store.close();
    auth.destroy();
  });

  it('rejects a forged durable envelope before the writer boundary', async () => {
    const auth = authenticator();
    const store = new ActualUpdateIntentStore(':memory:');
    const input = payload(auth);
    const forged = {
      ...auth.seal(input),
      signatureSha256: '0'.repeat(64),
    };
    store.createSealedIntent(forged);
    const safeWriter: SafeActualUpdateWriter = {
      update: vi.fn(),
      undo: vi.fn(),
    };
    const workflow = new ActualUpdateWorkflow({
      store,
      writer: safeWriter,
      authenticator: auth,
      now: () => new Date(instant),
    });
    approve(workflow);

    await expect(workflow.processNextApply()).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'invalid-authenticated-envelope',
    });
    expect(safeWriter.update).not.toHaveBeenCalled();
    expect(store.getPublicIntent('intent-1')).toMatchObject({
      status: 'failed',
      lastErrorCode: 'invalid-authenticated-envelope',
    });
    store.close();
    auth.destroy();
  });

  it('authenticates payloads canonically and produces opaque target refs', () => {
    const auth = authenticator();
    const input = payload(auth);
    const envelope = auth.seal(input);

    expect(auth.verify(envelope)).toEqual(input);
    expect(input.publicProposal.targetRef).not.toContain(
      input.writerRequest.observed.transactionId,
    );
    expect(() =>
      auth.verify({
        ...envelope,
        payload: {
          ...envelope.payload,
          publicProposal: {
            ...envelope.payload.publicProposal,
            accountAlias: 'tampered',
          },
        },
      }),
    ).toThrow('authentication failed');
    expect(() =>
      auth.seal({
        ...input,
        publicProposal: {
          ...input.publicProposal,
          accountAlias: input.writerRequest.observed.accountId,
        },
      }),
    ).toThrow('raw Actual identifier');
    auth.destroy();
  });

  it('retains old envelopes and stable target refs across signing-key rotation', () => {
    const oldSigningKey =
      'test-only-old-signing-key-material-at-least-32-bytes';
    const newSigningKey =
      'test-only-new-signing-key-material-at-least-32-bytes';
    const targetReferenceKey =
      'test-only-stable-target-reference-material-32-bytes';
    const oldAuth = new ActualUpdateEnvelopeAuthenticator({
      activeKeyId: 'key-1',
      keys: { 'key-1': oldSigningKey },
      targetReferenceKey,
    });
    const input = payload(oldAuth);
    const oldEnvelope = oldAuth.seal(input);
    const rotatedAuth = new ActualUpdateEnvelopeAuthenticator({
      activeKeyId: 'key-2',
      keys: {
        'key-1': oldSigningKey,
        'key-2': newSigningKey,
      },
      targetReferenceKey,
    });

    expect(
      rotatedAuth.createTargetRef({
        transactionId: input.writerRequest.observed.transactionId,
        importedId: input.writerRequest.observed.importedId ?? '',
      }),
    ).toBe(input.publicProposal.targetRef);
    expect(rotatedAuth.verify(oldEnvelope)).toEqual(input);
    expect(rotatedAuth.seal(input).keyId).toBe('key-2');

    oldAuth.destroy();
    expect(() =>
      oldAuth.createTargetRef({
        transactionId: input.writerRequest.observed.transactionId,
        importedId: input.writerRequest.observed.importedId ?? '',
      }),
    ).toThrow(/destroyed/);
    rotatedAuth.destroy();
  });
});
