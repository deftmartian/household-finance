import { describe, expect, it } from 'vitest';

import {
  ACTUAL_RECEIPT_NOTE_PREFIX,
  actualReceiptNoteId,
  canonicalizeHouseholdFinanceReceiptHouseholdNotes,
  canonicalHouseholdFinanceReceiptJson,
  householdFinanceReceiptSha256,
  parseHouseholdFinanceReceiptNote,
  parseHouseholdFinanceReceiptRecord,
  receiptRecordItemDetailsComplete,
} from '../../src/receipt-record/domain.js';

const receiptId = '8dfc1bd9-e07a-4c62-9d58-9529361536b9';
const sourceSha256 = 'a'.repeat(64);

function activeRecord(): unknown {
  return {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId,
    revision: 1,
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:01:00.000Z',
    sources: [
      {
        nextcloudFileId: 'nextcloud-file-1',
        archivePath: 'Household Finance/2026/07/source.jpg',
        sha256: sourceSha256,
        mediaType: 'image/jpeg',
        receivedAt: '2026-07-29T12:00:00.000Z',
        talk: {
          roomToken: 'household-finance',
          actorId: 'alex',
          messageId: '101',
        },
      },
    ],
    status: 'active',
    merchant: 'Example Market',
    purchaseDate: '2026-07-28',
    purchaseTime: '18:30:00',
    timezoneOffset: '-03:00',
    currency: 'CAD',
    amounts: {
      subtotalMinor: 1_500,
      taxMinor: 225,
      discountMinor: 0,
      tipMinor: 0,
      totalMinor: 1_725,
    },
    paymentEvidence: { kind: 'masked-card', lastFour: '8055' },
    receiptReference: 'SYNTHETIC-001',
    items: [
      {
        description: 'Synthetic cable',
        quantity: 1,
        unitPriceMinor: 1_000,
        totalMinor: 1_000,
      },
      {
        description: 'Synthetic paper',
        quantity: 2,
        unitPriceMinor: 250,
        totalMinor: 500,
      },
    ],
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      zeroDataRetention: true,
      extractedAt: '2026-07-29T12:01:00.000Z',
      sourceSha256s: [sourceSha256],
    },
  };
}

