import { describe, expect, it } from 'vitest';

import {
  decideTransactionCategorization,
  type CategoryTaxonomy,
  type TransactionCategorizationObservation,
} from '../../src/categorization/index.js';
import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from '../../src/context/index.js';

const now = '2026-07-28T12:00:00-03:00';
const provenance = {
  source: 'talk-confirmed' as const,
  actorId: 'alex',
  messageId: '100',
  recordedAt: now,
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
      alias: 'everyday-shopping',
      name: 'Everyday Shopping',
      description: 'Routine non-food household and personal purchases.',
      kind: 'expense',
      modelSelectable: true,
    },
    {
      alias: 'cashback',
      name: 'Cashback',
      description: 'Credit-card cashback income.',
      kind: 'income',
      modelSelectable: true,
    },
    {
      alias: 'savings',
      name: 'Savings',
      description: 'Transfers into household savings.',
      kind: 'savings',
      modelSelectable: false,
    },
  ],
};
const profile: HouseholdProfile = {
  ...createEmptyHouseholdProfile(now),
  merchantRules: [
    {
      id: 'example-market',
      merchantPattern: 'Example Market',
      categoryAlias: 'groceries',
      applicationCount: 2,
      correctionCount: 0,
      status: 'confirmed',
      provenance,
    },
  ],
};
const observation: TransactionCategorizationObservation = {
  schemaVersion: 'transaction-categorization-observation.v1',
  date: '2026-07-28',
  accountAlias: 'spending-card',
  amountMinorUnits: -1_725,
  direction: 'expense',
  payeeName: 'EXAMPLE   MARKET',
  memo: null,
  specialKind: 'ordinary',
  currentCategoryAlias: null,
  originalRefundCategoryAlias: null,
};

function decide(patch: Partial<TransactionCategorizationObservation> = {}) {
  return decideTransactionCategorization({
    observation: { ...observation, ...patch },
    profile,
    taxonomy,
    specialCategoryAliases: { cashback: 'cashback' },
    now,
  });
}

