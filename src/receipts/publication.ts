import { createReceiptNoteUpsertPayload } from '../actual-receipt-note/index.js';
import type {
  ReceiptNoteEnvelopeAuthenticator,
  ReceiptNoteOutboxStore,
} from '../actual-receipt-note/index.js';
import {
  householdFinanceReceiptSha256,
  parseHouseholdFinanceReceiptRecord,
  type HouseholdFinanceReceiptRecordV1,
} from '../receipt-record/index.js';

export interface ReceiptRecordPublicationResult {
  readonly inserted: boolean;
  readonly receiptId: string;
  readonly revision: number;
  readonly desiredSha256: string;
  readonly status: string;
}

export interface ReceiptRecordPublisherOptions {
  readonly store: Pick<ReceiptNoteOutboxStore, 'enqueueSealed'>;
  readonly authenticator: Pick<ReceiptNoteEnvelopeAuthenticator, 'seal'>;
}

/**
 * Finance-bot can only enqueue a fully validated canonical receipt record.
 * Actual identity is derived later by the isolated writer from the receipt
 * UUID, so this producer has no generic note-write capability.
 */
export class ReceiptRecordPublisher {
  readonly #store: ReceiptRecordPublisherOptions['store'];
  readonly #authenticator: ReceiptRecordPublisherOptions['authenticator'];

  constructor(options: ReceiptRecordPublisherOptions) {
    this.#store = options.store;
    this.#authenticator = options.authenticator;
  }

  publish(
    recordInput: HouseholdFinanceReceiptRecordV1,
    previousInput?: HouseholdFinanceReceiptRecordV1,
  ): ReceiptRecordPublicationResult {
    const record = parseHouseholdFinanceReceiptRecord(recordInput);
    const previous =
      previousInput === undefined
        ? undefined
        : parseHouseholdFinanceReceiptRecord(previousInput);
    if (
      (previous === undefined && record.revision !== 1) ||
      (previous !== undefined &&
        (previous.receiptId !== record.receiptId ||
          previous.revision + 1 !== record.revision))
    ) {
      throw new TypeError('Receipt record revision is not contiguous');
    }
    const desiredSha256 = householdFinanceReceiptSha256(record);
    const expectedPreviousSha256 =
      previous === undefined ? null : householdFinanceReceiptSha256(previous);
    const createdAt = record.updatedAt;
    const sealed = this.#authenticator.seal(
      createReceiptNoteUpsertPayload({
        record,
        expectedPreviousSha256,
        idempotencyKey: [
          'receipt-note',
          record.receiptId,
          String(record.revision),
          desiredSha256,
        ].join('/'),
        createdAt,
      }),
    );
    const result = this.#store.enqueueSealed(sealed);
    return {
      inserted: result.inserted,
      receiptId: record.receiptId,
      revision: record.revision,
      desiredSha256,
      status: result.item.status,
    };
  }
}
