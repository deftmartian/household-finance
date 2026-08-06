import { createHash } from 'node:crypto';

import { z } from 'zod';

export const categoryAliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

const categoryNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value === value.normalize('NFC').trim());

const categoryDescriptionSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.normalize('NFC').trim());

const categoryTaxonomyEntrySchema = z.strictObject({
  alias: categoryAliasSchema,
  name: categoryNameSchema,
  description: categoryDescriptionSchema,
  kind: z.enum(['expense', 'income', 'savings', 'debt']),
  modelSelectable: z.boolean(),
});

export const categoryTaxonomySchema = z
  .strictObject({
    schemaVersion: z.literal('household-category-taxonomy.v1'),
    currency: z.literal('CAD'),
    categories: z.array(categoryTaxonomyEntrySchema).min(1).max(200),
  })
  .superRefine((taxonomy, context) => {
    const aliases = taxonomy.categories.map((category) => category.alias);
    if (new Set(aliases).size !== aliases.length) {
      context.addIssue({
        code: 'custom',
        message: 'Category aliases must be unique',
        path: ['categories'],
      });
    }
    const normalizedNames = taxonomy.categories.map((category) =>
      category.name.toLocaleLowerCase('en-CA'),
    );
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      context.addIssue({
        code: 'custom',
        message: 'Category names must be unique',
        path: ['categories'],
      });
    }
  });

export type CategoryTaxonomy = z.infer<typeof categoryTaxonomySchema>;
export type CategoryTaxonomyEntry = CategoryTaxonomy['categories'][number];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function categoryTaxonomyFingerprint(
  untrustedTaxonomy: CategoryTaxonomy,
): string {
  const taxonomy = categoryTaxonomySchema.parse(untrustedTaxonomy);
  return createHash('sha256').update(canonicalJson(taxonomy)).digest('hex');
}

export function modelSelectableCategories(
  untrustedTaxonomy: CategoryTaxonomy,
): readonly Pick<CategoryTaxonomyEntry, 'alias' | 'name' | 'description'>[] {
  return modelSelectableCategoriesForKind(untrustedTaxonomy, 'expense');
}

function modelSelectableCategoriesForKind(
  untrustedTaxonomy: CategoryTaxonomy,
  kind: 'expense' | 'income',
): readonly Pick<CategoryTaxonomyEntry, 'alias' | 'name' | 'description'>[] {
  const taxonomy = categoryTaxonomySchema.parse(untrustedTaxonomy);
  return taxonomy.categories
    .filter((category) => category.modelSelectable && category.kind === kind)
    .map(({ alias, name, description }) => ({ alias, name, description }));
}

export function transactionModelSelectableCategories(
  untrustedTaxonomy: CategoryTaxonomy,
  direction: 'expense' | 'refund' | 'income',
): readonly Pick<CategoryTaxonomyEntry, 'alias' | 'name' | 'description'>[] {
  return modelSelectableCategoriesForKind(
    untrustedTaxonomy,
    direction === 'income' ? 'income' : 'expense',
  );
}
