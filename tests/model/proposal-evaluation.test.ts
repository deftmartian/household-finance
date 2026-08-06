import { describe, expect, it } from 'vitest';

import {
  assessReceiptModelProposal,
  receiptLineItemsSupportAllocation,
  receiptModelProposalV1Schema,
  type ReceiptModelProposalV1,
} from '../../src/model/index.js';

function field(value: string | null, sourcePage: number | null = 1) {
  return {
    value,
    evidence: value === null ? ('absent' as const) : ('explicit' as const),
    confidence: value === null ? 0 : 1,
    sourcePage: value === null ? null : sourcePage,
  };
}

function amount(valueMinor: number | null) {
  return {
    valueMinor,
    evidence: valueMinor === null ? ('absent' as const) : ('explicit' as const),
    confidence: valueMinor === null ? 0 : 1,
    sourcePage: valueMinor === null ? null : 1,
  };
}

function validProposal(): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'single-receipt',
    merchant: field('Example Market'),
    purchaseDate: field('2026-07-27'),
    purchaseTime: field(null),
    timezoneOffset: field(null),
    currency: field('CAD'),
    amounts: {
      subtotal: amount(1500),
      tax: amount(225),
      discount: amount(0),
      tip: amount(0),
      total: amount(1725),
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    },
    receiptReference: field(null),
    lineItems: [
      {
        description: 'Synthetic item',
        quantity: 1,
        unitPriceMinor: 1500,
        totalMinor: 1500,
        confidence: 1,
        sourcePage: 1,
      },
    ],
    uncertainties: [],
  };
}

