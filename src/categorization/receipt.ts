import { z } from 'zod';

import { buildReceiptMatchIntent } from '../matching/index.js';
import {
  householdFinanceActiveReceiptRecordSchema,
  receiptRecordItemDetailsComplete,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../receipt-record/index.js';
import {
  categoryAliasSchema,
  categoryTaxonomySchema,
  type CategoryTaxonomy,
} from './taxonomy.js';

const receiptItemCategoryProposalSchema = z.strictObject({
  itemIndex: z.number().int().safe().nonnegative().max(199),
  categoryAlias: categoryAliasSchema,
  confidence: z.number().min(0).max(1),
});

const receiptCategoryUncertaintySchema = z.strictObject({
  itemIndex: z.number().int().safe().nonnegative().max(199).nullable(),
  message: z
    .string()
    .min(1)
    .max(500)
    .refine((value) => value === value.normalize('NFC').trim()),
  material: z.boolean(),
});

export const receiptCategoryProposalSchema = z.strictObject({
  schemaVersion: z.literal('receipt-category-proposal.v1'),
  wholeReceiptCategoryAlias: categoryAliasSchema.nullable().optional(),
  items: z.array(receiptItemCategoryProposalSchema).max(200),
  uncertainties: z.array(receiptCategoryUncertaintySchema).max(100),
});

export type ReceiptCategoryProposal = z.infer<
  typeof receiptCategoryProposalSchema
>;

export type ReceiptCategorizationIssueCode =
  | 'category-not-allowed'
  | 'classification-incomplete'
  | 'classification-uncertain'
  | 'currency-not-household'
  | 'duplicate-item-classification'
  | 'receipt-not-ready'
  | 'split-allocation-failed'
  | 'split-total-mismatch';

export interface ReceiptCategorySplit {
  categoryAlias: string;
  amountMinorUnits: number;
}

export type ReceiptCategorizationResult =
  | {
      disposition: 'ready';
      splits: readonly ReceiptCategorySplit[];
      totalMinorUnits: number;
    }
  | {
      disposition: 'review';
      issueCodes: readonly ReceiptCategorizationIssueCode[];
    };

const DETERMINISTIC_REEVALUATION_ISSUES =
  new Set<ReceiptCategorizationIssueCode>([
    'receipt-not-ready',
    'split-allocation-failed',
    'split-total-mismatch',
  ]);

export function isReceiptCategorizationDeterministicallyReevaluatable(
  result: ReceiptCategorizationResult,
): result is Extract<ReceiptCategorizationResult, { disposition: 'review' }> {
  return (
    result.disposition === 'review' &&
    result.issueCodes.every((code) =>
      DETERMINISTIC_REEVALUATION_ISSUES.has(code),
    )
  );
}

interface WeightedCategory {
  alias: string;
  baseMinorUnits: bigint;
  adjustmentMinorUnits: bigint;
  remainderMagnitude: bigint;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function safeNonnegativeInteger(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError('Receipt split is outside the safe money range');
  }
  return result;
}

function allocateSplits(
  categorySubtotals: ReadonlyMap<string, bigint>,
  subtotalMinorUnits: bigint,
  totalMinorUnits: bigint,
): ReceiptCategorySplit[] {
  if (categorySubtotals.size === 0) {
    throw new RangeError('Receipt has no classified subtotal');
  }
  if (subtotalMinorUnits === 0n && totalMinorUnits !== 0n) {
    throw new RangeError('Cannot allocate a non-zero total from zero subtotal');
  }
  const adjustment = totalMinorUnits - subtotalMinorUnits;
  const weighted: WeightedCategory[] = [...categorySubtotals.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([alias, baseMinorUnits]) => {
      const numerator = adjustment * baseMinorUnits;
      const quotient =
        subtotalMinorUnits === 0n ? 0n : numerator / subtotalMinorUnits;
      const rawRemainder =
        subtotalMinorUnits === 0n ? 0n : numerator % subtotalMinorUnits;
      return {
        alias,
        baseMinorUnits,
        adjustmentMinorUnits: quotient,
        remainderMagnitude: rawRemainder < 0n ? -rawRemainder : rawRemainder,
      };
    });

  let remainder =
    adjustment -
    weighted.reduce(
      (total, category) => total + category.adjustmentMinorUnits,
      0n,
    );
  const order = [...weighted].sort((left, right) =>
    left.remainderMagnitude === right.remainderMagnitude
      ? compareText(left.alias, right.alias)
      : left.remainderMagnitude > right.remainderMagnitude
        ? -1
        : 1,
  );
  const direction = remainder < 0n ? -1n : 1n;
  let position = 0;
  while (remainder !== 0n) {
    const category = order[position];
    if (category === undefined) {
      throw new RangeError('Receipt split remainder cannot be allocated');
    }
    category.adjustmentMinorUnits += direction;
    remainder -= direction;
    position = (position + 1) % order.length;
  }

  return weighted.map((category) => ({
    categoryAlias: category.alias,
    amountMinorUnits: safeNonnegativeInteger(
      category.baseMinorUnits + category.adjustmentMinorUnits,
    ),
  }));
}

export function evaluateReceiptCategorization(
  untrustedReceipt: HouseholdFinanceActiveReceiptRecordV1,
  untrustedCategories: ReceiptCategoryProposal,
  untrustedTaxonomy: CategoryTaxonomy,
): ReceiptCategorizationResult {
  const receipt =
    householdFinanceActiveReceiptRecordSchema.parse(untrustedReceipt);
  const categories = receiptCategoryProposalSchema.parse(untrustedCategories);
  const taxonomy = categoryTaxonomySchema.parse(untrustedTaxonomy);
  const issues = new Set<ReceiptCategorizationIssueCode>();
  const wholeReceiptCategoryAlias =
    categories.wholeReceiptCategoryAlias ?? null;
  const itemSplitsAreAllocatable = receiptRecordItemDetailsComplete(receipt);

  if (buildReceiptMatchIntent(receipt).disposition !== 'ready') {
    issues.add('receipt-not-ready');
  }
  if (categories.uncertainties.some((uncertainty) => uncertainty.material)) {
    issues.add('classification-uncertain');
  }

  const allowedAliases = new Set(
    taxonomy.categories
      .filter(
        (category) => category.modelSelectable && category.kind === 'expense',
      )
      .map((category) => category.alias),
  );
  const classifications = new Map<number, string>();
  const wholeReceiptMode =
    !itemSplitsAreAllocatable && wholeReceiptCategoryAlias !== null;
  if (wholeReceiptMode && !allowedAliases.has(wholeReceiptCategoryAlias)) {
    issues.add('category-not-allowed');
  }
  for (const item of categories.items) {
    if (classifications.has(item.itemIndex)) {
      issues.add('duplicate-item-classification');
    } else {
      classifications.set(item.itemIndex, item.categoryAlias);
    }
    if (!allowedAliases.has(item.categoryAlias)) {
      issues.add('category-not-allowed');
    }
  }
  if (wholeReceiptMode) {
    if (categories.items.length !== 0) {
      issues.add('classification-incomplete');
    }
  } else if (
    !itemSplitsAreAllocatable ||
    categories.items.length !== receipt.items.length ||
    receipt.items.some((_lineItem, index) => !classifications.has(index)) ||
    categories.items.some((item) => receipt.items[item.itemIndex] === undefined)
  ) {
    issues.add('classification-incomplete');
  }
  if (issues.size > 0) {
    return { disposition: 'review', issueCodes: [...issues].sort() };
  }

  if (wholeReceiptMode) {
    const total = receipt.amounts.totalMinor;
    if (total === null || total <= 0) {
      return { disposition: 'review', issueCodes: ['receipt-not-ready'] };
    }
    return {
      disposition: 'ready',
      splits: [
        {
          categoryAlias: wholeReceiptCategoryAlias,
          amountMinorUnits: total,
        },
      ],
      totalMinorUnits: total,
    };
  }

  const categorySubtotals = new Map<string, bigint>();
  for (const [index, lineItem] of receipt.items.entries()) {
    const alias = classifications.get(index);
    if (alias === undefined || lineItem.totalMinor === null) {
      return {
        disposition: 'review',
        issueCodes: ['classification-incomplete'],
      };
    }
    if (lineItem.totalMinor === 0) {
      continue;
    }
    categorySubtotals.set(
      alias,
      (categorySubtotals.get(alias) ?? 0n) + BigInt(lineItem.totalMinor),
    );
  }

  const total = receipt.amounts.totalMinor;
  if (total === null) {
    return { disposition: 'review', issueCodes: ['receipt-not-ready'] };
  }
  const classifiedMinorUnits = [...categorySubtotals.values()].reduce(
    (sum, value) => sum + value,
    0n,
  );

  let splits: ReceiptCategorySplit[];
  try {
    splits = allocateSplits(
      categorySubtotals,
      classifiedMinorUnits,
      BigInt(total),
    ).filter((split) => split.amountMinorUnits > 0);
  } catch {
    return {
      disposition: 'review',
      issueCodes: ['split-allocation-failed'],
    };
  }
  if (splits.length === 0) {
    return {
      disposition: 'review',
      issueCodes: ['split-allocation-failed'],
    };
  }
  if (
    splits.reduce((sum, split) => sum + BigInt(split.amountMinorUnits), 0n) !==
    BigInt(total)
  ) {
    return {
      disposition: 'review',
      issueCodes: ['split-total-mismatch'],
    };
  }
  return {
    disposition: 'ready',
    splits,
    totalMinorUnits: total,
  };
}

/**
 * Applies one human category only to the line items the model left unclear.
 * Already-valid item choices remain intact, so a clarification cannot flatten
 * a mixed receipt into one category. If the extracted item rows cannot support
 * an exact split, the clarification describes the whole receipt instead.
 */
export function resolveReceiptCategorizationClarification(
  untrustedReceipt: HouseholdFinanceActiveReceiptRecordV1,
  untrustedProposal: ReceiptCategoryProposal,
  untrustedReview: Extract<
    ReceiptCategorizationResult,
    { disposition: 'review' }
  >,
  untrustedCategoryAlias: string,
): Extract<ReceiptCategorizationResult, { disposition: 'ready' }> {
  const receipt =
    householdFinanceActiveReceiptRecordSchema.parse(untrustedReceipt);
  const proposal = receiptCategoryProposalSchema.parse(untrustedProposal);
  const categoryAlias = categoryAliasSchema.parse(untrustedCategoryAlias);
  const itemSplitsAreAllocatable = receiptRecordItemDetailsComplete(receipt);
  if (
    untrustedReview.issueCodes.some(
      (code) =>
        code !== 'classification-incomplete' &&
        code !== 'classification-uncertain',
    )
  ) {
    throw new TypeError('Receipt review is not a category clarification');
  }

  const original = new Map<number, ReceiptCategoryProposal['items'][number]>();
  for (const item of proposal.items) {
    if (original.has(item.itemIndex)) {
      throw new TypeError('Receipt clarification has duplicate items');
    }
    original.set(item.itemIndex, item);
  }
  const unclear = new Set<number>();
  for (const [index] of receipt.items.entries()) {
    if (!original.has(index)) {
      unclear.add(index);
    }
  }
  for (const uncertainty of proposal.uncertainties) {
    if (uncertainty.material && uncertainty.itemIndex !== null) {
      unclear.add(uncertainty.itemIndex);
    }
  }
  if (
    unclear.size === 0 &&
    proposal.uncertainties.some(
      (uncertainty) => uncertainty.material && uncertainty.itemIndex === null,
    )
  ) {
    for (const [index] of receipt.items.entries()) {
      unclear.add(index);
    }
  }
  if (unclear.size === 0) {
    for (const [index] of receipt.items.entries()) {
      unclear.add(index);
    }
  }

  const corrected: ReceiptCategoryProposal = {
    schemaVersion: 'receipt-category-proposal.v1',
    ...(!itemSplitsAreAllocatable
      ? { wholeReceiptCategoryAlias: categoryAlias }
      : {}),
    items: itemSplitsAreAllocatable
      ? receipt.items.map((_lineItem, itemIndex) => {
          const existing = original.get(itemIndex);
          if (!unclear.has(itemIndex) && existing === undefined) {
            throw new TypeError('Receipt clarification is incomplete');
          }
          return unclear.has(itemIndex)
            ? { itemIndex, categoryAlias, confidence: 1 }
            : existing!;
        })
      : [],
    uncertainties: [],
  };
  const aliases = [
    ...new Set([
      ...corrected.items.map((item) => item.categoryAlias),
      ...(corrected.wholeReceiptCategoryAlias === undefined ||
      corrected.wholeReceiptCategoryAlias === null
        ? []
        : [corrected.wholeReceiptCategoryAlias]),
    ]),
  ];
  const result = evaluateReceiptCategorization(receipt, corrected, {
    schemaVersion: 'household-category-taxonomy.v1',
    currency: 'CAD',
    categories: aliases.map((alias) => ({
      alias,
      name: alias,
      description: 'Confirmed receipt category.',
      kind: 'expense',
      modelSelectable: true,
    })),
  });
  if (result.disposition !== 'ready') {
    throw new TypeError('Receipt clarification did not produce exact splits');
  }
  return result;
}
