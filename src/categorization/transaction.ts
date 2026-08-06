import { z } from 'zod';

import {
  householdMerchantRuleSchema,
  householdTransactionRuleSchema,
  type HouseholdProfile,
} from '../context/index.js';
import {
  categoryAliasSchema,
  categoryTaxonomySchema,
  type CategoryTaxonomy,
} from './taxonomy.js';

const normalizedTextSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.normalize('NFC').trim());

export const transactionCategorizationObservationSchema = z.strictObject({
  schemaVersion: z.literal('transaction-categorization-observation.v1'),
  date: z.iso.date(),
  accountAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  amountMinorUnits: z.number().int().safe(),
  direction: z.enum(['expense', 'refund', 'income']),
  payeeName: normalizedTextSchema.max(240).nullable(),
  memo: normalizedTextSchema.nullable(),
  specialKind: z.enum([
    'ordinary',
    'transfer',
    'card-payment',
    'cashback',
    'debt-payment',
  ]),
  currentCategoryAlias: categoryAliasSchema.nullable(),
  originalRefundCategoryAlias: categoryAliasSchema.nullable(),
});

export type TransactionCategorizationObservation = z.infer<
  typeof transactionCategorizationObservationSchema
>;

export const transactionCategoryProposalSchema = z.strictObject({
  schemaVersion: z.literal('transaction-category-proposal.v1'),
  disposition: z.literal('category'),
  categoryAlias: categoryAliasSchema,
  confidence: z.number().min(0).max(1),
  reason: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => value === value.normalize('NFC').trim()),
});

export type TransactionCategoryProposal = z.infer<
  typeof transactionCategoryProposalSchema
>;

export interface TransactionSpecialCategoryAliases {
  cashback: string;
}

export type TransactionCategorizationDecision =
  | {
      disposition: 'apply';
      categoryAlias: string;
      source: 'confirmed-merchant-rule' | 'model' | 'refund-link' | 'special';
    }
  | {
      disposition: 'ignore';
      reason: 'transfer' | 'card-payment' | 'debt-payment';
    }
  | {
      disposition: 'clarify';
      reason:
        | 'category-not-allowed'
        | 'merchant-rule-conflict'
        | 'model-low-confidence';
      question?: string;
    };

