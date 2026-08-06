import { describe, expect, it } from 'vitest';

import {
  categoryTaxonomyFingerprint,
  categoryTaxonomySchema,
  modelSelectableCategories,
  transactionModelSelectableCategories,
} from '../../src/categorization/index.js';

const taxonomy = {
  schemaVersion: 'household-category-taxonomy.v1' as const,
  currency: 'CAD' as const,
  categories: [
    {
      alias: 'groceries',
      name: 'Groceries',
      description: 'Food and household groceries.',
      kind: 'expense' as const,
      modelSelectable: true,
    },
    {
      alias: 'income',
      name: 'Income',
      description: 'Household income.',
      kind: 'income' as const,
      modelSelectable: true,
    },
  ],
};

describe('category taxonomy', () => {
  it('exposes only model-selectable expense aliases without ledger IDs', () => {
    expect(modelSelectableCategories(taxonomy)).toEqual([
      {
        alias: 'groceries',
        name: 'Groceries',
        description: 'Food and household groceries.',
      },
    ]);
  });

  it('exposes direction-compatible transaction aliases', () => {
    expect(transactionModelSelectableCategories(taxonomy, 'income')).toEqual([
      {
        alias: 'income',
        name: 'Income',
        description: 'Household income.',
      },
    ]);
    expect(transactionModelSelectableCategories(taxonomy, 'refund')).toEqual([
      {
        alias: 'groceries',
        name: 'Groceries',
        description: 'Food and household groceries.',
      },
    ]);
  });

  it('has a stable contract fingerprint', () => {
    expect(categoryTaxonomyFingerprint(taxonomy)).toMatch(/^[a-f0-9]{64}$/);
    expect(categoryTaxonomyFingerprint(taxonomy)).toBe(
      categoryTaxonomyFingerprint(structuredClone(taxonomy)),
    );
  });

  it('rejects duplicate aliases and names', () => {
    expect(
      categoryTaxonomySchema.safeParse({
        ...taxonomy,
        categories: [taxonomy.categories[0], { ...taxonomy.categories[0] }],
      }).success,
    ).toBe(false);
  });
});
