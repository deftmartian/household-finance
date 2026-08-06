import { describe, expect, it, vi } from 'vitest';

import {
  ActualReceiptNoteWriter,
  ReceiptNoteWriteOutcomeUnknownError,
  createReceiptNoteUpsertPayload,
} from '../../src/actual-receipt-note/index.js';
import {
  actualReceiptNoteId,
  canonicalHouseholdFinanceReceiptJson,
  type HouseholdFinanceReceiptRecordV1,
} from '../../src/receipt-record/index.js';

const receiptId = '11111111-1111-4111-8111-111111111111';
const instant = '2026-07-29T12:00:00.000Z';

function receipt(revision = 1): HouseholdFinanceReceiptRecordV1 {
  return {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId,
    revision,
    status: 'active',
    createdAt: instant,
    updatedAt: instant,
    sources: [
      {
        nextcloudFileId: 'synthetic-file',
        archivePath: 'Receipts/synthetic.jpg',
        sha256: 'a'.repeat(64),
        mediaType: 'image/jpeg',
        receivedAt: instant,
        talk: {
          roomToken: 'household-finance',
          actorId: 'alex',
          messageId: '101',
        },
      },
    ],
    merchant: 'Synthetic Market',
    purchaseDate: '2026-07-29',
    purchaseTime: null,
    timezoneOffset: null,
    currency: 'CAD',
    amounts: {
      subtotalMinor: 1_000,
      taxMinor: 150,
      discountMinor: 0,
      tipMinor: 0,
      totalMinor: 1_150,
    },
    paymentEvidence: { kind: 'unknown', lastFour: null },
    receiptReference: 'SYNTHETIC-1',
    items: [
      {
        description: 'Synthetic item',
        quantity: 1,
        unitPriceMinor: 1_000,
        totalMinor: 1_000,
      },
    ],
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-synthetic',
      resolvedModel: 'grok-synthetic',
      zeroDataRetention: true,
      extractedAt: instant,
      sourceSha256s: ['a'.repeat(64)],
    },
  };
}

function payload(expectedPreviousSha256: string | null = null) {
  return createReceiptNoteUpsertPayload({
    record: receipt(),
    expectedPreviousSha256,
    idempotencyKey: 'synthetic-receipt-note-1',
    createdAt: instant,
  });
}

describe('narrow Actual receipt-note writer', () => {
  it('derives the namespaced note ID and verifies exact readback', async () => {
    const events: string[] = [];
    const notes = new Map<string, string>();
    const api = {
      sync: vi.fn(async () => {
        events.push('sync');
      }),
      getNote: vi.fn(async (id: string) => {
        events.push(`get:${id}`);
        const note = notes.get(id);
        return note === undefined ? null : { id, note };
      }),
      updateNote: vi.fn(async (id: string, note: string) => {
        events.push(`update:${id}`);
        notes.set(id, note);
      }),
    };
    const beforeMutation = vi.fn(() => {
      events.push('before-mutation');
    });

    await expect(
      new ActualReceiptNoteWriter(api).upsert(payload(), beforeMutation),
    ).resolves.toMatchObject({
      status: 'updated',
      receiptId,
      noteId: actualReceiptNoteId(receiptId),
      revision: 1,
    });

    expect(events).toEqual([
      'sync',
      `get:${actualReceiptNoteId(receiptId)}`,
      'before-mutation',
      `update:${actualReceiptNoteId(receiptId)}`,
      'sync',
      `get:${actualReceiptNoteId(receiptId)}`,
    ]);
    expect(notes.get(actualReceiptNoteId(receiptId))).toBe(
      canonicalHouseholdFinanceReceiptJson(receipt()),
    );
  });

  it('treats exact desired content as applied without rewriting it', async () => {
    const note = canonicalHouseholdFinanceReceiptJson(receipt());
    const api = {
      sync: vi.fn(async () => undefined),
      getNote: vi.fn(async (id: string) => ({ id, note })),
      updateNote: vi.fn(async () => undefined),
    };
    const beforeMutation = vi.fn();

    await expect(
      new ActualReceiptNoteWriter(api).upsert(payload(), beforeMutation),
    ).resolves.toMatchObject({ status: 'already-desired' });
    expect(beforeMutation).not.toHaveBeenCalled();
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('refuses an unexpected existing note without overwriting it', async () => {
    const api = {
      sync: vi.fn(async () => undefined),
      getNote: vi.fn(async (id: string) => ({
        id,
        note: '{"unrelated":true}',
      })),
      updateNote: vi.fn(async () => undefined),
    };
    const beforeMutation = vi.fn();

    await expect(
      new ActualReceiptNoteWriter(api).upsert(payload(), beforeMutation),
    ).resolves.toMatchObject({
      status: 'ambiguous',
      reason: 'unexpected-existing-note',
    });
    expect(beforeMutation).not.toHaveBeenCalled();
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('reports any failure after mutation starts as outcome-unknown', async () => {
    const api = {
      sync: vi
        .fn<() => Promise<void>>()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('synthetic sync interruption')),
      getNote: vi.fn(async () => null),
      updateNote: vi.fn(async () => undefined),
    };
    const beforeMutation = vi.fn();

    await expect(
      new ActualReceiptNoteWriter(api).upsert(payload(), beforeMutation),
    ).rejects.toBeInstanceOf(ReceiptNoteWriteOutcomeUnknownError);
    expect(beforeMutation).toHaveBeenCalledOnce();
  });
});
