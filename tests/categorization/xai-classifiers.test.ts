import { describe, expect, it, vi } from 'vitest';

import {
  evaluateReceiptCategorization,
  resolveReceiptCategorizationClarification,
  XaiReceiptItemCategoryClassifier,
  XaiTransactionCategoryClassifier,
  type CategoryTaxonomy,
  type StructuredCategorizationClient,
} from '../../src/categorization/index.js';
import type { XaiStructuredRun } from '../../src/model/xai-structured-client.js';
import type { HouseholdFinanceActiveReceiptRecordV1 } from '../../src/receipt-record/index.js';

const metadata = {
  provider: 'xai' as const,
  requestedModel: 'grok-4.5' as const,
  resolvedModel: 'grok-4.5' as const,
  preflightAttempts: 1,
  requestAttempts: 1,
  durationMs: 10,
  zeroDataRetention: true as const,
  usage: { costInUsdTicks: 1 },
};

const taxonomy: CategoryTaxonomy = {
  schemaVersion: 'household-category-taxonomy.v1',
  currency: 'CAD',
  categories: [
    {
      alias: 'groceries',
      name: 'Groceries',
      description: 'Food and household groceries.',
      kind: 'expense',
      modelSelectable: true,
    },
    {
      alias: 'income',
      name: 'Household Income',
      description: 'Employment and other ordinary household income.',
      kind: 'income',
      modelSelectable: true,
    },
  ],
};

function clientReturning(value: unknown): {
  client: StructuredCategorizationClient;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async (): Promise<XaiStructuredRun> => ({
    value,
    metadata,
  }));
  return { client: { run }, run };
}

