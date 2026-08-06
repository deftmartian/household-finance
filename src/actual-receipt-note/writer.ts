import { createHash } from 'node:crypto';

import {
  parseReceiptNoteUpsertPayload,
  type ReceiptNoteUpsertPayloadV1,
} from './payload.js';
import { actualReceiptNoteId } from '../receipt-record/index.js';

export interface ActualReceiptNoteEntity {
  readonly id: string;
  readonly note: string;
}

export interface ActualReceiptNoteApi {
  readonly getNote: (id: string) => Promise<ActualReceiptNoteEntity | null>;
  readonly updateNote: (id: string, note: string) => Promise<void>;
  readonly sync: () => Promise<unknown>;
}

export type ReceiptNoteUpsertResult =
  | {
      readonly status: 'updated' | 'already-desired';
      readonly receiptId: string;
      readonly noteId: string;
      readonly revision: number;
      readonly desiredSha256: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly reason:
        'unexpected-existing-note' | 'post-write-readback-mismatch';
      readonly receiptId: string;
      readonly noteId: string;
      readonly revision: number;
      readonly desiredSha256: string;
      readonly observedSha256: string | null;
    };

export class ReceiptNoteWriteOutcomeUnknownError extends Error {
  constructor(options?: ErrorOptions) {
    super('Receipt-note write outcome is unknown', options);
    this.name = 'ReceiptNoteWriteOutcomeUnknownError';
  }
}

export class ReceiptNoteWriteRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReceiptNoteWriteRefusedError';
  }
}

function validateEntity(
  value: ActualReceiptNoteEntity | null,
  noteId: string,
): ActualReceiptNoteEntity | null {
  if (value === null) {
    return null;
  }
  if (
    value === undefined ||
    typeof value !== 'object' ||
    value.id !== noteId ||
    typeof value.note !== 'string' ||
    value.note.includes('\0')
  ) {
    throw new ReceiptNoteWriteRefusedError(
      'Actual returned an invalid receipt-note entity',
    );
  }
  return value;
}

function observedSha256(entity: ActualReceiptNoteEntity | null): string | null {
  return entity === null
    ? null
    : createHash('sha256').update(entity.note, 'utf8').digest('hex');
}

/**
 * The only note-write capability exposed to the receipt workflow. Callers
 * supply a receipt UUID, never an Actual note ID, so writes cannot escape the
 * household-finance receipt namespace.
 */
export class ActualReceiptNoteWriter {
  readonly #api: ActualReceiptNoteApi;

  constructor(api: ActualReceiptNoteApi) {
    this.#api = api;
  }

  async upsert(
    payloadInput: ReceiptNoteUpsertPayloadV1,
    beforeMutation: () => void,
  ): Promise<ReceiptNoteUpsertResult> {
    const payload = parseReceiptNoteUpsertPayload(payloadInput);
    const noteId = actualReceiptNoteId(payload.receiptId);

    // Bring forward any receipt note that a prior crashed attempt updated
    // locally but did not finish syncing before inspecting the CAS state.
    await this.#api.sync();
    const current = validateEntity(await this.#api.getNote(noteId), noteId);
    if (current?.note === payload.desiredCanonicalJson) {
      return {
        status: 'already-desired',
        receiptId: payload.receiptId,
        noteId,
        revision: payload.revision,
        desiredSha256: payload.desiredSha256,
      };
    }

    const currentSha256 = observedSha256(current);
    const expectedMatches =
      payload.expectedPreviousSha256 === null
        ? current === null
        : currentSha256 === payload.expectedPreviousSha256;
    if (!expectedMatches) {
      return {
        status: 'ambiguous',
        reason: 'unexpected-existing-note',
        receiptId: payload.receiptId,
        noteId,
        revision: payload.revision,
        desiredSha256: payload.desiredSha256,
        observedSha256: currentSha256,
      };
    }

    beforeMutation();
    try {
      await this.#api.updateNote(noteId, payload.desiredCanonicalJson);
      await this.#api.sync();
      const readback = validateEntity(await this.#api.getNote(noteId), noteId);
      if (readback?.note === payload.desiredCanonicalJson) {
        return {
          status: 'updated',
          receiptId: payload.receiptId,
          noteId,
          revision: payload.revision,
          desiredSha256: payload.desiredSha256,
        };
      }
      return {
        status: 'ambiguous',
        reason: 'post-write-readback-mismatch',
        receiptId: payload.receiptId,
        noteId,
        revision: payload.revision,
        desiredSha256: payload.desiredSha256,
        observedSha256: observedSha256(readback),
      };
    } catch (error) {
      throw new ReceiptNoteWriteOutcomeUnknownError({ cause: error });
    }
  }
}
