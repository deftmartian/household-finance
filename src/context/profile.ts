import { z } from 'zod';

const MAX_CONTEXT_TEXT_CHARACTERS = 500;
const MAX_PROFILE_ENTRIES = 250;

const safeTextSchema = z
  .string()
  .min(1)
  .max(MAX_CONTEXT_TEXT_CHARACTERS)
  .refine((value) => value === value.normalize('NFC').trim(), {
    message: 'Context text must be normalized and trimmed',
  });

const contextAliasSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const isoDateSchema = z.iso.date();
const timestampSchema = z.iso.datetime({ offset: true });
const moneySchema = z.number().int().safe().nonnegative();

export const householdContextProvenanceSchema = z.strictObject({
  source: z.enum([
    'operator',
    'talk-explicit',
    'talk-confirmed',
    'actual-confirmed',
  ]),
  actorId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200).optional(),
  recordedAt: timestampSchema,
});

export type HouseholdContextProvenance = z.infer<
  typeof householdContextProvenanceSchema
>;

const contextualRecordSchema = z.strictObject({
  status: z.enum(['confirmed', 'candidate']),
  provenance: householdContextProvenanceSchema,
  validFrom: isoDateSchema.optional(),
  expiresAt: timestampSchema.optional(),
});

export const householdMemberSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  displayName: safeTextSchema.max(100),
  kind: z.enum(['adult', 'dependant']),
  talkActorIds: z.array(z.string().min(1).max(200)).max(10).default([]),
  access: z.enum(['shared-adult', 'dependant', 'none']),
});

export const householdDependantSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  displayName: safeTextSchema.max(100).optional(),
  ageBand: z
    .enum([
      'infant',
      'preschool',
      'school-age',
      'teen',
      'adult-dependant',
      'unspecified',
    ])
    .default('unspecified'),
  birthdayMonth: z.number().int().min(1).max(12).optional(),
  birthdayDay: z.number().int().min(1).max(31).optional(),
});

export const householdIncomeCadenceSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  memberId: contextAliasSchema,
  name: safeTextSchema.max(150),
  cadence: z.enum([
    'weekly',
    'biweekly',
    'semimonthly',
    'monthly',
    'irregular',
  ]),
  reliability: z.enum(['reliable', 'variable', 'uncertain']),
  expectedNetMinorUnits: moneySchema.optional(),
  nextExpectedDate: isoDateSchema.optional(),
});

export const householdObligationSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  name: safeTextSchema.max(150),
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
  nextDueDate: isoDateSchema.optional(),
  priority: z.enum(['required', 'important', 'discretionary']),
  accountRoleAlias: contextAliasSchema.optional(),
});

export const householdSavingsGoalSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  name: safeTextSchema.max(150),
  targetMinorUnits: moneySchema.optional(),
  targetDate: isoDateSchema.optional(),
  priority: z.enum(['required', 'important', 'aspirational']),
  protectedFromDiscretionarySpending: z.boolean(),
});

export const householdAccountRoleSchema = contextualRecordSchema.extend({
  alias: contextAliasSchema,
  displayName: safeTextSchema.max(150),
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
  notes: safeTextSchema.optional(),
});

export const householdMerchantRuleSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  merchantPattern: safeTextSchema.max(200),
  categoryAlias: contextAliasSchema,
  applicationCount: z.number().int().safe().nonnegative(),
  correctionCount: z.number().int().safe().nonnegative(),
});

export const householdTransactionRuleSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  payeePattern: safeTextSchema.max(200),
  specialKind: z.enum(['transfer', 'card-payment', 'debt-payment']),
});

export type HouseholdTransactionRule = z.infer<
  typeof householdTransactionRuleSchema
>;

export const householdExceptionalExpenseSchema = contextualRecordSchema.extend({
  id: contextAliasSchema,
  name: safeTextSchema.max(150),
  expectedMinorUnits: moneySchema.optional(),
  expectedDate: isoDateSchema.optional(),
  protectedAmountMinorUnits: moneySchema.optional(),
  notes: safeTextSchema.optional(),
});

export const householdMoneyPolicySchema = contextualRecordSchema.extend({
  value: moneySchema,
});

export const householdRiskPolicySchema = contextualRecordSchema.extend({
  value: z.enum(['conservative', 'balanced', 'flexible']),
});

export const householdTextPolicySchema = contextualRecordSchema.extend({
  value: safeTextSchema,
});

export const householdPoliciesSchema = z.strictObject({
  minimumCashBufferMinorUnits: householdMoneyPolicySchema.optional(),
  emergencyFundTargetMinorUnits: householdMoneyPolicySchema.optional(),
  safeBudgetRiskPreference: householdRiskPolicySchema.optional(),
  giftPolicy: householdTextPolicySchema.optional(),
  debtPriority: householdTextPolicySchema.optional(),
});