function receiptFixture(): HouseholdFinanceActiveReceiptRecordV1 {
  const sourceSha256 = 'a'.repeat(64);
  return {
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
    purchaseTime: null,
    timezoneOffset: null,
    currency: 'CAD',
    amounts: {
      subtotalMinor: 1_000,
      taxMinor: 150,
      discountMinor: 0,
      tipMinor: 0,
      totalMinor: 1_150,
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
    },
    receiptReference: null,
    items: [
      {
        description: 'Milk',
        quantity: 1,
        unitPriceMinor: 1_000,
        totalMinor: 1_000,
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
}

describe('xAI categorization classifiers', () => {
  it('sends only minimum alias-level transaction fields', async () => {
    const fake = clientReturning({
      schemaVersion: 'transaction-category-proposal.v1',
      disposition: 'category',
      categoryAlias: 'groceries',
      confidence: 0.9,
      reason: 'The merchant is a grocery store.',
    });
    const classifier = new XaiTransactionCategoryClassifier(fake.client);

    await expect(
      classifier.classify(
        {
          schemaVersion: 'transaction-categorization-observation.v1',
          date: '2026-07-28',
          accountAlias: 'active-card',
          amountMinorUnits: -1_725,
          direction: 'expense',
          payeeName: 'Example Market',
          memo: 'POS purchase',
          specialKind: 'ordinary',
          currentCategoryAlias: null,
          originalRefundCategoryAlias: null,
        },
        taxonomy,
      ),
    ).resolves.toMatchObject({
      proposal: { categoryAlias: 'groceries' },
      metadata: { zeroDataRetention: true },
    });

    const payload = fake.run.mock.calls[0]?.[0].payload;
    expect(payload).toEqual({
      transaction: {
        date: '2026-07-28',
        accountRoleAlias: 'active-card',
        amountMinorUnits: -1_725,
        direction: 'expense',
        merchant: 'Example Market',
        memo: 'POS purchase',
      },
      allowedCategories: [
        {
          alias: 'groceries',
          name: 'Groceries',
          description: 'Food and household groceries.',
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('transactionId');
    expect(JSON.stringify(payload)).not.toContain('importedId');
    const request = fake.run.mock.calls[0]?.[0];
    expect(request.schemaName).toBe('transaction_category_selection_v1');
    expect(JSON.stringify(request.schema)).not.toContain('clarification');
    expect(request.systemPrompt).toContain(
      'Return exactly one best-fit category and an honest confidence',
    );
    expect(request.systemPrompt).toContain(
      'Use everyday-shopping for routine non-food household or personal goods',
    );
    expect(request.systemPrompt).toContain(
      'Use lower confidence when the merchant is multi-purpose',
    );
  });

  it('rejects unsupported clarification output at the live model boundary', async () => {
    const fake = clientReturning({
      schemaVersion: 'transaction-category-proposal.v1',
      disposition: 'clarification',
      question: 'Which category should I use?',
    });
    const classifier = new XaiTransactionCategoryClassifier(fake.client);

    await expect(
      classifier.classify(
        {
          schemaVersion: 'transaction-categorization-observation.v1',
          date: '2026-07-28',
          accountAlias: 'active-card',
          amountMinorUnits: -1_725,
          direction: 'expense',
          payeeName: 'Unknown Merchant',
          memo: null,
          specialKind: 'ordinary',
          currentCategoryAlias: null,
          originalRefundCategoryAlias: null,
        },
        taxonomy,
      ),
    ).rejects.toThrow();
  });

  it('offers an ordinary income transaction only income-category aliases', async () => {
    const fake = clientReturning({
      schemaVersion: 'transaction-category-proposal.v1',
      disposition: 'category',
      categoryAlias: 'income',
      confidence: 0.99,
      reason: 'The payee and memo describe employment income.',
    });
    const classifier = new XaiTransactionCategoryClassifier(fake.client);

    await expect(
      classifier.classify(
        {
          schemaVersion: 'transaction-categorization-observation.v1',
          date: '2026-07-28',
          accountAlias: 'primary-chequing',
          amountMinorUnits: 250_000,
          direction: 'income',
          payeeName: 'Example Employer',
          memo: 'Payroll deposit',
          specialKind: 'ordinary',
          currentCategoryAlias: null,
          originalRefundCategoryAlias: null,
        },
        taxonomy,
      ),
    ).resolves.toMatchObject({
      proposal: { categoryAlias: 'income' },
    });

    expect(fake.run.mock.calls[0]?.[0].payload.allowedCategories).toEqual([
      {
        alias: 'income',
        name: 'Household Income',
        description: 'Employment and other ordinary household income.',
      },
    ]);
    expect(fake.run.mock.calls[0]?.[0].systemPrompt).toContain(
      'This tool does classify ordinary income, including a payroll deposit',
    );
    expect(fake.run.mock.calls[0]?.[0].systemPrompt).not.toContain(
      'refunds, or income',
    );
  });

  it('classifies receipt item labels without raw documents or ledger IDs', async () => {
    const fake = clientReturning({
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: null,
      items: [{ itemIndex: 0, categoryAlias: 'groceries', confidence: 0.95 }],
      uncertainties: [],
    });
    const classifier = new XaiReceiptItemCategoryClassifier(fake.client);
    const receipt = receiptFixture();
    receipt.householdNotes = [
      {
        text: "Elia's birthday present.",
        receivedAt: receipt.createdAt,
        talk: {
          roomToken: 'household-finance',
          actorId: 'alex',
          messageId: '2002',
        },
      },
    ];

    const classified = await classifier.classify(receipt, taxonomy);
    expect(classified).toMatchObject({
      proposal: { items: [{ categoryAlias: 'groceries' }] },
    });
    expect(classified.proposal).not.toHaveProperty('wholeReceiptCategoryAlias');
    const payload = fake.run.mock.calls[0]?.[0].payload;
    expect(payload.householdNotes).toEqual(["Elia's birthday present."]);
    expect(payload.itemAllocationAvailable).toBe(true);
    expect(payload.allowedCategories).toEqual([
      {
        alias: 'groceries',
        name: 'Groceries',
        description: 'Food and household groceries.',
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain('sourcePage');
    expect(JSON.stringify(payload)).not.toContain('actual');
    expect(JSON.stringify(payload)).not.toContain('receiptReference');
    expect(fake.run.mock.calls[0]?.[0].systemPrompt).toContain(
      'optional captions in chronological order',
    );
    expect(fake.run.mock.calls[0]?.[0].systemPrompt).toContain(
      'later clear correction override',
    );
    expect(fake.run.mock.calls[0]?.[0].systemPrompt).toContain(
      'merchant, readable item descriptions, or a clear authenticated household note',
    );
    expect(JSON.stringify(fake.run.mock.calls[0]?.[0].schema)).toContain(
      'wholeReceiptCategoryAlias',
    );
    expect(fake.run.mock.calls[0]?.[0].maxOutputTokens).toBe(4_096);
    expect(fake.run.mock.calls[0]?.[0]).not.toHaveProperty('webSearch');

    const zeroItemFake = clientReturning({
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: 'groceries',
      items: [],
      uncertainties: [],
    });
    const zeroItemClassifier = new XaiReceiptItemCategoryClassifier(
      zeroItemFake.client,
    );
    await expect(
      zeroItemClassifier.classify(
        {
          ...receipt,
          items: [],
          householdNotes: [
            {
              text: 'The whole purchase was groceries.',
              receivedAt: receipt.createdAt,
              talk: {
                roomToken: 'household-finance',
                actorId: 'alex',
                messageId: '2003',
              },
            },
          ],
        },
        taxonomy,
      ),
    ).resolves.toMatchObject({
      proposal: {
        wholeReceiptCategoryAlias: 'groceries',
        items: [],
      },
    });
    expect(zeroItemFake.run.mock.calls[0]?.[0].payload).toMatchObject({
      itemAllocationAvailable: false,
      householdNotes: ['The whole purchase was groceries.'],
      items: [],
    });
  });

  it('offers bounded web search for opaque Costco item labels', async () => {
    const fake = clientReturning({
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: null,
      items: [{ itemIndex: 0, categoryAlias: 'groceries', confidence: 0.95 }],
      uncertainties: [],
    });
    const receipt = receiptFixture();
    receipt.merchant = 'Costco Wholesale';
    receipt.items[0] = {
      ...receipt.items[0]!,
      description: '253230 DRUMSTK',
    };

    await new XaiReceiptItemCategoryClassifier(fake.client).classify(
      receipt,
      taxonomy,
    );

    const request = fake.run.mock.calls[0]?.[0];
    expect(request.webSearch).toEqual({ maxTurns: 3, maxToolCalls: 24 });
    expect(request.systemPrompt).toContain(
      'Search the exact code with the raw abbreviation and Costco Canada',
    );
    expect(request.systemPrompt).toContain(
      'never use them to alter the receipt merchant, date, currency, amounts, item count, or matching facts',
    );
    expect(request.systemPrompt).toContain(
      'vouchers, coupons, and instant-savings rows are adjustments rather than separate purchases',
    );
  });

  it('does not search merely because the merchant is Costco', async () => {
    const fake = clientReturning({
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: null,
      items: [{ itemIndex: 0, categoryAlias: 'groceries', confidence: 0.95 }],
      uncertainties: [],
    });
    const receipt = receiptFixture();
    receipt.merchant = 'Costco Wholesale';
    receipt.items[0] = {
      ...receipt.items[0]!,
      description: 'WHOLE MILK',
    };

    await new XaiReceiptItemCategoryClassifier(fake.client).classify(
      receipt,
      taxonomy,
    );

    expect(fake.run.mock.calls[0]?.[0]).not.toHaveProperty('webSearch');
  });

  it('turns unusable item classifications into one resolvable review', async () => {
    const receipt = receiptFixture();
    receipt.items = [
      {
        ...receipt.items[0]!,
        description: 'Milk',
        unitPriceMinor: 500,
        totalMinor: 500,
      },
      {
        ...receipt.items[0]!,
        description: 'Bread',
        unitPriceMinor: 500,
        totalMinor: 500,
      },
    ];
    const fake = clientReturning({
      schemaVersion: 'receipt-category-proposal.v1',
      wholeReceiptCategoryAlias: null,
      items: [
        {
          itemIndex: 0,
          categoryAlias: 'not-allowed',
          confidence: 0.9,
        },
        { itemIndex: 1, categoryAlias: 'groceries', confidence: 0.9 },
        { itemIndex: 1, categoryAlias: 'groceries', confidence: 0.8 },
        { itemIndex: 7, categoryAlias: 'groceries', confidence: 0.9 },
      ],
      uncertainties: [],
    });
    const classifier = new XaiReceiptItemCategoryClassifier(fake.client);

    const classified = await classifier.classify(receipt, taxonomy);

    expect(classified.proposal).toEqual({
      schemaVersion: 'receipt-category-proposal.v1',
      items: [],
      uncertainties: [
        {
          itemIndex: 0,
          message:
            'The model did not return one usable allowed category for every receipt item.',
          material: true,
        },
      ],
    });
    const review = evaluateReceiptCategorization(
      receipt,
      classified.proposal,
      taxonomy,
    );
    expect(review).toEqual({
      disposition: 'review',
      issueCodes: ['classification-incomplete', 'classification-uncertain'],
    });
    if (review.disposition !== 'review') {
      throw new Error('Expected a resolvable review');
    }
    expect(
      resolveReceiptCategorizationClarification(
        receipt,
        classified.proposal,
        review,
        'groceries',
      ),
    ).toEqual({
      disposition: 'ready',
      splits: [{ categoryAlias: 'groceries', amountMinorUnits: 1_150 }],
      totalMinorUnits: 1_150,
    });
  });
});
