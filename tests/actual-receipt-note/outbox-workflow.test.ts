import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ActualReceiptNoteWriter,
  ReceiptNoteEnvelopeAuthenticationError,
  ReceiptNoteEnvelopeAuthenticator,
  ReceiptNoteOutboxConflictError,
  ReceiptNoteOutboxStore,
  ReceiptNoteReconciler,
  ReceiptNoteWorkflow,
  createReceiptNoteUpsertPayload,
} from '../../src/actual-receipt-note/index.js';
import type { HouseholdFinanceReceiptRecordV1 } from '../../src/receipt-record/index.js';

const receiptId = '22222222-2222-4222-8222-222222222222';
const t0 = '2026-07-29T12:00:00.000Z';

function receipt(
  revision = 1,
  updatedAt = t0,
): HouseholdFinanceReceiptRecordV1 {
  return {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId,
    revision,
    status: 'active',
    createdAt: t0,
    updatedAt,
    sources: [
      {
        nextcloudFileId: 'synthetic-file',
        archivePath: 'Receipts/synthetic.png',
        sha256: 'b'.repeat(64),
        mediaType: 'image/png',
        receivedAt: t0,
        talk: {
          roomToken: 'household-finance',
          actorId: 'alex',
          messageId: '101',
        },
      },
    ],
    merchant: 'Synthetic Store',
    purchaseDate: '2026-07-29',
    purchaseTime: null,
    timezoneOffset: null,
    currency: 'CAD',
    amounts: {
      subtotalMinor: 500,
      taxMinor: 75,
      discountMinor: 0,
      tipMinor: 0,
      totalMinor: 575,
    },
    paymentEvidence: { kind: 'unknown', lastFour: null },
    receiptReference: null,
    items: [],
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-synthetic',
      resolvedModel: 'grok-synthetic',
      zeroDataRetention: true,
      extractedAt: t0,
      sourceSha256s: ['b'.repeat(64)],
    },
  };
}

function setupStore(databasePath = ':memory:', now = t0) {
  const authenticator = new ReceiptNoteEnvelopeAuthenticator({
    activeKeyId: 'production-v1',
    keys: { 'production-v1': 'k'.repeat(48) },
  });
  const store = new ReceiptNoteOutboxStore(databasePath, {
    leaseDurationMs: 1_000,
    retryDelaysMs: [0, 5_000],
  });
  const payload = createReceiptNoteUpsertPayload({
    record: receipt(),
    expectedPreviousSha256: null,
    idempotencyKey: 'receipt-note-synthetic-1',
    createdAt: now,
  });
  return { authenticator, store, payload };
}

describe('signed receipt-note outbox', () => {
  it('is idempotent, rejects identity reuse, and exposes the latest internal revision', () => {
    const { authenticator, store, payload } = setupStore();
    try {
      const envelope = authenticator.seal(payload);
      expect(store.enqueueSealed(envelope).inserted).toBe(true);
      expect(store.enqueueSealed(envelope).inserted).toBe(false);
      expect(store.getLatestInternal(receiptId)).toEqual({
        payload,
        status: 'queued',
      });
      expect(store.listLatestInternal()).toEqual([
        {
          payload,
          status: 'queued',
        },
      ]);

      const changed = {
        ...payload,
        desiredSha256: 'c'.repeat(64),
      };
      expect(() =>
        store.enqueueSealed({
          ...envelope,
          payload: changed,
        }),
      ).toThrow();
      expect(() =>
        store.enqueueSealed(
          authenticator.seal({
            ...payload,
            idempotencyKey: 'different-key',
          }),
        ),
      ).toThrow(ReceiptNoteOutboxConflictError);
    } finally {
      store.close();
      authenticator.destroy();
    }
  });

  it('rejects a tampered signed envelope', () => {
    const { authenticator, payload } = setupStore();
    try {
      const envelope = authenticator.seal(payload);
      expect(() =>
        authenticator.verify({
          ...envelope,
          signatureSha256: '0'.repeat(64),
        }),
      ).toThrow(ReceiptNoteEnvelopeAuthenticationError);
    } finally {
      authenticator.destroy();
    }
  });

  it('applies once and survives reopening the shared SQLite file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'receipt-note-outbox-'));
    const databasePath = join(directory, 'attachment-shadow.sqlite');
    const { authenticator, store, payload } = setupStore(databasePath);
    const notes = new Map<string, string>();
    const api = {
      sync: vi.fn(async () => undefined),
      getNote: vi.fn(async (id: string) => {
        const note = notes.get(id);
        return note === undefined ? null : { id, note };
      }),
      updateNote: vi.fn(async (id: string, note: string) => {
        notes.set(id, note);
      }),
    };
    try {
      store.enqueueSealed(authenticator.seal(payload));
      const workflow = new ReceiptNoteWorkflow({
        store,
        writer: new ActualReceiptNoteWriter(api),
        authenticator,
        now: () => new Date(t0),
      });
      await expect(workflow.processNext()).resolves.toMatchObject({
        status: 'applied',
        resultStatus: 'updated',
      });
      expect(store.get(receiptId, 1)?.status).toBe('applied');

      store.close();
      const reopened = new ReceiptNoteOutboxStore(databasePath);
      try {
        expect(reopened.get(receiptId, 1)).toMatchObject({
          status: 'applied',
          outcome: { status: 'updated' },
        });
      } finally {
        reopened.close();
      }
    } finally {
      authenticator.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reconciles a write whose sync outcome was initially unknown', async () => {
    const { authenticator, store, payload } = setupStore();
    const notes = new Map<string, string>();
    let syncCalls = 0;
    const api = {
      sync: vi.fn(async () => {
        syncCalls += 1;
        if (syncCalls === 2) {
          throw new Error('synthetic interrupted post-write sync');
        }
      }),
      getNote: vi.fn(async (id: string) => {
        const note = notes.get(id);
        return note === undefined ? null : { id, note };
      }),
      updateNote: vi.fn(async (id: string, note: string) => {
        notes.set(id, note);
      }),
    };
    const nowMs = Date.parse(t0);
    const now = () => new Date(nowMs);
    try {
      store.enqueueSealed(authenticator.seal(payload));
      const workflow = new ReceiptNoteWorkflow({
        store,
        writer: new ActualReceiptNoteWriter(api),
        authenticator,
        now,
      });
      const reconciler = new ReceiptNoteReconciler({
        store,
        workflow,
        now,
      });

      await expect(reconciler.runOne()).resolves.toBe(true);
      expect(store.get(receiptId, 1)).toMatchObject({
        status: 'reconcile',
        lastErrorCode: 'write-outcome-unknown',
      });

      await expect(reconciler.runOne()).resolves.toBe(true);
      expect(store.get(receiptId, 1)).toMatchObject({
        status: 'applied',
        outcome: { status: 'already-desired' },
      });
      expect(api.updateNote).toHaveBeenCalledOnce();
    } finally {
      store.close();
      authenticator.destroy();
    }
  });

  it('recovers an expired applying lease as reconciliation work', () => {
    const { authenticator, store, payload } = setupStore();
    try {
      store.enqueueSealed(authenticator.seal(payload));
      const claim = store.claimNext(t0);
      expect(claim).toBeDefined();
      store.markApplying(claim!, t0);

      expect(store.recoverExpiredLeases('2026-07-29T12:00:01.001Z')).toEqual({
        requeuedClaims: 0,
        scheduledReconciliations: 1,
      });
      expect(store.get(receiptId, 1)?.status).toBe('reconcile');
    } finally {
      store.close();
      authenticator.destroy();
    }
  });
});
