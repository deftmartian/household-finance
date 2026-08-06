import { describe, expect, it } from 'vitest';

import {
  ReceiptNoteEnvelopeAuthenticator,
  ReceiptNoteOutboxStore,
} from '../../src/actual-receipt-note/index.js';
import {
  parseHouseholdFinanceReceiptRecord,
  type HouseholdFinanceReceiptRecordV1,
} from '../../src/receipt-record/index.js';
import { ReceiptRecordPublisher } from '../../src/receipts/publication.js';

const receiptId = '8dfc1bd9-e07a-4c62-9d58-9529361536b9';
const sha256 = 'a'.repeat(64);

function record(
  revision: number,
  previous?: HouseholdFinanceReceiptRecordV1,
): HouseholdFinanceReceiptRecordV1 {
  return parseHouseholdFinanceReceiptRecord({
    schemaVersion: 'household-finance.receipt.v1',
    receiptId,
    revision,
    createdAt: previous?.createdAt ?? '2026-07-29T12:00:00.000Z',
    updatedAt: `2026-07-29T12:0${String(revision)}:00.000Z`,
    sources: [
      {
        nextcloudFileId: '123',
        archivePath: 'Household Finance/2026/07/receipt.jpg',
        sha256,
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
    purchaseDate: '2026-07-29',
    purchaseTime: null,
    timezoneOffset: null,
    currency: 'CAD',
    amounts: {
      subtotalMinor: 1_500,
      taxMinor: 225,
      discountMinor: 0,
      tipMinor: 0,
      totalMinor: 1_725,
    },
    paymentEvidence: { kind: 'unknown', lastFour: null },
    receiptReference: null,
    items: [
      {
        description: 'Cable',
        quantity: 1,
        unitPriceMinor: 1_500,
        totalMinor: 1_500,
      },
    ],
    extraction: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      zeroDataRetention: true,
      extractedAt: `2026-07-29T12:0${String(revision)}:00.000Z`,
      sourceSha256s: [sha256],
    },
  });
}

describe('ReceiptRecordPublisher', () => {
  it('enqueues signed contiguous revisions idempotently', () => {
    const store = new ReceiptNoteOutboxStore(':memory:');
    const authenticator = new ReceiptNoteEnvelopeAuthenticator({
      activeKeyId: 'test',
      keys: { test: 'a'.repeat(64) },
    });
    const publisher = new ReceiptRecordPublisher({
      store,
      authenticator,
    });
    const first = record(1);
    const second = record(2, first);

    expect(publisher.publish(first)).toMatchObject({
      inserted: true,
      receiptId,
      revision: 1,
      status: 'queued',
    });
    expect(publisher.publish(first)).toMatchObject({
      inserted: false,
      revision: 1,
    });
    expect(publisher.publish(second, first)).toMatchObject({
      inserted: true,
      revision: 2,
    });

    authenticator.destroy();
    store.close();
  });

  it('rejects a noncontiguous revision', () => {
    const store = new ReceiptNoteOutboxStore(':memory:');
    const authenticator = new ReceiptNoteEnvelopeAuthenticator({
      activeKeyId: 'test',
      keys: { test: 'a'.repeat(64) },
    });
    const publisher = new ReceiptRecordPublisher({
      store,
      authenticator,
    });

    expect(() => publisher.publish(record(2))).toThrow(
      'revision is not contiguous',
    );

    authenticator.destroy();
    store.close();
  });
});
