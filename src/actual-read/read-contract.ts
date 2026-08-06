import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ActualReadAccountRole } from './port.js';

export const ACTUAL_READ_CONTRACT_SCHEMA_VERSION = 2 as const;
export const ACTUAL_READ_CONTRACT_SCOPE = 'household-finance-read' as const;
const HEX_256 = /^[a-f0-9]{64}$/;
const ALIAS = /^[a-z][a-z0-9-]{0,63}$/;

export interface ActualReadContractAccount {
  readonly id: string;
  readonly name: string;
  readonly role: ActualReadAccountRole;
  readonly onBudget: boolean;
  readonly bankSyncEnabled: boolean;
  readonly lastFour?: string | undefined;
}

export interface ActualReadContractCategory {
  readonly name: string;
}

export interface ActualReadContract {
  readonly schemaVersion: typeof ACTUAL_READ_CONTRACT_SCHEMA_VERSION;
  readonly scope: typeof ACTUAL_READ_CONTRACT_SCOPE;
  readonly nonce: string;
  readonly fingerprint: string;
  readonly budget: {
    readonly syncId: string;
    readonly name: string;
  };
  readonly accounts: Readonly<Record<string, ActualReadContractAccount>>;
  readonly categories: Readonly<Record<string, ActualReadContractCategory>>;
  readonly expectedCurrency: 'CAD';
  readonly maximumAggregateRangeDays: number;
  readonly maximumExplanationRangeDays: number;
  readonly maximumExplanationRows: number;
  readonly maximumObservationRangeDays: number;
  readonly maximumObservationRows: number;
  readonly freshnessMaximumAgeSeconds: number;
  readonly expectedBankDelayHours: number;
  readonly bankSyncMinimumIntervalSeconds: number;
}

export type ActualReadContractIdentity = Omit<
  ActualReadContract,
  'fingerprint'
>;

const text = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.normalize('NFC').trim());

const account = z.strictObject({
  id: text,
  name: text,
  role: z.enum([
    'spending',
    'credit-card',
    'cashback-staging',
    'savings',
    'debt',
    'other',
  ]),
  onBudget: z.boolean(),
  bankSyncEnabled: z.boolean(),
  lastFour: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});

const category = z.strictObject({ name: text.max(120) });

const identitySchema = z
  .strictObject({
    schemaVersion: z.literal(ACTUAL_READ_CONTRACT_SCHEMA_VERSION),
    scope: z.literal(ACTUAL_READ_CONTRACT_SCOPE),
    nonce: z.string().regex(HEX_256),
    budget: z.strictObject({ syncId: text, name: text }),
    accounts: z
      .record(z.string().regex(ALIAS), account)
      .refine((accounts) => {
        const length = Object.keys(accounts).length;
        return length > 0 && length <= 50;
      })
      .superRefine((accounts, context) => {
        const ids = Object.values(accounts).map((value) => value.id);
        if (new Set(ids).size !== ids.length) {
          context.addIssue({
            code: 'custom',
            message: 'Read-contract account IDs must be unique',
          });
        }
        const names = Object.values(accounts).map((value) =>
          value.name.normalize('NFC').toLocaleLowerCase('en'),
        );
        if (new Set(names).size !== names.length) {
          context.addIssue({
            code: 'custom',
            message: 'Read-contract account names must be unique',
          });
        }
        if (!Object.values(accounts).some((value) => value.bankSyncEnabled)) {
          context.addIssue({
            code: 'custom',
            message: 'At least one account must be bank-sync enabled',
          });
        }
      }),
    categories: z
      .record(z.string().regex(ALIAS), category)
      .refine((categories) => {
        const length = Object.keys(categories).length;
        return length > 0 && length <= 200;
      })
      .superRefine((categories, context) => {
        const names = Object.values(categories).map((value) =>
          value.name.normalize('NFC').toLocaleLowerCase('en'),
        );
        if (new Set(names).size !== names.length) {
          context.addIssue({
            code: 'custom',
            message: 'Read-contract category names must be unique',
          });
        }
      }),
    expectedCurrency: z.literal('CAD'),
    maximumAggregateRangeDays: z.number().int().safe().min(1).max(366),
    maximumExplanationRangeDays: z.number().int().safe().min(1).max(366),
    maximumExplanationRows: z.number().int().safe().min(1).max(20),
    maximumObservationRangeDays: z.number().int().safe().min(1).max(90),
    maximumObservationRows: z.number().int().safe().min(1).max(500),
    freshnessMaximumAgeSeconds: z.number().int().safe().min(60).max(86_400),
    expectedBankDelayHours: z.number().int().safe().min(0).max(168),
    bankSyncMinimumIntervalSeconds: z.number().int().safe().min(60).max(86_400),
  })
  .superRefine((value, context) => {
    if (value.maximumExplanationRangeDays > value.maximumAggregateRangeDays) {
      context.addIssue({
        code: 'custom',
        message: 'Explanation range cannot exceed aggregate range',
      });
    }
    if (value.maximumObservationRangeDays > value.maximumAggregateRangeDays) {
      context.addIssue({
        code: 'custom',
        message: 'Observation range cannot exceed aggregate range',
      });
    }
  });

const contractSchema = identitySchema
  .safeExtend({ fingerprint: z.string().regex(HEX_256) })
  .superRefine((contract, context) => {
    if (actualReadContractFingerprint(contract) !== contract.fingerprint) {
      context.addIssue({
        code: 'custom',
        message: 'Read-contract fingerprint mismatch',
        path: ['fingerprint'],
      });
    }
  });

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function actualReadContractFingerprint(
  contract: ActualReadContractIdentity,
): string {
  const canonical = {
    schemaVersion: contract.schemaVersion,
    scope: contract.scope,
    nonce: contract.nonce,
    budget: [contract.budget.syncId, contract.budget.name],
    accounts: Object.entries(contract.accounts)
      .sort(([left], [right]) => compareText(left, right))
      .map(([alias, value]) => [
        alias,
        value.id,
        value.name,
        value.role,
        value.onBudget,
        value.bankSyncEnabled,
        value.lastFour ?? null,
      ]),
    categories: Object.entries(contract.categories)
      .sort(([left], [right]) => compareText(left, right))
      .map(([alias, value]) => [alias, value.name]),
    expectedCurrency: contract.expectedCurrency,
    maximumAggregateRangeDays: contract.maximumAggregateRangeDays,
    maximumExplanationRangeDays: contract.maximumExplanationRangeDays,
    maximumExplanationRows: contract.maximumExplanationRows,
    maximumObservationRangeDays: contract.maximumObservationRangeDays,
    maximumObservationRows: contract.maximumObservationRows,
    freshnessMaximumAgeSeconds: contract.freshnessMaximumAgeSeconds,
    expectedBankDelayHours: contract.expectedBankDelayHours,
    bankSyncMinimumIntervalSeconds: contract.bankSyncMinimumIntervalSeconds,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

export function parseActualReadContract(value: unknown): ActualReadContract {
  return contractSchema.parse(value);
}