export const householdProfileSchema = z
  .strictObject({
    schemaVersion: z.literal('household-finance-profile.v1'),
    revision: z.number().int().safe().nonnegative(),
    updatedAt: timestampSchema,
    currency: z.literal('CAD'),
    timezone: z.string().min(1).max(100),
    members: z.array(householdMemberSchema).max(MAX_PROFILE_ENTRIES),
    dependants: z.array(householdDependantSchema).max(MAX_PROFILE_ENTRIES),
    policies: householdPoliciesSchema,
    incomeCadences: z
      .array(householdIncomeCadenceSchema)
      .max(MAX_PROFILE_ENTRIES),
    obligations: z.array(householdObligationSchema).max(MAX_PROFILE_ENTRIES),
    savingsGoals: z.array(householdSavingsGoalSchema).max(MAX_PROFILE_ENTRIES),
    accountRoles: z.array(householdAccountRoleSchema).max(MAX_PROFILE_ENTRIES),
    merchantRules: z
      .array(householdMerchantRuleSchema)
      .max(MAX_PROFILE_ENTRIES),
    transactionRules: z
      .array(householdTransactionRuleSchema)
      .max(MAX_PROFILE_ENTRIES)
      .default([]),
    exceptionalExpenses: z
      .array(householdExceptionalExpenseSchema)
      .max(MAX_PROFILE_ENTRIES),
  })
  .superRefine((profile, context) => {
    const unique = (
      values: readonly string[],
      path: readonly (string | number)[],
      description: string,
    ): void => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          message: `${description} must be unique`,
          path: [...path],
        });
      }
    };

    unique(
      profile.members.map((member) => member.id),
      ['members'],
      'Member IDs',
    );
    unique(
      profile.members.flatMap((member) => member.talkActorIds),
      ['members'],
      'Talk actor IDs',
    );
    unique(
      profile.dependants.map((dependant) => dependant.id),
      ['dependants'],
      'Dependant IDs',
    );
    unique(
      profile.incomeCadences.map((income) => income.id),
      ['incomeCadences'],
      'Income cadence IDs',
    );
    unique(
      profile.obligations.map((obligation) => obligation.id),
      ['obligations'],
      'Obligation IDs',
    );
    unique(
      profile.savingsGoals.map((goal) => goal.id),
      ['savingsGoals'],
      'Savings goal IDs',
    );
    unique(
      profile.accountRoles.map((account) => account.alias),
      ['accountRoles'],
      'Account role aliases',
    );
    unique(
      profile.merchantRules.map((rule) => rule.id),
      ['merchantRules'],
      'Merchant rule IDs',
    );
    unique(
      profile.transactionRules.map((rule) => rule.id),
      ['transactionRules'],
      'Transaction rule IDs',
    );
    unique(
      profile.transactionRules.map((rule) =>
        rule.payeePattern.toLocaleLowerCase('en-CA'),
      ),
      ['transactionRules'],
      'Transaction rule payee patterns',
    );
    unique(
      profile.exceptionalExpenses.map((expense) => expense.id),
      ['exceptionalExpenses'],
      'Exceptional expense IDs',
    );

    const memberIds = new Set(profile.members.map((member) => member.id));
    profile.incomeCadences.forEach((income, index) => {
      if (!memberIds.has(income.memberId)) {
        context.addIssue({
          code: 'custom',
          message: 'Income cadence memberId must reference a profile member',
          path: ['incomeCadences', index, 'memberId'],
        });
      }
    });

    const accountAliases = new Set(
      profile.accountRoles.map((account) => account.alias),
    );
    profile.obligations.forEach((obligation, index) => {
      if (
        obligation.accountRoleAlias !== undefined &&
        !accountAliases.has(obligation.accountRoleAlias)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Obligation accountRoleAlias must reference a profile account role',
          path: ['obligations', index, 'accountRoleAlias'],
        });
      }
    });

    const recordCollections = [
      profile.members,
      profile.dependants,
      profile.incomeCadences,
      profile.obligations,
      profile.savingsGoals,
      profile.accountRoles,
      profile.merchantRules,
      profile.transactionRules,
      profile.exceptionalExpenses,
    ] as const;
    for (const collection of recordCollections) {
      for (const record of collection) {
        if (
          record.validFrom !== undefined &&
          record.expiresAt !== undefined &&
          record.validFrom > record.expiresAt.slice(0, 10)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Context expiry cannot precede validFrom',
          });
        }
      }
    }
  });

export type HouseholdProfile = z.infer<typeof householdProfileSchema>;

export function createEmptyHouseholdProfile(
  now: string,
  timezone = 'UTC',
): HouseholdProfile {
  return householdProfileSchema.parse({
    schemaVersion: 'household-finance-profile.v1',
    revision: 0,
    updatedAt: now,
    currency: 'CAD',
    timezone,
    members: [],
    dependants: [],
    policies: {},
    incomeCadences: [],
    obligations: [],
    savingsGoals: [],
    accountRoles: [],
    merchantRules: [],
    transactionRules: [],
    exceptionalExpenses: [],
  });
}
