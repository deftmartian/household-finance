import { describe, expect, it } from 'vitest';

import {
  buildExtractedReceiptMatchIntent,
  matchReceiptToImportedTransactions,
  type ImportedTransactionCandidate,
  type ReceiptMatchIntent,
} from '../../src/matching/index.js';
import type { ReceiptModelProposalV1 } from '../../src/model/index.js';

function receiptProposal(): ReceiptModelProposalV1 {
  const field = (value: string | null) => ({
    value,
    evidence: value === null ? ('absent' as const) : ('explicit' as const),
    confidence: value === null ? 0 : 1,
    sourcePage: value === null ? null : 1,
  });
  const amount = (valueMinor: number) => ({
    valueMinor,
    evidence: 'explicit' as const,
    confidence: 1,
    sourcePage: 1,
  });
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'single-receipt',
    merchant: field('Example Market'),
    purchaseDate: field('2026-07-28'),
    purchaseTime: field(null),
    timezoneOffset: field(null),
    currency: field('CAD'),
    amounts: {
      subtotal: amount(1_500),
      tax: amount(225),
      discount: amount(0),
      tip: amount(0),
      total: amount(1_725),
    },
    paymentEvidence: {
      kind: 'masked-card',
      lastFour: '1234',
      confidence: 1,
      sourcePage: 1,
    },
    receiptReference: field(null),
    lineItems: [
      {
        description: 'Synthetic item',
        quantity: 1,
        unitPriceMinor: 1_500,
        totalMinor: 1_500,
        confidence: 1,
        sourcePage: 1,
      },
    ],
    uncertainties: [],
  };
}

const receipt: ReceiptMatchIntent = {
  schemaVersion: 'receipt-match-intent.v1',
  receiptId: 'bf3462c8-973d-4ddf-a961-32662d42f12e',
  merchantName: 'Example Market',
  purchaseDate: '2026-07-28',
  currency: 'CAD',
  totalMinorUnits: 1_725,
  paymentEvidence: { kind: 'masked-card', lastFour: '1234' },
};
const candidate: ImportedTransactionCandidate = {
  transactionId: 'actual-internal-1',
  importedId: 'simplefin-1',
  accountAlias: 'spending-card',
  accountLastFour: '1234',
  postingDate: '2026-07-29',
  payeeName: 'EXAMPLE MARKET #123',
  currency: 'CAD',
  amountMinorUnits: -1_725,
  alreadyLinkedReceipts: [],
};
const linkedSource = (receiptId: string) => ({
  receiptId,
  sourceSha256: 'a'.repeat(64),
});

