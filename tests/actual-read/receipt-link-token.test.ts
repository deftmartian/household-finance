import { describe, expect, it } from 'vitest';

import { ActualReadDataError } from '../../src/actual-read/port.js';
import {
  actualReceiptLinkToken,
  extractActualReceiptLink,
} from '../../src/actual-read/receipt-link-token.js';

const receiptId = '8dfc1bd9-e07a-4c62-9d58-9529361536b9';
const sourceSha256 = 'a'.repeat(64);

describe('Actual receipt-link notes token', () => {
  it('round-trips the reserved token and removes it from model-safe notes', () => {
    const token = actualReceiptLinkToken(receiptId, sourceSha256);

    expect(
      extractActualReceiptLink(`weekly groceries ${token} paid by card`),
    ).toEqual({
      links: [{ receiptId, sourceSha256 }],
      notesWithoutTokens: 'weekly groceries  paid by card',
      hasMalformedTokens: false,
    });
    expect(
      extractActualReceiptLink(`${token} duplicate ${token}`),
    ).toMatchObject({ links: [{ receiptId, sourceSha256 }] });
  });

  it('preserves ordered distinct links and flags malformed reserved tokens', () => {
    const otherReceiptId = 'a8a3eab6-fb10-47d8-930b-3e28ffdaf845';
    expect(
      extractActualReceiptLink(
        `${actualReceiptLinkToken(receiptId, sourceSha256)} human ${actualReceiptLinkToken(
          otherReceiptId,
          'b'.repeat(64),
        )} ${actualReceiptLinkToken(receiptId, sourceSha256)}`,
      ),
    ).toEqual({
      links: [
        { receiptId, sourceSha256 },
        { receiptId: otherReceiptId, sourceSha256: 'b'.repeat(64) },
      ],
      notesWithoutTokens: ' human  ',
      hasMalformedTokens: false,
    });
    expect(
      extractActualReceiptLink(
        'keep [[household-finance:receipt-link:v1:not-a-valid-uuid]] this',
      ),
    ).toEqual({
      links: [],
      notesWithoutTokens:
        'keep [[household-finance:receipt-link:v1:not-a-valid-uuid]] this',
      hasMalformedTokens: true,
    });
  });

  it('fails closed when the bounded distinct-link limit is exceeded', () => {
    const tokens = Array.from({ length: 33 }, (_, index) =>
      actualReceiptLinkToken(
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        String(index).padStart(64, '0'),
      ),
    ).join(' ');

    expect(() => extractActualReceiptLink(tokens)).toThrow(ActualReadDataError);
  });
});
