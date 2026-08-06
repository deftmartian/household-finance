import { describe, expect, it } from 'vitest';

import {
  canonicalizeHouseholdReceiptCurrency,
  normalizeReceiptModelProposalV1,
  receiptModelProposalV1JsonSchema,
  receiptModelProposalV1Schema,
  type ReceiptModelProposalV1,
} from '../../src/model/index.js';

function nullField() {
  return {
    value: null,
    evidence: 'absent' as const,
    confidence: 0,
    sourcePage: null,
  };
}

function nullAmount() {
  return {
    valueMinor: null,
    evidence: 'absent' as const,
    confidence: 0,
    sourcePage: null,
  };
}

function unknownProposal(): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'uncertain',
    merchant: nullField(),
    purchaseDate: nullField(),
    purchaseTime: nullField(),
    timezoneOffset: nullField(),
    currency: nullField(),
    amounts: {
      subtotal: nullAmount(),
      tax: nullAmount(),
      discount: nullAmount(),
      tip: nullAmount(),
      total: nullAmount(),
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    },
    receiptReference: nullField(),
    lineItems: [],
    uncertainties: [
      {
        code: 'document-kind-unclear',
        message: 'The document is unreadable',
        material: true,
        sourcePage: null,
      },
    ],
  };
}

describe('receipt model proposal schema', () => {
  it('allows a fully unknown proposal without requiring invention', () => {
    expect(
      receiptModelProposalV1Schema.parse(unknownProposal()).documentDisposition,
    ).toBe('uncertain');
  });

  it.each([
    {
      name: 'CAD derived from the receipt',
      currency: 'CAD',
      evidence: 'derived' as const,
      expectedCurrency: 'CAD',
      expectedEvidence: 'derived',
    },
    {
      name: 'explicit USD',
      currency: 'USD',
      evidence: 'explicit' as const,
      expectedCurrency: 'USD',
      expectedEvidence: 'explicit',
    },
    {
      name: 'derived USD',
      currency: 'USD',
      evidence: 'derived' as const,
      expectedCurrency: 'CAD',
      expectedEvidence: 'inferred',
    },
    {
      name: 'inferred EUR',
      currency: 'EUR',
      evidence: 'inferred' as const,
      expectedCurrency: 'CAD',
      expectedEvidence: 'inferred',
    },
  ])(
    'canonicalizes $name without mutating the extraction proposal',
    ({ currency, evidence, expectedCurrency, expectedEvidence }) => {
      const proposal = unknownProposal();
      proposal.currency = {
        value: currency,
        evidence,
        confidence: 0.8,
        sourcePage: 1,
      };

      const canonical = canonicalizeHouseholdReceiptCurrency(proposal);

      expect(canonical.currency).toEqual({
        value: expectedCurrency,
        evidence: expectedEvidence,
        confidence: 0.8,
        sourcePage: 1,
      });
      expect(proposal.currency).toEqual({
        value: currency,
        evidence,
        confidence: 0.8,
        sourcePage: 1,
      });
      expect(canonical).not.toBe(proposal);
    },
  );

  it('keeps an absent currency absent in the canonical proposal', () => {
    const proposal = unknownProposal();

    expect(canonicalizeHouseholdReceiptCurrency(proposal).currency).toEqual(
      nullField(),
    );
    expect(proposal.currency).toEqual(nullField());
  });

  it('uses one-based source page numbers', () => {
    const firstPage = unknownProposal();
    firstPage.merchant = {
      value: 'Synthetic merchant',
      evidence: 'explicit',
      confidence: 1,
      sourcePage: 1,
    };
    expect(receiptModelProposalV1Schema.safeParse(firstPage).success).toBe(
      true,
    );

    firstPage.merchant.sourcePage = 0;
    expect(receiptModelProposalV1Schema.safeParse(firstPage).success).toBe(
      false,
    );
  });

  it.each([
    'Card: 4111 1111 1111 1111',
    'VISA 4111..1111••1111  1111',
    'PAN 4111X1111X1111X1111',
  ])(
    'rejects complete payment-card numbers in model free text',
    (sensitiveNumber) => {
      const proposal = unknownProposal();
      proposal.receiptReference = {
        value: sensitiveNumber,
        evidence: 'explicit',
        confidence: 1,
        sourcePage: 1,
      };

      const result = receiptModelProposalV1Schema.safeParse(proposal);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).not.toContain(
          sensitiveNumber,
        );
      }
    },
  );

  it('normalizes contradictory field evidence into material review', () => {
    const proposal = unknownProposal();
    proposal.merchant = {
      value: null,
      evidence: 'explicit',
      confidence: 0.9,
      sourcePage: 1,
    };
    proposal.receiptReference = {
      value: 'UNSUPPORTED-REFERENCE',
      evidence: 'absent',
      confidence: 0.7,
      sourcePage: null,
    };

    const normalized = receiptModelProposalV1Schema.parse(
      normalizeReceiptModelProposalV1(proposal),
    );

    expect(normalized.merchant).toEqual({
      value: null,
      evidence: 'unreadable',
      confidence: 0.9,
      sourcePage: 1,
    });
    expect(normalized.receiptReference).toEqual({
      value: null,
      evidence: 'absent',
      confidence: 0,
      sourcePage: null,
    });
    expect(normalized.uncertainties).toContainEqual({
      code: 'other',
      message: 'Observed field evidence was internally inconsistent',
      material: true,
      sourcePage: 1,
    });
  });

  it.each([
    '123456789012',
    'INV-2026-1234567890123456',
    'AUTH 987654321098765432',
    'AUTH 4111111111111111',
  ])('accepts ordinary long receipt identifiers: %s', (identifier) => {
    const proposal = unknownProposal();
    proposal.receiptReference = {
      value: identifier,
      evidence: 'explicit',
      confidence: 1,
      sourcePage: 1,
    };

    expect(receiptModelProposalV1Schema.safeParse(proposal).success).toBe(true);
  });

  it('rejects numeric fields large enough to conceal a financial identifier', () => {
    const proposal = unknownProposal();
    proposal.amounts.total = {
      valueMinor: 411_111_111_111,
      evidence: 'explicit',
      confidence: 1,
      sourcePage: 1,
    };

    expect(receiptModelProposalV1Schema.safeParse(proposal).success).toBe(
      false,
    );
  });

  it.each([
    {
      kind: 'masked-card' as const,
      lastFour: null,
      confidence: 0.8,
      sourcePage: 1,
    },
    {
      kind: 'unknown' as const,
      lastFour: '4242',
      confidence: 0.8,
      sourcePage: 1,
    },
  ])(
    'normalizes inconsistent payment evidence without blocking the receipt',
    (paymentEvidence) => {
      const proposal = unknownProposal();
      proposal.paymentEvidence = paymentEvidence;

      const normalized = receiptModelProposalV1Schema.parse(
        normalizeReceiptModelProposalV1(proposal),
      );

      expect(normalized.paymentEvidence).toEqual({
        kind: 'unknown',
        lastFour: null,
        confidence: 0,
        sourcePage: null,
      });
      expect(normalized.uncertainties).toContainEqual({
        code: 'payment-unclear',
        message: 'Payment evidence fields were inconsistent',
        material: false,
        sourcePage: 1,
      });
    },
  );

  it('exports a strict provider schema without ledger categories or IDs', () => {
    const serialized = JSON.stringify(receiptModelProposalV1JsonSchema);
    expect(serialized).toContain('"additionalProperties":false');
    expect(serialized).not.toContain('category');
    expect(serialized).not.toContain('actual');
    expect(serialized).not.toContain('inputId');
    expect(serialized).not.toContain('lineItemId');
  });
});