describe('receipt model proposal assessment', () => {
  it('marks only a complete, reconciled proposal ready', () => {
    expect(assessReceiptModelProposal(validProposal())).toEqual({
      disposition: 'ready',
      materialAmbiguity: false,
      arithmeticChecked: true,
      arithmeticCorrect: true,
      issueCodes: [],
    });
  });

  it('treats optional amounts explicitly marked absent as zero when totals reconcile', () => {
    const proposal = validProposal();
    proposal.amounts.tax = amount(null);
    proposal.amounts.discount = amount(null);
    proposal.amounts.tip = amount(null);
    proposal.amounts.total = amount(1500);

    expect(assessReceiptModelProposal(proposal)).toEqual({
      disposition: 'ready',
      materialAmbiguity: false,
      arithmeticChecked: true,
      arithmeticCorrect: true,
      issueCodes: [],
    });
  });

  it('accepts an explicit tax when omitted discount and tip reconcile as zero', () => {
    const proposal = validProposal();
    proposal.amounts.subtotal = amount(150);
    proposal.amounts.tax = amount(21);
    proposal.amounts.discount = amount(null);
    proposal.amounts.tip = amount(null);
    proposal.amounts.total = amount(171);
    proposal.lineItems[0]!.unitPriceMinor = 150;
    proposal.lineItems[0]!.totalMinor = 150;

    expect(assessReceiptModelProposal(proposal)).toEqual({
      disposition: 'ready',
      materialAmbiguity: false,
      arithmeticChecked: true,
      arithmeticCorrect: true,
      issueCodes: [],
    });
  });

  it('does not assume absent optional amounts are zero when totals do not reconcile', () => {
    const proposal = validProposal();
    proposal.amounts.tax = amount(null);
    proposal.amounts.discount = amount(null);
    proposal.amounts.tip = amount(null);

    expect(assessReceiptModelProposal(proposal)).toMatchObject({
      disposition: 'review',
      arithmeticChecked: false,
      arithmeticCorrect: false,
      issueCodes: ['amounts-incomplete'],
    });
  });

  it('keeps unreadable optional amounts incomplete even when zero would reconcile', () => {
    const proposal = validProposal();
    proposal.amounts.tax = {
      valueMinor: null,
      evidence: 'unreadable',
      confidence: 0,
      sourcePage: 1,
    };
    proposal.amounts.discount = amount(null);
    proposal.amounts.tip = amount(null);
    proposal.amounts.total = amount(1500);

    expect(assessReceiptModelProposal(proposal)).toMatchObject({
      disposition: 'review',
      arithmeticChecked: false,
      arithmeticCorrect: false,
      issueCodes: ['amounts-incomplete'],
    });
  });

  it('routes missing evidence and bad arithmetic to review', () => {
    const proposal = validProposal();
    proposal.merchant = field(null);
    proposal.amounts.total = amount(1800);

    expect(assessReceiptModelProposal(proposal)).toMatchObject({
      disposition: 'review',
      materialAmbiguity: true,
      arithmeticChecked: true,
      arithmeticCorrect: false,
      issueCodes: expect.arrayContaining([
        'merchant-missing',
        'amounts-invalid',
      ]),
    });
  });

  it.each([
    'split-tender' as const,
    'combined-charge' as const,
    'reimbursement' as const,
  ])('routes model-identified %s to material review', (code) => {
    const proposal = validProposal();
    proposal.uncertainties.push({
      code,
      message: 'Synthetic manual-review condition',
      material: true,
      sourcePage: 1,
    });

    expect(assessReceiptModelProposal(proposal)).toMatchObject({
      disposition: 'review',
      materialAmbiguity: true,
      issueCodes: ['material-model-uncertainty'],
    });
  });

  it.each([
    'currency-unclear' as const,
    'merchant-unclear' as const,
    'payment-unclear' as const,
  ])('uses validated receipt facts despite a model %s advisory', (code) => {
    const proposal = validProposal();
    proposal.uncertainties.push({
      code,
      message: 'The structured receipt facts remain usable',
      material: true,
      sourcePage: 1,
    });

    expect(assessReceiptModelProposal(proposal)).toEqual({
      disposition: 'ready',
      materialAmbiguity: false,
      arithmeticChecked: true,
      arithmeticCorrect: true,
      issueCodes: [],
    });
  });

  it.each([
    'date-unclear' as const,
    'amounts-unclear' as const,
    'line-items-unclear' as const,
  ])('keeps a material %s warning in review', (code) => {
    const proposal = validProposal();
    proposal.uncertainties.push({
      code,
      message: 'The structured receipt fact may materially change',
      material: true,
      sourcePage: 1,
    });

    expect(assessReceiptModelProposal(proposal)).toMatchObject({
      disposition: 'review',
      materialAmbiguity: true,
      issueCodes: ['material-model-uncertainty'],
    });
  });

  it('accepts complete line items that include tax and sum to the total', () => {
    const proposal = validProposal();
    proposal.lineItems[0]!.unitPriceMinor = 1725;
    proposal.lineItems[0]!.totalMinor = 1725;

    expect(assessReceiptModelProposal(proposal)).toEqual({
      disposition: 'ready',
      materialAmbiguity: false,
      arithmeticChecked: true,
      arithmeticCorrect: true,
      issueCodes: [],
    });
  });

  it('accepts complete gross item rows when a printed discount makes the subtotal net', () => {
    const proposal = validProposal();
    proposal.amounts.subtotal = amount(1_300);
    proposal.amounts.tax = amount(195);
    proposal.amounts.discount = amount(200);
    proposal.amounts.total = amount(1_495);
    proposal.lineItems[0]!.unitPriceMinor = 1_500;
    proposal.lineItems[0]!.totalMinor = 1_500;

    expect(receiptLineItemsSupportAllocation(proposal)).toBe(true);
    expect(assessReceiptModelProposal(proposal)).toEqual({
      disposition: 'ready',
      materialAmbiguity: false,
      arithmeticChecked: true,
      arithmeticCorrect: true,
      issueCodes: [],
    });
  });

  it('does not accept subtotal-plus-discount rows under conventional discount arithmetic', () => {
    const proposal = validProposal();
    proposal.amounts.discount = amount(200);
    proposal.amounts.total = amount(1_525);
    proposal.lineItems[0]!.unitPriceMinor = 1_700;
    proposal.lineItems[0]!.totalMinor = 1_700;

    expect(receiptLineItemsSupportAllocation(proposal)).toBe(false);
    expect(assessReceiptModelProposal(proposal)).toMatchObject({
      disposition: 'review',
      issueCodes: ['line-items-mismatch'],
    });
  });

  it.each([
    {
      condition: 'missing',
      expectedIssue: 'line-items-incomplete',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.lineItems = [];
      },
    },
    {
      condition: 'incomplete',
      expectedIssue: 'line-items-incomplete',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.lineItems[0]!.totalMinor = null;
      },
    },
    {
      condition: 'inconsistent with the receipt total',
      expectedIssue: 'line-items-mismatch',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.lineItems[0]!.unitPriceMinor = 1_000;
        proposal.lineItems[0]!.totalMinor = 1_000;
      },
    },
  ])(
    'keeps $condition line items in review for item-level processing',
    ({ change, expectedIssue }) => {
      const proposal = validProposal();
      change(proposal);

      expect(assessReceiptModelProposal(proposal)).toMatchObject({
        disposition: 'review',
        materialAmbiguity: true,
        arithmeticChecked: true,
        arithmeticCorrect: true,
        issueCodes: [expectedIssue],
      });
    },
  );

  it('rejects internally contradictory evidence fields', () => {
    const proposal = validProposal();
    proposal.merchant = {
      value: 'Example',
      evidence: 'absent',
      confidence: 1,
      sourcePage: null,
    };

    expect(receiptModelProposalV1Schema.safeParse(proposal).success).toBe(
      false,
    );
  });
});
