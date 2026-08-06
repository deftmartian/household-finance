import { z } from 'zod';

import {
  householdContextMutationSchema,
  type HouseholdContextMutation,
} from './mutation.js';
import {
  householdProfileSchema,
  type HouseholdContextProvenance,
  type HouseholdProfile,
} from './profile.js';

const aliasSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const textSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.normalize('NFC').trim());
const dateSchema = z.iso.date();
const moneySchema = z.number().int().safe().nonnegative();

const recordControlFields = {
  status: z.enum(['confirmed', 'candidate']),
  validFrom: dateSchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
} as const;

export const plannedHouseholdContextOperationSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('upsert-member'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        displayName: textSchema.max(100),
        kind: z.enum(['adult', 'dependant']),
        talkActorIds: z.array(z.string().min(1).max(200)).max(10),
        access: z.enum(['shared-adult', 'dependant', 'none']),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-dependant'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        displayName: textSchema.max(100).optional(),
        ageBand: z.enum([
          'infant',
          'preschool',
          'school-age',
          'teen',
          'adult-dependant',
          'unspecified',
        ]),
        birthdayMonth: z.number().int().min(1).max(12).optional(),
        birthdayDay: z.number().int().min(1).max(31).optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-income-cadence'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        memberId: aliasSchema,
        name: textSchema.max(150),
        cadence: z.enum([
          'weekly',
          'biweekly',
          'semimonthly',
          'monthly',
          'irregular',
        ]),
        reliability: z.enum(['reliable', 'variable', 'uncertain']),
        expectedNetMinorUnits: moneySchema.optional(),
        nextExpectedDate: dateSchema.optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-obligation'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        name: textSchema.max(150),
        amountMinorUnits: moneySchema.optional(),
        amountCertain: z.boolean(),
        cadence: z.enum([
          'weekly',
          'biweekly',
          'monthly',
          'quarterly',
          'annual',
          'one-time',
          'irregular',
        ]),
        nextDueDate: dateSchema.optional(),
        priority: z.enum(['required', 'important', 'discretionary']),
        accountRoleAlias: aliasSchema.optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-savings-goal'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        name: textSchema.max(150),
        targetMinorUnits: moneySchema.optional(),
        targetDate: dateSchema.optional(),
        priority: z.enum(['required', 'important', 'aspirational']),
        protectedFromDiscretionarySpending: z.boolean(),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-account-role'),
      value: z.strictObject({
        ...recordControlFields,
        alias: aliasSchema,
        displayName: textSchema.max(150),
        role: z.enum([
          'primary-chequing',
          'spending-card',
          'cashback-staging',
          'emergency-savings',
          'debt',
          'income',
          'other',
        ]),
        budgetTreatment: z.enum(['on-budget', 'off-budget', 'excluded']),
        notes: textSchema.optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-merchant-rule'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        merchantPattern: textSchema.max(200),
        categoryAlias: aliasSchema,
        applicationCount: z.number().int().safe().nonnegative(),
        correctionCount: z.number().int().safe().nonnegative(),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-transaction-rule'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        payeePattern: textSchema.max(200),
        specialKind: z.enum(['transfer', 'card-payment', 'debt-payment']),
      }),
    }),
    z.strictObject({
      kind: z.literal('upsert-exceptional-expense'),
      value: z.strictObject({
        ...recordControlFields,
        id: aliasSchema,
        name: textSchema.max(150),
        expectedMinorUnits: moneySchema.optional(),
        expectedDate: dateSchema.optional(),
        protectedAmountMinorUnits: moneySchema.optional(),
        notes: textSchema.optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('set-money-policy'),
      policy: z.enum([
        'minimumCashBufferMinorUnits',
        'emergencyFundTargetMinorUnits',
      ]),
      value: z.strictObject({
        ...recordControlFields,
        value: moneySchema,
      }),
    }),
    z.strictObject({
      kind: z.literal('set-risk-policy'),
      policy: z.literal('safeBudgetRiskPreference'),
      value: z.strictObject({
        ...recordControlFields,
        value: z.enum(['conservative', 'balanced', 'flexible']),
      }),
    }),
    z.strictObject({
      kind: z.literal('set-text-policy'),
      policy: z.enum(['giftPolicy', 'debtPriority']),
      value: z.strictObject({
        ...recordControlFields,
        value: textSchema,
      }),
    }),
    z.strictObject({
      kind: z.literal('remove-record'),
      collection: z.enum([
        'members',
        'dependants',
        'incomeCadences',
        'obligations',
        'savingsGoals',
        'accountRoles',
        'merchantRules',
        'transactionRules',
        'exceptionalExpenses',
      ]),
      key: aliasSchema,
    }),
    z.strictObject({
      kind: z.literal('remove-policy'),
      policy: z.enum([
        'minimumCashBufferMinorUnits',
        'emergencyFundTargetMinorUnits',
        'safeBudgetRiskPreference',
        'giftPolicy',
        'debtPriority',
      ]),
    }),
  ],
);

export const plannedHouseholdContextOperationJsonSchema = z.toJSONSchema(
  plannedHouseholdContextOperationSchema,
  {
    target: 'draft-2020-12',
    reused: 'inline',
  },
) as Readonly<Record<string, unknown>>;

export type PlannedHouseholdContextOperation = z.infer<
  typeof plannedHouseholdContextOperationSchema
>;

interface AuthenticatedHouseholdMessage {
  readonly actorId: string;
  readonly messageId: string;
  readonly message: string;
  readonly receivedAt: string;
}

export function materializeHouseholdContextMutation(
  operationInput: PlannedHouseholdContextOperation,
  currentProfile: HouseholdProfile,
  message: AuthenticatedHouseholdMessage,
  mutationId: string,
): HouseholdContextMutation {
  const plannedOperation =
    plannedHouseholdContextOperationSchema.parse(operationInput);
  const profile = householdProfileSchema.parse(currentProfile);
  const provenance: HouseholdContextProvenance = {
    source:
      plannedOperation.kind === 'remove-record' ||
      plannedOperation.kind === 'remove-policy'
        ? 'talk-confirmed'
        : plannedOperation.value.status === 'confirmed'
          ? 'talk-explicit'
          : 'talk-confirmed',
    actorId: message.actorId,
    messageId: message.messageId,
    recordedAt: message.receivedAt,
  };
  const operation =
    plannedOperation.kind === 'remove-record' ||
    plannedOperation.kind === 'remove-policy'
      ? plannedOperation
      : {
          ...plannedOperation,
          value: {
            ...plannedOperation.value,
            provenance,
          },
        };
  return householdContextMutationSchema.parse({
    schemaVersion: 'household-context-mutation.v1',
    mutationId,
    expectedRevision: profile.revision,
    actorId: message.actorId,
    messageId: message.messageId,
    requestedAt: message.receivedAt,
    operation,
  });
}
