import { z } from 'zod';

import { ActualReadDataError } from './port.js';

export const ACTUAL_RECEIPT_LINK_TOKEN_PREFIX =
  '[[household-finance:receipt-link:v1:' as const;
export const MAX_ACTUAL_RECEIPT_LINKS_PER_TRANSACTION = 32;

const UUID_TEXT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SHA256_TEXT = '[0-9a-f]{64}';
const TOKEN_PATTERN = new RegExp(
  `\\[\\[household-finance:receipt-link:v1:(${UUID_TEXT}):(${SHA256_TEXT})\\]\\]`,
  'giu',
);

export interface ActualReceiptLink {
  readonly receiptId: string;
  readonly sourceSha256: string;
}

export interface ActualReceiptLinkExtraction {
  readonly links: readonly ActualReceiptLink[];
  readonly notesWithoutTokens: string;
  readonly hasMalformedTokens: boolean;
}

export function actualReceiptLinkToken(
  receiptId: string,
  sourceSha256: string,
): string {
  const validatedReceiptId = z.uuid().parse(receiptId).toLocaleLowerCase('en');
  const validatedSourceSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(sourceSha256)
    .toLocaleLowerCase('en');
  return `${ACTUAL_RECEIPT_LINK_TOKEN_PREFIX}${validatedReceiptId}:${validatedSourceSha256}]]`;
}

export function extractActualReceiptLink(
  notes: string,
): ActualReceiptLinkExtraction {
  if (notes.length > 10_000) {
    throw new ActualReadDataError();
  }
  const links: ActualReceiptLink[] = [];
  const seenLinks = new Set<string>();
  const notesWithoutTokens = notes.replaceAll(
    TOKEN_PATTERN,
    (_token, receiptId: string, sourceSha256: string) => {
      const normalizedReceiptId = z
        .uuid()
        .parse(receiptId)
        .toLocaleLowerCase('en');
      const normalizedSourceSha256 = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(sourceSha256)
        .toLocaleLowerCase('en');
      const key = `${normalizedReceiptId}\0${normalizedSourceSha256}`;
      if (!seenLinks.has(key)) {
        seenLinks.add(key);
        links.push({
          receiptId: normalizedReceiptId,
          sourceSha256: normalizedSourceSha256,
        });
      }
      return '';
    },
  );
  if (links.length > MAX_ACTUAL_RECEIPT_LINKS_PER_TRANSACTION) {
    throw new ActualReadDataError();
  }
  return {
    links,
    notesWithoutTokens,
    hasMalformedTokens: notesWithoutTokens
      .toLocaleLowerCase('en')
      .includes(ACTUAL_RECEIPT_LINK_TOKEN_PREFIX),
  };
}