describe('transaction categorization decision', () => {
  it.each(['transfer', 'card-payment', 'debt-payment'] as const)(
    'excludes %s from expense categorization',
    (specialKind) => {
      expect(decide({ specialKind })).toEqual({
        disposition: 'ignore',
        reason: specialKind,
      });
    },
  );

  it('uses exact normalized confirmed merchant rules before the model', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Example Market',
        },
        profile,
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'not-allowed',
          confidence: 1,
          reason: 'This value must be ignored because a rule already exists.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'apply',
      categoryAlias: 'groceries',
      source: 'confirmed-merchant-rule',
    });
  });

  it('ignores an exact normalized payee matched by a confirmed transaction rule before merchant and model categorization', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'TANGERINE   MASTERCARD PAYMENT',
        },
        profile: {
          ...profile,
          transactionRules: [
            {
              id: 'mastercard-payment',
              payeePattern: 'Tangerine Mastercard Payment',
              specialKind: 'card-payment',
              status: 'confirmed',
              provenance,
            },
          ],
          merchantRules: [
            {
              ...profile.merchantRules[0]!,
              merchantPattern: 'Tangerine Mastercard Payment',
            },
          ],
        },
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'groceries',
          confidence: 1,
          reason: 'This proposal must not override a transaction rule.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'ignore',
      reason: 'card-payment',
    });
  });

  it('ignores duplicate same-kind transaction rules but clarifies conflicting active rules', () => {
    const transactionRule = {
      id: 'bank-transfer-one',
      payeePattern: 'Internal Move',
      specialKind: 'transfer' as const,
      status: 'confirmed' as const,
      provenance,
    };
    const decisionInput = {
      observation: {
        ...observation,
        payeeName: 'internal-move',
      },
      taxonomy,
      specialCategoryAliases: { cashback: 'cashback' },
      now,
    };

    expect(
      decideTransactionCategorization({
        ...decisionInput,
        profile: {
          ...profile,
          merchantRules: [],
          transactionRules: [
            transactionRule,
            { ...transactionRule, id: 'bank-transfer-two' },
          ],
        },
      }),
    ).toEqual({
      disposition: 'ignore',
      reason: 'transfer',
    });

    expect(
      decideTransactionCategorization({
        ...decisionInput,
        profile: {
          ...profile,
          merchantRules: [],
          transactionRules: [
            transactionRule,
            {
              ...transactionRule,
              id: 'debt-payment',
              specialKind: 'debt-payment',
            },
          ],
        },
      }),
    ).toEqual({
      disposition: 'clarify',
      reason: 'merchant-rule-conflict',
    });
  });

  it('does not apply candidate, future, or expired transaction rules', () => {
    const rules = [
      {
        id: 'candidate-rule',
        payeePattern: 'Different Merchant',
        specialKind: 'transfer' as const,
        status: 'candidate' as const,
        provenance,
      },
      {
        id: 'future-rule',
        payeePattern: 'Different Merchant',
        specialKind: 'card-payment' as const,
        status: 'confirmed' as const,
        validFrom: '2026-07-29',
        provenance,
      },
      {
        id: 'expired-rule',
        payeePattern: 'Different Merchant',
        specialKind: 'debt-payment' as const,
        status: 'confirmed' as const,
        expiresAt: now,
        provenance,
      },
    ];

    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Different Merchant',
        },
        profile: {
          ...profile,
          merchantRules: [],
          transactionRules: rules,
        },
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'groceries',
          confidence: 0.9,
          reason: 'No active deterministic rule applies.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'apply',
      categoryAlias: 'groceries',
      source: 'model',
    });
  });

  it('keeps model and income merchant categories direction-compatible', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Different Merchant',
        },
        profile,
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'savings',
          confidence: 1,
          reason: 'The model cannot select a protected savings category.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'clarify',
      reason: 'category-not-allowed',
    });

    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          direction: 'income',
          amountMinorUnits: 1_000,
          payeeName: 'Example Market',
        },
        profile,
        taxonomy,
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'clarify',
      reason: 'category-not-allowed',
    });
  });

  it('applies configured cashback treatment only to income', () => {
    expect(
      decide({
        specialKind: 'cashback',
        direction: 'income',
        amountMinorUnits: 2_500,
      }),
    ).toEqual({
      disposition: 'apply',
      categoryAlias: 'cashback',
      source: 'special',
    });
    expect(decide({ specialKind: 'cashback' })).toEqual({
      disposition: 'clarify',
      reason: 'category-not-allowed',
    });
  });

  it('uses an allowlisted model proposal when no confirmed rule matches', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Different Merchant',
        },
        profile,
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'groceries',
          confidence: 0.8,
          reason: 'The merchant description indicates groceries.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'apply',
      categoryAlias: 'groceries',
      source: 'model',
    });
  });

  it('leaves an ordinary unknown transaction for model classification', () => {
    expect(
      decide({
        payeeName: 'Different Merchant',
      }),
    ).toBeUndefined();
  });

  it('asks one calm question below the automatic confidence threshold', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Different Merchant',
        },
        profile,
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'groceries',
          confidence: 0.79,
          reason: 'The merchant may be a grocery store.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'clarify',
      reason: 'model-low-confidence',
      question:
        "I'm not quite sure about the CAD $17.25 transaction at Different Merchant on 2026-07-28. My best guess is Groceries. Is that right, or should I use another category?",
    });
  });

  it('applies a high-confidence model everyday-shopping proposal', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Different Merchant',
        },
        profile,
        taxonomy,
        modelProposal: {
          schemaVersion: 'transaction-category-proposal.v1',
          disposition: 'category',
          categoryAlias: 'everyday-shopping',
          confidence: 1,
          reason: 'No more specific category is supported.',
        },
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'apply',
      categoryAlias: 'everyday-shopping',
      source: 'model',
    });
  });

  it('preserves an explicitly confirmed merchant rule for everyday shopping', () => {
    expect(
      decideTransactionCategorization({
        observation: {
          ...observation,
          payeeName: 'Example Market',
        },
        profile: {
          ...profile,
          merchantRules: [
            {
              ...profile.merchantRules[0]!,
              categoryAlias: 'everyday-shopping',
            },
          ],
        },
        taxonomy,
        specialCategoryAliases: { cashback: 'cashback' },
        now,
      }),
    ).toEqual({
      disposition: 'apply',
      categoryAlias: 'everyday-shopping',
      source: 'confirmed-merchant-rule',
    });
  });
});
