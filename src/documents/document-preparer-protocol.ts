import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  MAX_PREPARED_RECEIPT_PAGE_BYTES,
  MAX_PREPARED_RECEIPT_PAGES,
  parsePreparedReceiptDocument,
  PreparedReceiptDocumentError,
  type PreparedReceiptDocument,
} from '../model/index.js';
import type { ReceiptDocumentSource } from './receipt-document-preparer.js';

export const MAX_DOCUMENT_PREPARER_SOURCE_BYTES = 12 * 1024 * 1024;
export const MAX_DOCUMENT_PREPARER_RESPONSE_BYTES = 45 * 1024 * 1024;
export const DOCUMENT_PREPARER_JSON_CONTENT_TYPE =
  'application/json; charset=utf-8';

const MAX_BASE64_PAGE_CHARACTERS =
  Math.ceil(MAX_PREPARED_RECEIPT_PAGE_BYTES / 3) * 4;
const canonicalBase64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const transportedReceiptPageSchema = z.strictObject({
  position: z
    .number()
    .int()
    .min(0)
    .max(MAX_PREPARED_RECEIPT_PAGES - 1),
  mediaType: z.enum(['image/jpeg', 'image/png']),
  sha256: sha256Schema,
  bytesBase64: z
    .string()
    .min(4)
    .max(MAX_BASE64_PAGE_CHARACTERS)
    .regex(canonicalBase64),
});

const transportedReceiptDocumentSchema = z.strictObject({
  schemaVersion: z.literal('prepared-receipt-document.v1'),
  sourceSha256: sha256Schema,
  pages: z
    .array(transportedReceiptPageSchema)
    .min(1)
    .max(MAX_PREPARED_RECEIPT_PAGES),
});

export const receiptDocumentMediaTypes = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isReceiptDocumentMediaType(
  value: unknown,
): value is ReceiptDocumentSource['mediaType'] {
  return (
    typeof value === 'string' &&
    receiptDocumentMediaTypes.some((mediaType) => mediaType === value)
  );
}

export function sniffReceiptDocumentMediaType(
  bytes: Uint8Array,
): ReceiptDocumentSource['mediaType'] | undefined {
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  return undefined;
}

export function serializePreparedReceiptDocument(input: unknown): Buffer {
  const document = parsePreparedReceiptDocument(input);
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: document.schemaVersion,
      sourceSha256: document.sourceSha256,
      pages: document.pages.map((page) => ({
        position: page.position,
        mediaType: page.mediaType,
        sha256: page.sha256,
        bytesBase64: Buffer.from(
          page.bytes.buffer,
          page.bytes.byteOffset,
          page.bytes.byteLength,
        ).toString('base64'),
      })),
    }),
    'utf8',
  );
  if (payload.byteLength > MAX_DOCUMENT_PREPARER_RESPONSE_BYTES) {
    payload.fill(0);
    throw new PreparedReceiptDocumentError();
  }
  return payload;
}

function decodeCanonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_PREPARED_RECEIPT_PAGE_BYTES ||
    bytes.toString('base64') !== value
  ) {
    bytes.fill(0);
    throw new PreparedReceiptDocumentError();
  }
  return bytes;
}

export function parseTransportedReceiptDocument(
  input: unknown,
): PreparedReceiptDocument {
  const transported = transportedReceiptDocumentSchema.safeParse(input);
  if (!transported.success) {
    throw new PreparedReceiptDocumentError();
  }

  const pages: Array<{
    position: number;
    mediaType: 'image/jpeg' | 'image/png';
    sha256: string;
    bytes: Buffer;
  }> = [];
  try {
    for (const page of transported.data.pages) {
      pages.push({
        position: page.position,
        mediaType: page.mediaType,
        sha256: page.sha256,
        bytes: decodeCanonicalBase64(page.bytesBase64),
      });
    }
    return parsePreparedReceiptDocument({
      schemaVersion: transported.data.schemaVersion,
      sourceSha256: transported.data.sourceSha256,
      pages,
    });
  } catch (error) {
    for (const page of pages) {
      page.bytes.fill(0);
    }
    if (error instanceof PreparedReceiptDocumentError) {
      throw error;
    }
    throw new PreparedReceiptDocumentError();
  }
}