describe('receipt to imported transaction matching', () => {
  it('builds match intents from ready CAD and foreign-currency receipts', () => {
    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, receiptProposal()),
    ).toEqual({
      disposition: 'ready',
      intent: receipt,
    });
    const proposal = receiptProposal();
    proposal.currency = {
      value: 'USD',
      evidence: 'explicit',
      confidence: 1,
      sourcePage: 1,
    };
    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'ready',
      intent: {
        ...receipt,
        currency: 'USD',
      },
    });

    proposal.currency = {
      value: 'USD',
      evidence: 'derived',
      confidence: 0.8,
      sourcePage: 1,
    };
    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'ready',
      intent: receipt,
    });
  });

  it('builds an unknown-payment match intent from otherwise usable facts', () => {
    const proposal = receiptProposal();
    proposal.paymentEvidence = {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    };
    proposal.uncertainties.push({
      code: 'payment-unclear',
      message: 'The receipt does not show a payment method',
      material: true,
      sourcePage: 1,
    });

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'ready',
      intent: {
        ...receipt,
        paymentEvidence: { kind: 'unknown' },
      },
    });
  });

  it.each([
    {
      condition: 'no extracted line items',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.lineItems = [];
      },
    },
    {
      condition: 'an incomplete extracted line item',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.lineItems[0]!.totalMinor = null;
      },
    },
    {
      condition: 'line items that do not reconcile to the receipt total',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.lineItems[0]!.unitPriceMinor = 1_000;
        proposal.lineItems[0]!.totalMinor = 1_000;
      },
    },
    {
      condition: 'incomplete header arithmetic with a clear total',
      change: (proposal: ReceiptModelProposalV1) => {
        proposal.amounts.tax = {
          valueMinor: null,
          evidence: 'unreadable',
          confidence: 0,
          sourcePage: 1,
        };
      },
    },
  ])('builds a match intent with $condition', ({ change }) => {
    const proposal = receiptProposal();
    change(proposal);

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'ready',
      intent: receipt,
    });
  });

  it('treats material line-item uncertainty as non-blocking for matching only', () => {
    const proposal = receiptProposal();
    proposal.lineItems = [];
    proposal.uncertainties.push({
      code: 'line-items-unclear',
      message: 'The item rows are unreadable, but the receipt total is clear.',
      material: true,
      sourcePage: 1,
    });

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'ready',
      intent: receipt,
    });
  });

  it('does not build a match intent with invalid receipt arithmetic', () => {
    const proposal = receiptProposal();
    proposal.lineItems = [];
    proposal.amounts.total.valueMinor = 1_800;

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'review',
      reason: 'receipt-not-ready',
    });
  });

  it('returns review instead of throwing for a zero-total receipt', () => {
    const proposal = receiptProposal();
    proposal.amounts.subtotal.valueMinor = 0;
    proposal.amounts.tax.valueMinor = 0;
    proposal.amounts.total.valueMinor = 0;
    proposal.lineItems[0]!.unitPriceMinor = 0;
    proposal.lineItems[0]!.totalMinor = 0;

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'review',
      reason: 'receipt-not-ready',
    });
  });

  it('returns the exact missing receipt-level field reason', () => {
    const proposal = receiptProposal();
    proposal.merchant = {
      value: null,
      evidence: 'unreadable',
      confidence: 0,
      sourcePage: 1,
    };

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'review',
      reason: 'merchant-missing',
    });
  });

  it('uses the normal fuzzy merchant match when the printed seller name is abbreviated', () => {
    const proposal = receiptProposal();
    proposal.paymentEvidence = {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    };
    proposal.uncertainties.push({
      code: 'merchant-unclear',
      message: 'The printed seller name is abbreviated.',
      material: true,
      sourcePage: 1,
    });
    const built = buildExtractedReceiptMatchIntent(receipt.receiptId, proposal);
    expect(built).toEqual({
      disposition: 'ready',
      intent: {
        ...receipt,
        paymentEvidence: { kind: 'unknown' },
      },
    });
    if (built.disposition !== 'ready') {
      throw new Error('Expected a ready synthetic receipt');
    }

    expect(
      matchReceiptToImportedTransactions(built.intent, [
        {
          ...candidate,
          accountLastFour: null,
          payeeName: 'Example Market Online',
        },
      ]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-1' },
    });
  });

  it('keeps a receipt pending before SimpleFIN exposes a candidate', () => {
    expect(matchReceiptToImportedTransactions(receipt, [])).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('waits through a pending amount and matches only after the exact posted amount appears', () => {
    const pendingAmount = {
      ...candidate,
      transactionId: 'actual-pending-1',
      importedId: 'simplefin-pending-1',
      amountMinorUnits: -1_700,
    };
    expect(
      matchReceiptToImportedTransactions(receipt, [pendingAmount]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
    expect(
      matchReceiptToImportedTransactions(receipt, [pendingAmount, candidate]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-1', amountMinorUnits: -1_725 },
    });
  });

  it('uniquely matches the later exact imported transaction', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [candidate]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-1' },
      idempotent: false,
    });
  });

  it('matches the unique exact amount through a changed store payee', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          merchantName: 'Real Atlantic Superstore',
          purchaseDate: '2026-07-26',
          totalMinorUnits: 700,
          paymentEvidence: { kind: 'unknown' },
        },
        [
          {
            ...candidate,
            postingDate: '2026-07-27',
            payeeName: 'Exampleton Superstore',
            amountMinorUnits: -700,
            accountLastFour: null,
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'matched',
      candidate: {
        postingDate: '2026-07-27',
        payeeName: 'Exampleton Superstore',
        amountMinorUnits: -700,
      },
    });
  });

  it('waits rather than claiming an identical charge posted before the purchase', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        { ...candidate, postingDate: '2026-07-27' },
      ]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('includes the seventh posting day and rejects the eighth', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        { ...candidate, postingDate: '2026-08-04' },
      ]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { postingDate: '2026-08-04' },
    });
    expect(
      matchReceiptToImportedTransactions(receipt, [
        { ...candidate, postingDate: '2026-08-05' },
      ]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('uniquely matches a USD receipt to a plausible posted CAD charge', () => {
    const usdReceipt = { ...receipt, currency: 'USD' };
    expect(
      matchReceiptToImportedTransactions(usdReceipt, [
        { ...candidate, amountMinorUnits: -2_341 },
      ]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: {
        importedId: 'simplefin-1',
        currency: 'CAD',
        amountMinorUnits: -2_341,
      },
      idempotent: false,
    });
  });

  it('asks for one-tap confirmation when a foreign receipt has no exact card evidence', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          currency: 'USD',
          paymentEvidence: { kind: 'unknown' },
        },
        [{ ...candidate, amountMinorUnits: -2_341 }],
      ),
    ).toMatchObject({
      disposition: 'ambiguous',
      candidates: [
        {
          candidate: {
            importedId: 'simplefin-1',
            amountMinorUnits: -2_341,
          },
        },
      ],
    });
  });

  it('matches a foreign receipt without card digits when the statement names the merchant and exact source amount', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          merchantName: 'PCAccessory JETech Authorized',
          currency: 'USD',
          totalMinorUnits: 1_481,
          paymentEvidence: { kind: 'unknown' },
        },
        [
          {
            ...candidate,
            payeeName: 'PAYPAL',
            statementDescription:
              'PCAccessory JETech USD $14.81 converted purchase',
            amountMinorUnits: -2_010,
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'matched',
      candidate: {
        importedId: 'simplefin-1',
        amountMinorUnits: -2_010,
      },
      idempotent: false,
    });
  });

  it('asks instead of matching a foreign statement with a different tagged source amount', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          currency: 'USD',
          paymentEvidence: { kind: 'unknown' },
        },
        [
          {
            ...candidate,
            statementDescription: 'EXAMPLE MARKET USD 17.24',
            amountMinorUnits: -2_341,
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'ambiguous',
      candidates: [
        {
          candidate: {
            importedId: 'simplefin-1',
            amountMinorUnits: -2_341,
          },
        },
      ],
    });
  });

  it('asks when two foreign candidates contain the same exact source amount', () => {
    const foreignCandidate = {
      ...candidate,
      statementDescription: 'EXAMPLE MARKET USD 17.25',
      amountMinorUnits: -2_341,
    };
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          currency: 'USD',
          paymentEvidence: { kind: 'unknown' },
        },
        [
          foreignCandidate,
          {
            ...foreignCandidate,
            transactionId: 'actual-internal-2',
            importedId: 'simplefin-2',
            payeeName: 'PAYPAL',
            statementDescription: 'EXAMPLE MARKET ONLINE USD 17.25',
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'ambiguous',
      candidates: [
        { candidate: { importedId: 'simplefin-1' } },
        { candidate: { importedId: 'simplefin-2' } },
      ],
    });
  });

  it('asks when a foreign statement conflicts with the receipt amount despite matching card digits', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          currency: 'USD',
        },
        [
          {
            ...candidate,
            statementDescription: 'EXAMPLE MARKET USD 99.99',
            amountMinorUnits: -2_341,
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'ambiguous',
      candidates: [
        {
          candidate: {
            importedId: 'simplefin-1',
            amountMinorUnits: -2_341,
          },
        },
      ],
    });
  });

  it('waits instead of linking a wildly different foreign-currency charge', () => {
    expect(
      matchReceiptToImportedTransactions({ ...receipt, currency: 'USD' }, [
        { ...candidate, amountMinorUnits: -20_000 },
      ]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('requires merchant evidence and rejects a wrong card for foreign receipts', () => {
    const usdReceipt = { ...receipt, currency: 'USD' };
    expect(
      matchReceiptToImportedTransactions(usdReceipt, [
        { ...candidate, amountMinorUnits: -2_341, payeeName: null },
        {
          ...candidate,
          transactionId: 'actual-internal-2',
          importedId: 'simplefin-2',
          amountMinorUnits: -2_341,
          accountLastFour: '9999',
        },
      ]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('is idempotent when the same receipt is already linked', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        {
          ...candidate,
          alreadyLinkedReceipts: [linkedSource(receipt.receiptId)],
        },
      ]),
    ).toMatchObject({
      disposition: 'matched',
      idempotent: true,
    });
  });

  it('trusts an existing receipt link over stale card evidence during reconciliation', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        {
          ...candidate,
          accountLastFour: '9999',
          alreadyLinkedReceipts: [linkedSource(receipt.receiptId)],
        },
      ]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-1' },
      idempotent: true,
    });
  });

  it('does not reuse a transaction already linked to another receipt', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        {
          ...candidate,
          alreadyLinkedReceipts: [
            linkedSource('40601103-a7ad-4bd9-bfad-f62309bb047a'),
          ],
        },
      ]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('matches a unique same-account subset of up to six charges', () => {
    const splitReceipt = {
      ...receipt,
      merchantName: 'Mountain Equipment Company',
      purchaseDate: '2026-07-12',
      totalMinorUnits: 8_542,
      paymentEvidence: { kind: 'unknown' as const },
    };
    const parts = [
      {
        ...candidate,
        transactionId: 'mec-1',
        importedId: 'mec-import-1',
        postingDate: '2026-07-13',
        payeeName: 'MEC',
        accountLastFour: null,
        amountMinorUnits: -2_844,
      },
      {
        ...candidate,
        transactionId: 'mec-2',
        importedId: 'mec-import-2',
        postingDate: '2026-07-13',
        payeeName: 'MEC',
        accountLastFour: null,
        amountMinorUnits: -2_849,
      },
      {
        ...candidate,
        transactionId: 'mec-3',
        importedId: 'mec-import-3',
        postingDate: '2026-07-14',
        payeeName: 'MEC',
        accountLastFour: null,
        amountMinorUnits: -2_849,
      },
    ];

    expect(
      matchReceiptToImportedTransactions(splitReceipt, parts),
    ).toMatchObject({
      disposition: 'matched-set',
      candidates: [
        { importedId: 'mec-import-1' },
        { importedId: 'mec-import-2' },
        { importedId: 'mec-import-3' },
      ],
      idempotent: false,
    });
  });

  it('rejects an unrelated exact-total charge and finds the merchant-matching subset', () => {
    const splitReceipt = {
      ...receipt,
      merchantName: 'Mountain Equipment Company',
      purchaseDate: '2026-07-12',
      totalMinorUnits: 8_542,
      paymentEvidence: { kind: 'unknown' as const },
    };
    const candidates = [
      {
        ...candidate,
        transactionId: 'wrong-full-charge',
        importedId: 'wrong-full-charge',
        postingDate: '2026-07-12',
        payeeName: 'Unrelated Hotel',
        accountLastFour: null,
        amountMinorUnits: -8_542,
      },
      ...[2_844, 2_849, 2_849].map((amount, index) => ({
        ...candidate,
        transactionId: `mec-part-${String(index)}`,
        importedId: `mec-part-${String(index)}`,
        postingDate: index === 2 ? '2026-07-14' : '2026-07-13',
        payeeName: 'MEC',
        accountLastFour: null,
        amountMinorUnits: -amount,
      })),
    ];

    expect(
      matchReceiptToImportedTransactions(splitReceipt, candidates),
    ).toMatchObject({
      disposition: 'matched-set',
      candidates: [
        { importedId: 'mec-part-0' },
        { importedId: 'mec-part-1' },
        { importedId: 'mec-part-2' },
      ],
      idempotent: false,
    });
  });

  it('does not auto-match when more than one subset has the exact total', () => {
    const parts = [400, 600, 500, 500].map((amount, index) => ({
      ...candidate,
      transactionId: `subset-${String(index)}`,
      importedId: `subset-import-${String(index)}`,
      payeeName: 'Example Market',
      amountMinorUnits: -amount,
    }));
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          totalMinorUnits: 1_000,
          paymentEvidence: { kind: 'unknown' },
        },
        parts,
      ),
    ).toMatchObject({
      disposition: 'ambiguous-set',
      candidateSets: [
        {
          candidates: [{ amountMinorUnits: -400 }, { amountMinorUnits: -600 }],
        },
        {
          candidates: [{ amountMinorUnits: -500 }, { amountMinorUnits: -500 }],
        },
      ],
    });
  });

  it('prefers the exact plural set already linked in Actual during rebuild', () => {
    const rebuildingReceipt = {
      ...receipt,
      totalMinorUnits: 1_000,
      paymentEvidence: { kind: 'unknown' as const },
    };
    const parts = [
      { amount: 1_000, importedId: 'unrelated-full', linked: false },
      { amount: 500, importedId: 'alternative-a', linked: false },
      { amount: 500, importedId: 'alternative-b', linked: false },
      { amount: 400, importedId: 'linked-z-a', linked: true },
      { amount: 600, importedId: 'linked-z-b', linked: true },
    ].map(({ amount, importedId, linked }, index) => ({
      ...candidate,
      transactionId: `rebuild-subset-${String(index)}`,
      importedId,
      payeeName: 'Example Market',
      amountMinorUnits: -amount,
      alreadyLinkedReceipts: linked ? [linkedSource(receipt.receiptId)] : [],
    }));

    expect(
      matchReceiptToImportedTransactions(rebuildingReceipt, parts),
    ).toMatchObject({
      disposition: 'matched-set',
      candidates: [{ importedId: 'linked-z-a' }, { importedId: 'linked-z-b' }],
      idempotent: true,
    });
  });

  it('asks for clarification when two candidates are equally plausible', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        candidate,
        {
          ...candidate,
          transactionId: 'actual-internal-2',
          importedId: 'simplefin-2',
        },
      ]),
    ).toMatchObject({
      disposition: 'ambiguous',
      candidates: [
        { candidate: { importedId: 'simplefin-1' } },
        { candidate: { importedId: 'simplefin-2' } },
      ],
    });
  });

  it.each([
    {
      name: 'wrong amount',
      patch: { amountMinorUnits: -1_700 },
    },
    {
      name: 'wrong card',
      patch: { accountLastFour: '9999' },
    },
    {
      name: 'outside date window',
      patch: { postingDate: '2026-08-10' },
    },
  ])('does not guess from a $name candidate', ({ patch }) => {
    expect(
      matchReceiptToImportedTransactions(receipt, [{ ...candidate, ...patch }]),
    ).toEqual({
      disposition: 'pending',
      plausibleCandidateCount: 0,
    });
  });

  it('uses an exact card match only when merchant text is unavailable', () => {
    expect(
      matchReceiptToImportedTransactions(receipt, [
        {
          ...candidate,
          payeeName: null,
        },
      ]),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-1' },
    });
  });

  it('uses a fuzzy sanitized statement description when the payee is only a processor', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          merchantName: 'Amazon.com.ca ULC',
          paymentEvidence: { kind: 'unknown' },
        },
        [
          {
            ...candidate,
            payeeName: 'PAYPAL',
            statementDescription: 'AMZN MKTP CA purchase',
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-1' },
    });
  });

  it('uses merchant evidence to break a tie between exact amounts', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          merchantName: 'Shop',
          paymentEvidence: { kind: 'unknown' },
        },
        [
          {
            ...candidate,
            payeeName: null,
            statementDescription: 'Workshop Tools',
          },
          {
            ...candidate,
            transactionId: 'actual-internal-2',
            importedId: 'simplefin-2',
            payeeName: 'Shop',
          },
        ],
      ),
    ).toMatchObject({
      disposition: 'matched',
      candidate: { importedId: 'simplefin-2', payeeName: 'Shop' },
    });
  });

  it('routes cash receipts to an explicit manual flow', () => {
    expect(
      matchReceiptToImportedTransactions(
        {
          ...receipt,
          paymentEvidence: { kind: 'cash' },
        },
        [candidate],
      ),
    ).toEqual({ disposition: 'manual', reason: 'cash' });
  });

  it.each([
    'amounts-unclear' as const,
    'split-tender' as const,
    'combined-charge' as const,
    'reimbursement' as const,
  ])('does not build a match intent for model-identified %s', (code) => {
    const proposal = receiptProposal();
    proposal.uncertainties.push({
      code,
      message: 'Synthetic manual-review condition',
      material: true,
      sourcePage: 1,
    });

    expect(
      buildExtractedReceiptMatchIntent(receipt.receiptId, proposal),
    ).toEqual({
      disposition: 'review',
      reason: 'receipt-not-ready',
    });
  });
});
