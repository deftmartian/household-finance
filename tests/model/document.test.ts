import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_PREPARED_RECEIPT_PAGE_BYTES,
  MAX_PREPARED_RECEIPT_PAGES,
  MAX_PREPARED_RECEIPT_TOTAL_BYTES,
  parsePreparedReceiptDocument,
  PreparedReceiptDocumentError,
  preparedReceiptDocumentSchema,
} from '../../src/model/index.js';

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jpegBytes(extraBytes = 0): Uint8Array {
  const bytes = new Uint8Array(3 + extraBytes);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
}

describe('prepared receipt documents', () => {
  it('accepts exact ordered JPEG and PNG bytes with matching hashes', () => {
    const jpeg = jpegBytes(2);
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
    ]);

    expect(
      parsePreparedReceiptDocument({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256: 'a'.repeat(64),
        pages: [
          {
            position: 0,
            mediaType: 'image/jpeg',
            sha256: hash(jpeg),
            bytes: jpeg,
          },
          {
            position: 1,
            mediaType: 'image/png',
            sha256: hash(png),
            bytes: png,
          },
        ],
      }).pages,
    ).toHaveLength(2);
  });

  it('rejects out-of-order pages and mismatched hashes without echoing bytes', () => {
    const privateBytes = jpegBytes(8);
    privateBytes.set(Buffer.from('private'), 3);

    expect(() =>
      parsePreparedReceiptDocument({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256: 'b'.repeat(64),
        pages: [
          {
            position: 1,
            mediaType: 'image/jpeg',
            sha256: 'c'.repeat(64),
            bytes: privateBytes,
          },
        ],
      }),
    ).toThrowError(PreparedReceiptDocumentError);

    try {
      parsePreparedReceiptDocument({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256: 'b'.repeat(64),
        pages: [],
      });
    } catch (error) {
      expect(String(error)).not.toContain('private');
    }
  });

  it('enforces page-count and per-page byte limits', () => {
    const tiny = jpegBytes();
    const tooManyPages = Array.from(
      { length: MAX_PREPARED_RECEIPT_PAGES + 1 },
      (_, position) => ({
        position,
        mediaType: 'image/jpeg' as const,
        sha256: hash(tiny),
        bytes: tiny,
      }),
    );
    expect(
      preparedReceiptDocumentSchema.safeParse({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256: 'd'.repeat(64),
        pages: tooManyPages,
      }).success,
    ).toBe(false);

    const tooLarge = jpegBytes(MAX_PREPARED_RECEIPT_PAGE_BYTES - 2);
    expect(tooLarge.byteLength).toBe(MAX_PREPARED_RECEIPT_PAGE_BYTES + 1);
    expect(
      preparedReceiptDocumentSchema.safeParse({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256: 'e'.repeat(64),
        pages: [
          {
            position: 0,
            mediaType: 'image/jpeg',
            sha256: hash(tooLarge),
            bytes: tooLarge,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('enforces the aggregate byte limit independently of page limits', () => {
    const sharedPage = jpegBytes(
      Math.floor(MAX_PREPARED_RECEIPT_TOTAL_BYTES / 3),
    );
    expect(sharedPage.byteLength).toBeLessThan(MAX_PREPARED_RECEIPT_PAGE_BYTES);
    const pageHash = hash(sharedPage);

    expect(
      preparedReceiptDocumentSchema.safeParse({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256: 'f'.repeat(64),
        pages: [0, 1, 2].map((position) => ({
          position,
          mediaType: 'image/jpeg' as const,
          sha256: pageHash,
          bytes: sharedPage,
        })),
      }).success,
    ).toBe(false);
  });
});
