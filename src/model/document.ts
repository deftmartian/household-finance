import { createHash } from 'node:crypto';

import { z } from 'zod';

export const MAX_PREPARED_RECEIPT_PAGES = 10;
export const MAX_PREPARED_RECEIPT_PAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PREPARED_RECEIPT_TOTAL_BYTES = 32 * 1024 * 1024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const receiptPageSchema = z.strictObject({
  position: z
    .number()
    .int()
    .min(0)
    .max(MAX_PREPARED_RECEIPT_PAGES - 1),
  mediaType: z.enum(['image/jpeg', 'image/png']),
  sha256: sha256Schema,
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (bytes) =>
        bytes.byteLength > 0 &&
        bytes.byteLength <= MAX_PREPARED_RECEIPT_PAGE_BYTES,
      {
        message: 'Receipt page byte length is outside the allowed range',
      },
    ),
});

function hasExpectedSignature(
  mediaType: 'image/jpeg' | 'image/png',
  bytes: Uint8Array,
): boolean {
  if (mediaType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return pngSignature.every((value, index) => bytes[index] === value);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Binary pages are deliberately ephemeral. Callers persist only immutable
 * originals and hashes; page bytes must never be written to audit metadata or
 * logs.
 */
export const preparedReceiptDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal('prepared-receipt-document.v1'),
    sourceSha256: sha256Schema,
    pages: z.array(receiptPageSchema).min(1).max(MAX_PREPARED_RECEIPT_PAGES),
  })
  .superRefine((document, context) => {
    let totalBytes = 0;

    document.pages.forEach((page, index) => {
      totalBytes += page.bytes.byteLength;

      if (page.position !== index) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt pages must be ordered with contiguous positions',
          path: ['pages', index, 'position'],
        });
      }
      if (!hasExpectedSignature(page.mediaType, page.bytes)) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt page bytes do not match the declared media type',
          path: ['pages', index, 'mediaType'],
        });
      }
      if (sha256(page.bytes) !== page.sha256) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt page hash does not match its exact bytes',
          path: ['pages', index, 'sha256'],
        });
      }
    });

    if (totalBytes > MAX_PREPARED_RECEIPT_TOTAL_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'Prepared receipt exceeds the aggregate byte limit',
        path: ['pages'],
      });
    }
  });

export type PreparedReceiptDocument = Readonly<
  z.infer<typeof preparedReceiptDocumentSchema>
>;

export class PreparedReceiptDocumentError extends Error {
  readonly code = 'invalid-prepared-document';

  constructor() {
    super('Prepared receipt document is invalid');
    this.name = 'PreparedReceiptDocumentError';
  }
}

export function parsePreparedReceiptDocument(
  input: unknown,
): PreparedReceiptDocument {
  const parsed = preparedReceiptDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new PreparedReceiptDocumentError();
  }
  return parsed.data;
}
