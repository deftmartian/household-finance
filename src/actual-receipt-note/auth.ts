import { createHmac, timingSafeEqual, type BinaryLike } from 'node:crypto';

import { z } from 'zod';

import {
  canonicalReceiptNoteOperationJson,
  parseReceiptNoteUpsertPayload,
  type ReceiptNoteUpsertPayloadV1,
} from './payload.js';

const hmacDomain = 'household-finance.actual-receipt-note-envelope.v1\0';
const keyIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.includes('\0') &&
      !value.includes('\n') &&
      !value.includes('\r'),
  );
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export interface SealedReceiptNoteEnvelopeV1 {
  readonly schemaVersion: 'actual-receipt-note-envelope.v1';
  readonly keyId: string;
  readonly payload: ReceiptNoteUpsertPayloadV1;
  readonly signatureSha256: string;
}

const sealedReceiptNoteEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal('actual-receipt-note-envelope.v1'),
  keyId: keyIdSchema,
  payload: z.unknown(),
  signatureSha256: sha256Schema,
});

function keyMaterial(value: string | Uint8Array, keyId: string): Buffer {
  const key =
    typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (key.byteLength < 32) {
    key.fill(0);
    throw new TypeError(
      `Receipt-note authentication key ${keyId} must contain at least 32 bytes`,
    );
  }
  return key;
}

function sign(
  key: BinaryLike,
  value: Omit<SealedReceiptNoteEnvelopeV1, 'signatureSha256'>,
): string {
  return createHmac('sha256', key)
    .update(hmacDomain, 'utf8')
    .update(canonicalReceiptNoteOperationJson(value), 'utf8')
    .digest('hex');
}

export function parseSealedReceiptNoteEnvelope(
  value: unknown,
): SealedReceiptNoteEnvelopeV1 {
  const envelope = sealedReceiptNoteEnvelopeSchema.parse(value);
  return {
    schemaVersion: envelope.schemaVersion,
    keyId: envelope.keyId,
    payload: parseReceiptNoteUpsertPayload(envelope.payload),
    signatureSha256: envelope.signatureSha256,
  };
}

export class ReceiptNoteEnvelopeAuthenticationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReceiptNoteEnvelopeAuthenticationError';
  }
}

export interface ReceiptNoteEnvelopeAuthenticatorOptions {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string | Uint8Array>>;
}

/**
 * Receipt-note intents use the existing Actual-update keyring with a distinct
 * HMAC domain. This prevents a valid transaction envelope from being replayed
 * as a note write (or vice versa).
 */
export class ReceiptNoteEnvelopeAuthenticator {
  readonly #activeKeyId: string;
  readonly #keys = new Map<string, Buffer>();
  #destroyed = false;

  constructor(options: ReceiptNoteEnvelopeAuthenticatorOptions) {
    this.#activeKeyId = keyIdSchema.parse(options.activeKeyId);
    try {
      for (const [keyIdInput, value] of Object.entries(options.keys)) {
        const keyId = keyIdSchema.parse(keyIdInput);
        this.#keys.set(keyId, keyMaterial(value, keyId));
      }
      if (!this.#keys.has(this.#activeKeyId)) {
        throw new TypeError(
          'Active receipt-note authentication key is not configured',
        );
      }
    } catch (error) {
      for (const key of this.#keys.values()) {
        key.fill(0);
      }
      this.#keys.clear();
      throw error;
    }
  }

  seal(payloadInput: ReceiptNoteUpsertPayloadV1): SealedReceiptNoteEnvelopeV1 {
    this.#assertAvailable();
    const payload = parseReceiptNoteUpsertPayload(payloadInput);
    const unsigned = {
      schemaVersion: 'actual-receipt-note-envelope.v1' as const,
      keyId: this.#activeKeyId,
      payload,
    };
    const key = this.#keys.get(this.#activeKeyId);
    if (key === undefined) {
      throw new Error('Active receipt-note signing key disappeared');
    }
    return {
      ...structuredClone(unsigned),
      signatureSha256: sign(key, unsigned),
    };
  }

  verify(
    envelopeInput: SealedReceiptNoteEnvelopeV1,
  ): ReceiptNoteUpsertPayloadV1 {
    try {
      this.#assertAvailable();
      const envelope = parseSealedReceiptNoteEnvelope(envelopeInput);
      const key = this.#keys.get(envelope.keyId);
      if (key === undefined) {
        throw new Error('Receipt-note envelope key is unknown or retired');
      }
      const expected = Buffer.from(
        sign(key, {
          schemaVersion: envelope.schemaVersion,
          keyId: envelope.keyId,
          payload: envelope.payload,
        }),
        'hex',
      );
      const actual = Buffer.from(envelope.signatureSha256, 'hex');
      if (
        actual.byteLength !== expected.byteLength ||
        !timingSafeEqual(actual, expected)
      ) {
        throw new Error(
          'Receipt-note envelope signature does not match its payload',
        );
      }
      return structuredClone(envelope.payload);
    } catch (error) {
      if (error instanceof ReceiptNoteEnvelopeAuthenticationError) {
        throw error;
      }
      throw new ReceiptNoteEnvelopeAuthenticationError(
        'Receipt-note envelope authentication failed',
        { cause: error },
      );
    }
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    for (const key of this.#keys.values()) {
      key.fill(0);
    }
    this.#keys.clear();
  }

  #assertAvailable(): void {
    if (this.#destroyed) {
      throw new Error('Receipt-note authenticator has been destroyed');
    }
  }
}
