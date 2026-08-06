import { describe, expect, it } from 'vitest';

import {
  evaluateReceiptCategorization,
  resolveReceiptCategorizationClarification,
  type CategoryTaxonomy,
  type ReceiptCategoryProposal,
} from '../../src/categorization/index.js';
import type { HouseholdFinanceActiveReceiptRecordV1 } from '../../src/receipt-record/index.js';

const sourceSha256 = 'a'.repeat(64);
const receipt: HouseholdFinanceActiveReceiptRecordV1 = {
  schemaVersion: 'household-finance.receipt.v1',
  receiptId: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  createdAt: '2026-07-28T12:00:00.000-03:00',
  updatedAt: '2026-07-28T12:00:00.000-03:00',
  sources: [
    {
      nextcloudFileId: '2001',
      archivePath: 'Receipts/example.jpg',
      sha256: sourceSha256,
      mediaType: 'image/jpeg',
      receivedAt: '2026-07-28T12:00:00.000-03:00',
      talk: {
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '2001',
      },
    },
  ],
  status: 'active',
  merchant: 'Example Market',
  purchaseDate: '2026-07-28',
  purchaseTime: '12:00:00',
  timezoneOffset: '-03:00',
  currency: 'CAD',
  amounts: {
    subtotalMinor: 1_500,
    taxMinor: 225,
    discountMinor: 0,
    tipMinor: 0,
    totalMinor: 1_725,
  },
  paymentEvidence: {
    kind: 'unknown',
    lastFour: null,
  },
  receiptReference: null,
  items: [
    {
      description: 'Cable',
      quantity: 1,
      unitPriceMinor: 1_000,
      totalMinor: 1_000,
    },
    {
      description: 'Paper',
      quantity: 2,
      unitPriceMinor: 250,
      totalMinor: 500,
    },
  ],
  extraction: {
    provider: 'xai',
    requestedModel: 'grok-4.5',
    resolvedModel: 'grok-4.5',
    zeroDataRetention: true,
    extractedAt: '2026-07-28T12:00:00.000-03:00',
    sourceSha256s: [sourceSha256],
  },
};

const taxonomy: CategoryTaxonomy = {
  schemaVersion: 'household-category-taxonomy.v1',
  currency: 'CAD',
  categories: [
    {
      alias: 'home-supplies',
      name: 'Home supplies',
      description: 'Supplies used in the household.',
      kind: 'expense',
      modelSelectable: true,
    },
    {
      alias: 'office',
      name: 'Office',
      description: 'Office supplies.',
      kind: 'expense',
      modelSelectable: true,
    },
  ],
};

const categories: ReceiptCategoryProposal = {
  schemaVersion: 'receipt-category-proposal.v1',
  items: [
    { itemIndex: 0, categoryAlias: 'home-supplies', confidence: 1 },
    { itemIndex: 1, categoryAlias: 'office', confidence: 1 },
  ],
  uncertainties: [],
};