describe('household receipt record domain', () => {
  it('drops the Talk attachment placeholder from canonical household notes', () => {
    expect(
      canonicalizeHouseholdFinanceReceiptHouseholdNotes([
        {
          text: '{file}',
          receivedAt: '2026-07-29T12:00:30.000Z',
          talk: {
            roomToken: 'household-finance',
            actorId: 'alex',
            messageId: 'file-message',
          },
        },
      ]),
    ).toEqual([]);
  });

  it('round-trips strict active records using canonical JSON and hash', () => {
    const record = parseHouseholdFinanceReceiptRecord(activeRecord());
    const noteId = actualReceiptNoteId(receiptId.toUpperCase());
    const canonicalJson = canonicalHouseholdFinanceReceiptJson(record);

    expect(noteId).toBe(`${ACTUAL_RECEIPT_NOTE_PREFIX}${receiptId}`);
    expect(canonicalJson).toBe(
      canonicalHouseholdFinanceReceiptJson(JSON.parse(canonicalJson)),
    );
    expect(parseHouseholdFinanceReceiptNote(noteId, canonicalJson)).toEqual({
      noteId,
      record,
      canonicalJson,
      sha256: householdFinanceReceiptSha256(record),
    });
    if (record.status !== 'active') throw new Error('expected active receipt');
    expect(receiptRecordItemDetailsComplete(record)).toBe(true);
  });

  it('does not call absent, partial, or explicitly blocked item rows complete', () => {
    const base = activeRecord() as Record<string, unknown>;

    const noItems = parseHouseholdFinanceReceiptRecord({
      ...base,
      items: [],
    });
    const partialItems = parseHouseholdFinanceReceiptRecord({
      ...base,
      items: [
        {
          description: 'Synthetic cable',
          quantity: 1,
          unitPriceMinor: 1_000,
          totalMinor: null,
        },
      ],
    });
    const blocked = parseHouseholdFinanceReceiptRecord({
      ...base,
      extraction: {
        ...(base.extraction as object),
        itemSplitBlocked: true,
      },
    });
    expect(noItems.status).toBe('active');
    expect(partialItems.status).toBe('active');
    expect(blocked.status).toBe('active');
    if (
      noItems.status !== 'active' ||
      partialItems.status !== 'active' ||
      blocked.status !== 'active'
    ) {
      throw new Error('expected active receipts');
    }
    expect(receiptRecordItemDetailsComplete(noItems)).toBe(false);
    expect(receiptRecordItemDetailsComplete(partialItems)).toBe(false);
    expect(receiptRecordItemDetailsComplete(blocked)).toBe(false);
  });

  it('keeps gross item rows usable when a voucher is recorded as a discount', () => {
    const record = parseHouseholdFinanceReceiptRecord({
      ...(activeRecord() as Record<string, unknown>),
      amounts: {
        subtotalMinor: 1_300,
        taxMinor: 195,
        discountMinor: 200,
        tipMinor: 0,
        totalMinor: 1_495,
      },
      items: [
        {
          description: 'Warehouse item',
          quantity: 1,
          unitPriceMinor: 1_500,
          totalMinor: 1_500,
        },
      ],
    });
    if (record.status !== 'active') throw new Error('expected active receipt');

    expect(receiptRecordItemDetailsComplete(record)).toBe(true);
  });

  it('rejects gross rows that do not fit the receipt discount convention', () => {
    const record = parseHouseholdFinanceReceiptRecord({
      ...(activeRecord() as Record<string, unknown>),
      amounts: {
        subtotalMinor: 1_500,
        taxMinor: 225,
        discountMinor: 200,
        tipMinor: 0,
        totalMinor: 1_525,
      },
      items: [
        {
          description: 'Inconsistent merchandise rows',
          quantity: 1,
          unitPriceMinor: 1_700,
          totalMinor: 1_700,
        },
      ],
    });
    if (record.status !== 'active') throw new Error('expected active receipt');

    expect(receiptRecordItemDetailsComplete(record)).toBe(false);
  });

  it('accepts a minimal discarded record that retains immutable sources', () => {
    const active = activeRecord() as Record<string, unknown>;
    const discarded = {
      schemaVersion: active.schemaVersion,
      receiptId: active.receiptId,
      revision: 2,
      createdAt: active.createdAt,
      updatedAt: '2026-07-29T13:00:00.000Z',
      sources: active.sources,
      status: 'discarded',
      discardedAt: '2026-07-29T13:00:00.000Z',
    };

    expect(parseHouseholdFinanceReceiptRecord(discarded)).toEqual(discarded);
  });

  it('requires authenticated household notes in canonical authored order', () => {
    const earlier = {
      text: 'Maybe office supplies.',
      receivedAt: '2026-07-29T12:00:30.000Z',
      talk: {
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '200',
      },
    };
    const correction = {
      text: "Correction: Elia's birthday present.",
      receivedAt: '2026-07-29T12:00:45.000Z',
      talk: {
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '201',
      },
    };
    expect(
      parseHouseholdFinanceReceiptRecord({
        ...(activeRecord() as object),
        householdNotes: [earlier, correction],
      }),
    ).toMatchObject({ householdNotes: [earlier, correction] });
    expect(() =>
      parseHouseholdFinanceReceiptRecord({
        ...(activeRecord() as object),
        householdNotes: ['unstructured string note'],
      }),
    ).toThrow();
    expect(() =>
      parseHouseholdFinanceReceiptRecord({
        ...(activeRecord() as object),
        householdNotes: [correction, earlier],
      }),
    ).toThrow();
  });

  it('rejects non-fact fields, unknown currency, and payment inconsistencies', () => {
    expect(() =>
      parseHouseholdFinanceReceiptRecord({
        ...(activeRecord() as object),
        matchedTransactionIds: ['transaction-1'],
      }),
    ).toThrow();
    expect(() =>
      parseHouseholdFinanceReceiptRecord({
        ...(activeRecord() as Record<string, unknown>),
        currency: 'USD?',
      }),
    ).toThrow();
    expect(() =>
      parseHouseholdFinanceReceiptRecord({
        ...(activeRecord() as Record<string, unknown>),
        paymentEvidence: { kind: 'unknown', lastFour: '8055' },
      }),
    ).toThrow();
  });

  it('rejects mismatched IDs, noncanonical JSON, and inconsistent provenance', () => {
    const record = activeRecord();
    const canonical = canonicalHouseholdFinanceReceiptJson(record);

    expect(() =>
      parseHouseholdFinanceReceiptNote(
        `${ACTUAL_RECEIPT_NOTE_PREFIX}7b8101a4-a317-4b7c-88bd-ac4d4389c875`,
        canonical,
      ),
    ).toThrow();
    expect(() =>
      parseHouseholdFinanceReceiptNote(
        actualReceiptNoteId(receiptId),
        JSON.stringify(record),
      ),
    ).toThrow();
    expect(() =>
      parseHouseholdFinanceReceiptRecord({
        ...(record as Record<string, unknown>),
        extraction: {
          ...((record as Record<string, unknown>).extraction as object),
          sourceSha256s: ['b'.repeat(64)],
        },
      }),
    ).toThrow();
  });
});
