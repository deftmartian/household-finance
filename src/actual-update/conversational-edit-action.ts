import { z } from 'zod';

const aliasSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const normalizedPayeeSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value === value.normalize('NFC').trim());
const normalizedNotesSchema = z
  .string()
  .max(500)
  .refine((value) => value === value.normalize('NFC') && !value.includes('\0'));
const nonzeroMoneySchema = z
  .number()
  .int()
  .safe()
  .refine((value) => value !== 0);

const transactionSelectorSchema = z.strictObject({
  date: z.iso.date(),
  amountMinorUnits: nonzeroMoneySchema,
  payeeName: normalizedPayeeSchema.nullable(),
  accountAlias: aliasSchema.nullable(),
});

const categorizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('single'),
    categoryAlias: aliasSchema,
  }),
  z.strictObject({
    kind: z.literal('split'),
    splits: z
      .array(
        z.strictObject({
          categoryAlias: aliasSchema,
          amountMinorUnits: nonzeroMoneySchema,
          notes: normalizedNotesSchema.nullable(),
        }),
      )
      .min(2)
      .max(20),
  }),
]);

/**
 * Model-safe action vocabulary for editing one existing imported transaction.
 * It contains only visible ledger facts and aliases; Actual identifiers are
 * resolved later by deterministic code.
 */
export const conversationalTransactionEditActionSchema = z
  .strictObject({
    schemaVersion: z.literal('conversational-transaction-edit.v1'),
    selector: transactionSelectorSchema,
    categorization: categorizationSchema,
    rememberForMerchant: z.boolean(),
  })
  .superRefine((action, context) => {
    if (action.categorization.kind === 'single') {
      return;
    }
    if (action.rememberForMerchant) {
      context.addIssue({
        code: 'custom',
        path: ['rememberForMerchant'],
        message: 'A recurring merchant rule requires one category',
      });
    }
    const aliases = action.categorization.splits.map(
      (split) => split.categoryAlias,
    );
    if (new Set(aliases).size !== aliases.length) {
      context.addIssue({
        code: 'custom',
        path: ['categorization', 'splits'],
        message: 'Split category aliases must be unique',
      });
    }
    const parentSign = Math.sign(action.selector.amountMinorUnits);
    let total = 0n;
    for (const [index, split] of action.categorization.splits.entries()) {
      if (Math.sign(split.amountMinorUnits) !== parentSign) {
        context.addIssue({
          code: 'custom',
          path: ['categorization', 'splits', index, 'amountMinorUnits'],
          message: 'Split amounts must have the transaction sign',
        });
      }
      total += BigInt(split.amountMinorUnits);
    }
    if (total !== BigInt(action.selector.amountMinorUnits)) {
      context.addIssue({
        code: 'custom',
        path: ['categorization', 'splits'],
        message: 'Split amounts must equal the transaction amount',
      });
    }
  });

export type ConversationalTransactionEditAction = z.infer<
  typeof conversationalTransactionEditActionSchema
>;

export const conversationalTransactionEditActionJsonSchema = z.toJSONSchema(
  conversationalTransactionEditActionSchema,
  {
    target: 'draft-2020-12',
    reused: 'inline',
  },
) as Readonly<Record<string, unknown>>;

export function parseConversationalTransactionEditAction(
  value: unknown,
): ConversationalTransactionEditAction {
  return conversationalTransactionEditActionSchema.parse(value);
}