function normalizedMerchant(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function activeConfirmedMerchantRules(
  profile: HouseholdProfile,
  payeeName: string,
  now: string,
): string[] {
  const merchant = normalizedMerchant(payeeName);
  return profile.merchantRules
    .filter((untrustedRule) => {
      const rule = householdMerchantRuleSchema.parse(untrustedRule);
      return (
        rule.status === 'confirmed' &&
        (rule.validFrom === undefined || rule.validFrom <= now.slice(0, 10)) &&
        (rule.expiresAt === undefined ||
          Date.parse(rule.expiresAt) > Date.parse(now)) &&
        normalizedMerchant(rule.merchantPattern) === merchant
      );
    })
    .map((rule) => rule.categoryAlias);
}

function activeConfirmedTransactionRules(
  profile: HouseholdProfile,
  payeeName: string,
  now: string,
): Array<'transfer' | 'card-payment' | 'debt-payment'> {
  const payee = normalizedMerchant(payeeName);
  return profile.transactionRules
    .filter((untrustedRule) => {
      const rule = householdTransactionRuleSchema.parse(untrustedRule);
      return (
        rule.status === 'confirmed' &&
        (rule.validFrom === undefined || rule.validFrom <= now.slice(0, 10)) &&
        (rule.expiresAt === undefined ||
          Date.parse(rule.expiresAt) > Date.parse(now)) &&
        normalizedMerchant(rule.payeePattern) === payee
      );
    })
    .map((rule) => rule.specialKind);
}

function modelAllowedAlias(
  taxonomy: CategoryTaxonomy,
  alias: string,
  direction: TransactionCategorizationObservation['direction'],
): boolean {
  const category = taxonomy.categories.find(
    (candidate) => candidate.alias === alias,
  );
  if (category === undefined || !category.modelSelectable) {
    return false;
  }
  return direction === 'income'
    ? category.kind === 'income'
    : category.kind === 'expense';
}

function lowConfidenceQuestion(
  observation: TransactionCategorizationObservation,
  categoryName: string,
): string {
  const merchant = observation.payeeName ?? 'an unnamed payee';
  const amount = (Math.abs(observation.amountMinorUnits) / 100).toFixed(2);
  return `I'm not quite sure about the CAD $${amount} transaction at ${merchant} on ${observation.date}. My best guess is ${categoryName}. Is that right, or should I use another category?`;
}

export function decideTransactionCategorization(input: {
  observation: TransactionCategorizationObservation;
  profile: HouseholdProfile;
  taxonomy: CategoryTaxonomy;
  modelProposal?: TransactionCategoryProposal;
  specialCategoryAliases: TransactionSpecialCategoryAliases;
  minimumAutoApplyConfidence?: number;
  now: string;
}): TransactionCategorizationDecision | undefined {
  const observation = transactionCategorizationObservationSchema.parse(
    input.observation,
  );
  const taxonomy = categoryTaxonomySchema.parse(input.taxonomy);
  const profile = input.profile;
  const minimumAutoApplyConfidence = z
    .number()
    .min(0)
    .max(1)
    .parse(input.minimumAutoApplyConfidence ?? 0.8);
  z.iso.datetime({ offset: true }).parse(input.now);

  switch (observation.specialKind) {
    case 'transfer':
      return { disposition: 'ignore', reason: 'transfer' };
    case 'card-payment':
      return { disposition: 'ignore', reason: 'card-payment' };
    case 'debt-payment':
      return { disposition: 'ignore', reason: 'debt-payment' };
    case 'cashback': {
      const alias = categoryAliasSchema.parse(
        input.specialCategoryAliases.cashback,
      );
      return modelAllowedAlias(taxonomy, alias, observation.direction)
        ? {
            disposition: 'apply',
            categoryAlias: alias,
            source: 'special',
          }
        : {
            disposition: 'clarify',
            reason: 'category-not-allowed',
          };
    }
    case 'ordinary':
      break;
  }

  if (
    observation.direction === 'refund' &&
    observation.originalRefundCategoryAlias !== null &&
    modelAllowedAlias(
      taxonomy,
      observation.originalRefundCategoryAlias,
      observation.direction,
    )
  ) {
    return {
      disposition: 'apply',
      categoryAlias: observation.originalRefundCategoryAlias,
      source: 'refund-link',
    };
  }

  if (observation.payeeName !== null) {
    const transactionRules = [
      ...new Set(
        activeConfirmedTransactionRules(
          profile,
          observation.payeeName,
          input.now,
        ),
      ),
    ];
    if (transactionRules.length > 1) {
      return {
        disposition: 'clarify',
        reason: 'merchant-rule-conflict',
      };
    }
    const transactionRule = transactionRules[0];
    if (transactionRule !== undefined) {
      return {
        disposition: 'ignore',
        reason: transactionRule,
      };
    }

    const rules = [
      ...new Set(
        activeConfirmedMerchantRules(profile, observation.payeeName, input.now),
      ),
    ];
    if (rules.length > 1) {
      return {
        disposition: 'clarify',
        reason: 'merchant-rule-conflict',
      };
    }
    const rule = rules[0];
    if (rule !== undefined) {
      return modelAllowedAlias(taxonomy, rule, observation.direction)
        ? {
            disposition: 'apply',
            categoryAlias: rule,
            source: 'confirmed-merchant-rule',
          }
        : {
            disposition: 'clarify',
            reason: 'category-not-allowed',
          };
    }
  }

  if (input.modelProposal === undefined) {
    return undefined;
  }
  const proposal = transactionCategoryProposalSchema.parse(input.modelProposal);
  if (
    !modelAllowedAlias(taxonomy, proposal.categoryAlias, observation.direction)
  ) {
    return {
      disposition: 'clarify',
      reason: 'category-not-allowed',
    };
  }
  if (proposal.confidence < minimumAutoApplyConfidence) {
    const category = taxonomy.categories.find(
      (candidate) => candidate.alias === proposal.categoryAlias,
    );
    if (category === undefined) {
      return {
        disposition: 'clarify',
        reason: 'category-not-allowed',
      };
    }
    return {
      disposition: 'clarify',
      reason: 'model-low-confidence',
      question: lowConfidenceQuestion(observation, category.name),
    };
  }
  return {
    disposition: 'apply',
    categoryAlias: proposal.categoryAlias,
    source: 'model',
  };
}