describe('receipt categorization', () => {
  it('allocates receipt adjustments deterministically in integer cents', () => {
    expect(
      evaluateReceiptCategorization(receipt, categories, taxonomy),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
  });

  it('allocates a Costco-style net subtotal with complete gross item rows', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          amounts: {
            subtotalMinor: 1_300,
            taxMinor: 195,
            discountMinor: 200,
            tipMinor: 0,
            totalMinor: 1_495,
          },
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_495,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 997 },
        { categoryAlias: 'office', amountMinorUnits: 498 },
      ],
    });
  });

  it('does not add tax twice when extracted line items already sum to the total', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          items: [
            {
              ...receipt.items[0]!,
              unitPriceMinor: 1_150,
              totalMinor: 1_150,
            },
            {
              ...receipt.items[1]!,
              unitPriceMinor: 575,
              totalMinor: 575,
            },
          ],
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
  });

  it('omits a zero-value item instead of creating an invalid zero-dollar split', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          items: [
            {
              ...receipt.items[0]!,
              unitPriceMinor: 1_725,
              totalMinor: 1_725,
            },
            {
              ...receipt.items[1]!,
              unitPriceMinor: 0,
              totalMinor: 0,
            },
          ],
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
    });
  });

  it('keeps a fully discounted receipt out of an empty ready split', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          amounts: {
            subtotalMinor: 1_500,
            taxMinor: 0,
            discountMinor: 1_500,
            tipMinor: 0,
            totalMinor: 0,
          },
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['receipt-not-ready'],
    });
  });

  it('categorizes a reconciled receipt with absent optional amounts', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          amounts: {
            ...receipt.amounts,
            taxMinor: null,
            discountMinor: null,
            tipMinor: null,
            totalMinor: 1_500,
          },
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_500,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_000 },
        { categoryAlias: 'office', amountMinorUnits: 500 },
      ],
    });
  });

  it('does not categorize a canonical receipt marked unsafe by extraction', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          extraction: {
            ...receipt.extraction,
            automaticProcessingBlocked: true,
          },
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['receipt-not-ready'],
    });
  });

  it('categorizes a foreign-currency receipt in its source minor units', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          currency: 'USD',
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
  });

  it('requires exactly one allowed classification for every item', () => {
    expect(
      evaluateReceiptCategorization(
        receipt,
        {
          ...categories,
          items: [
            categories.items[0]!,
            categories.items[0]!,
            {
              itemIndex: 1,
              categoryAlias: 'not-allowed',
              confidence: 1,
            },
          ],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: [
        'category-not-allowed',
        'classification-incomplete',
        'duplicate-item-classification',
      ],
    });
  });

  it('stops on material category uncertainty', () => {
    expect(
      evaluateReceiptCategorization(
        receipt,
        {
          ...categories,
          uncertainties: [
            {
              itemIndex: 1,
              message: 'The item could be office or household use.',
              material: true,
            },
          ],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['classification-uncertain'],
    });
  });

  it('uses the model best fit even when its descriptive confidence is low', () => {
    expect(
      evaluateReceiptCategorization(
        receipt,
        {
          ...categories,
          items: [
            categories.items[0]!,
            { ...categories.items[1]!, confidence: 0.79 },
          ],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
  });

  it('uses one whole-receipt category when the header is reliable but no item rows were extractable', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          items: [],
          extraction: {
            ...receipt.extraction,
            itemSplitBlocked: true,
          },
        },
        {
          schemaVersion: 'receipt-category-proposal.v1',
          wholeReceiptCategoryAlias: 'home-supplies',
          items: [],
          uncertainties: [],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
    });
  });

  it('uses one whole-receipt category when partial item rows cannot support an exact split', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          items: [
            receipt.items[0]!,
            { ...receipt.items[1]!, totalMinor: null },
          ],
          extraction: {
            ...receipt.extraction,
            itemSplitBlocked: true,
          },
        },
        {
          schemaVersion: 'receipt-category-proposal.v1',
          wholeReceiptCategoryAlias: 'home-supplies',
          items: [],
          uncertainties: [],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
    });
  });

  it('uses a whole-receipt category when item amounts add up but the extraction marks the rows unclear', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          extraction: {
            ...receipt.extraction,
            itemSplitBlocked: true,
          },
        },
        {
          schemaVersion: 'receipt-category-proposal.v1',
          wholeReceiptCategoryAlias: 'home-supplies',
          items: [],
          uncertainties: [],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
    });
  });

  it('asks for one whole-purchase category when partial item rows are ambiguous', () => {
    const partialReceipt: HouseholdFinanceActiveReceiptRecordV1 = {
      ...receipt,
      items: [receipt.items[0]!, { ...receipt.items[1]!, totalMinor: null }],
    };
    const incomplete: ReceiptCategoryProposal = {
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: null,
      items: [],
      uncertainties: [
        {
          itemIndex: null,
          message: 'The whole purchase purpose is unclear.',
          material: true,
        },
      ],
    };
    const review = evaluateReceiptCategorization(
      partialReceipt,
      incomplete,
      taxonomy,
    );
    expect(review).toEqual({
      disposition: 'review',
      issueCodes: ['classification-incomplete', 'classification-uncertain'],
    });
    if (review.disposition !== 'review') {
      throw new Error('Expected a review result');
    }

    expect(
      resolveReceiptCategorizationClarification(
        partialReceipt,
        incomplete,
        review,
        'office',
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [{ categoryAlias: 'office', amountMinorUnits: 1_725 }],
    });
  });

  it('does not guess a whole-receipt category when the model has no clear purpose', () => {
    expect(
      evaluateReceiptCategorization(
        { ...receipt, items: [] },
        {
          schemaVersion: 'receipt-category-proposal.v1',
          wholeReceiptCategoryAlias: null,
          items: [],
          uncertainties: [
            {
              itemIndex: null,
              message: 'The purchase purpose is unclear.',
              material: true,
            },
          ],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['classification-incomplete', 'classification-uncertain'],
    });
  });

  it('keeps item categorization strict when a whole-receipt category is also proposed', () => {
    expect(
      evaluateReceiptCategorization(
        receipt,
        {
          ...categories,
          wholeReceiptCategoryAlias: 'home-supplies',
          items: [],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['classification-incomplete'],
    });
  });

  it('ignores an illegal whole-receipt alias when the complete item map is valid', () => {
    expect(
      evaluateReceiptCategorization(
        receipt,
        {
          ...categories,
          wholeReceiptCategoryAlias: 'not-allowed',
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
  });

  it('clarifies only missing item categories when an itemized proposal also contains a whole-receipt alias', () => {
    const incomplete: ReceiptCategoryProposal = {
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: 'not-allowed',
      items: [categories.items[0]!],
      uncertainties: [
        {
          itemIndex: 1,
          message: 'The second item purpose is unclear.',
          material: true,
        },
      ],
    };
    const review = evaluateReceiptCategorization(receipt, incomplete, taxonomy);
    expect(review).toEqual({
      disposition: 'review',
      issueCodes: ['classification-incomplete', 'classification-uncertain'],
    });
    if (review.disposition !== 'review') {
      throw new Error('Expected a review result');
    }

    expect(
      resolveReceiptCategorizationClarification(
        receipt,
        incomplete,
        review,
        'office',
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [
        { categoryAlias: 'home-supplies', amountMinorUnits: 1_150 },
        { categoryAlias: 'office', amountMinorUnits: 575 },
      ],
    });
  });

  it('does not let missing item rows bypass a material receipt-level problem', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          items: [],
          extraction: {
            ...receipt.extraction,
            automaticProcessingBlocked: true,
            itemSplitBlocked: true,
          },
        },
        {
          schemaVersion: 'receipt-category-proposal.v1',
          wholeReceiptCategoryAlias: 'home-supplies',
          items: [],
          uncertainties: [],
        },
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['receipt-not-ready'],
    });
  });

  it('turns a category clarification into a whole-receipt split when there are no item rows', () => {
    const zeroItemReceipt = { ...receipt, items: [] };
    const incomplete: ReceiptCategoryProposal = {
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: null,
      items: [],
      uncertainties: [
        {
          itemIndex: null,
          message: 'The purchase purpose is unclear.',
          material: true,
        },
      ],
    };
    const review = evaluateReceiptCategorization(
      zeroItemReceipt,
      incomplete,
      taxonomy,
    );
    expect(review.disposition).toBe('review');
    if (review.disposition !== 'review') {
      throw new Error('Expected a review result');
    }

    expect(
      resolveReceiptCategorizationClarification(
        zeroItemReceipt,
        incomplete,
        review,
        'home-supplies',
      ),
    ).toEqual({
      disposition: 'ready',
      totalMinorUnits: 1_725,
      splits: [{ categoryAlias: 'home-supplies', amountMinorUnits: 1_725 }],
    });
  });

  it('does not categorize a receipt whose extraction is not ready', () => {
    expect(
      evaluateReceiptCategorization(
        {
          ...receipt,
          amounts: {
            ...receipt.amounts,
            totalMinor: 1_700,
          },
          extraction: {
            ...receipt.extraction,
            automaticProcessingBlocked: true,
          },
        },
        categories,
        taxonomy,
      ),
    ).toEqual({
      disposition: 'review',
      issueCodes: ['receipt-not-ready'],
    });
  });
});
