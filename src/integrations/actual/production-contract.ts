import { createHash } from 'node:crypto';

import { z } from 'zod';

export const ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION = 2 as const;
export const ACTUAL_PRODUCTION_SCOPE = 'household-finance-production' as const;
export const ACTUAL_PRODUCTION_SENTINEL_PREFIX = 'HF_PRODUCTION_V1:' as const;
export const ACTUAL_PRODUCTION_HEX_PATTERN = /^[a-f0-9]{64}$/;

const aliasPattern = /^[a-z][a-z0-9-]{0,63}$/;
const maximumReceiptAmountMinorUnits = 100_000_000;
const maximumReceiptDateWindowDays = 36_600;

export interface ActualProductionNamedIdentity {
  readonly id: string;
  readonly name: string;
}

export interface ActualProductionCategoryIdentity extends ActualProductionNamedIdentity {
  readonly kind: 'expense' | 'income';
}

export interface ActualProductionBudgetIdentity {
  readonly syncId: string;
  readonly name: string;
}

export interface ActualProductionReceiptDateWindow {
  readonly pastDays: number;
  readonly futureDays: number;
}

export interface ActualProductionContract {
  readonly schemaVersion: typeof ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION;
  readonly scope: typeof ACTUAL_PRODUCTION_SCOPE;
  readonly nonce: string;
  readonly fingerprint: string;
  readonly budget: ActualProductionBudgetIdentity;
  readonly accounts: Readonly<Record<string, ActualProductionNamedIdentity>>;
  readonly categories: Readonly<
    Record<string, ActualProductionCategoryIdentity>
  >;
  readonly expectedCurrency: 'CAD';
  readonly maximumReceiptAmountMinorUnits: number;
  readonly receiptDateWindow: ActualProductionReceiptDateWindow;
  readonly sentinelPayee: ActualProductionNamedIdentity;
}

export type ActualProductionContractIdentity = Omit<
  ActualProductionContract,
  'fingerprint' | 'sentinelPayee'
>;

const trimmedTextSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), {
    message: 'Value cannot have surrounding whitespace',
  });

const namedIdentitySchema = z.strictObject({
  id: trimmedTextSchema,
  name: trimmedTextSchema,
});

const categoryIdentitySchema = namedIdentitySchema.extend({
  kind: z.enum(['expense', 'income']),
});

const budgetIdentitySchema = z.strictObject({
  syncId: trimmedTextSchema,
  name: trimmedTextSchema,
});

const identityAliasMapSchema = z
  .record(z.string().regex(aliasPattern), namedIdentitySchema)
  .refine((identities) => Object.keys(identities).length > 0, {
    message: 'At least one alias is required',
  })
  .superRefine((identities, context) => {
    const actualIds = new Set<string>();
    for (const [alias, identity] of Object.entries(identities)) {
      if (actualIds.has(identity.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Each alias must bind a distinct Actual ID',
          path: [alias, 'id'],
        });
      }
      actualIds.add(identity.id);
    }
  });

const categoryAliasMapSchema = z
  .record(z.string().regex(aliasPattern), categoryIdentitySchema)
  .refine((identities) => Object.keys(identities).length > 0, {
    message: 'At least one alias is required',
  })
  .superRefine((identities, context) => {
    const actualIds = new Set<string>();
    for (const [alias, identity] of Object.entries(identities)) {
      if (actualIds.has(identity.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Each alias must bind a distinct Actual ID',
          path: [alias, 'id'],
        });
      }
      actualIds.add(identity.id);
    }
  });

const productionContractSchema = z
  .strictObject({
    schemaVersion: z.literal(ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION),
    scope: z.literal(ACTUAL_PRODUCTION_SCOPE),
    nonce: z.string().regex(ACTUAL_PRODUCTION_HEX_PATTERN),
    fingerprint: z.string().regex(ACTUAL_PRODUCTION_HEX_PATTERN),
    budget: budgetIdentitySchema,
    accounts: identityAliasMapSchema,
    categories: categoryAliasMapSchema,
    expectedCurrency: z.literal('CAD'),
    maximumReceiptAmountMinorUnits: z
      .number()
      .int()
      .safe()
      .positive()
      .max(maximumReceiptAmountMinorUnits),
    receiptDateWindow: z.strictObject({
      pastDays: z
        .number()
        .int()
        .safe()
        .nonnegative()
        .max(maximumReceiptDateWindowDays),
      futureDays: z
        .number()
        .int()
        .safe()
        .nonnegative()
        .max(maximumReceiptDateWindowDays),
    }),
    sentinelPayee: namedIdentitySchema,
  })
  .superRefine((contract, context) => {
    if (
      actualProductionContractFingerprint(contract) !== contract.fingerprint
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Production Actual contract fingerprint does not match its identities and write limits',
        path: ['fingerprint'],
      });
    }
    if (
      contract.sentinelPayee.name !==
      actualProductionSentinelPayeeName(contract.fingerprint)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Production Actual sentinel payee name does not match the contract fingerprint',
        path: ['sentinelPayee', 'name'],
      });
    }
  });

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalAliasMap(
  identities: Readonly<Record<string, ActualProductionNamedIdentity>>,
): readonly (readonly [string, string, string])[] {
  return Object.entries(identities)
    .sort(([left], [right]) => compareText(left, right))
    .map(([alias, identity]) => [alias, identity.id, identity.name] as const);
}

function canonicalCategoryAliasMap(
  identities: Readonly<Record<string, ActualProductionCategoryIdentity>>,
): readonly (readonly [string, string, string, 'expense' | 'income'])[] {
  return Object.entries(identities)
    .sort(([left], [right]) => compareText(left, right))
    .map(
      ([alias, identity]) =>
        [alias, identity.id, identity.name, identity.kind] as const,
    );
}

/**
 * The fingerprint binds every write-capable Actual identity and deterministic
 * write limit. The sentinel payee is created afterwards with a name derived
 * from this fingerprint and is then bound by exact ID/name validation.
 */
export function actualProductionContractFingerprint(
  contract: ActualProductionContractIdentity,
): string {
  const canonicalIdentity = {
    schemaVersion: contract.schemaVersion,
    scope: contract.scope,
    nonce: contract.nonce,
    budget: [contract.budget.syncId, contract.budget.name],
    accounts: canonicalAliasMap(contract.accounts),
    categories: canonicalCategoryAliasMap(contract.categories),
    expectedCurrency: contract.expectedCurrency,
    maximumReceiptAmountMinorUnits: contract.maximumReceiptAmountMinorUnits,
    receiptDateWindow: [
      contract.receiptDateWindow.pastDays,
      contract.receiptDateWindow.futureDays,
    ],
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalIdentity), 'utf8')
    .digest('hex');
}

export function actualProductionSentinelPayeeName(fingerprint: string): string {
  if (!ACTUAL_PRODUCTION_HEX_PATTERN.test(fingerprint)) {
    throw new TypeError(
      'Production Actual contract fingerprint must be 256-bit lowercase hexadecimal',
    );
  }
  return `${ACTUAL_PRODUCTION_SENTINEL_PREFIX}${fingerprint}`;
}

export function parseActualProductionContract(
  value: unknown,
): ActualProductionContract {
  return productionContractSchema.parse(value);
}
