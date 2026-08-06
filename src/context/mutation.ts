import { z } from 'zod';

import {
  householdAccountRoleSchema,
  householdDependantSchema,
  householdExceptionalExpenseSchema,
  householdIncomeCadenceSchema,
  householdMemberSchema,
  householdMerchantRuleSchema,
  householdMoneyPolicySchema,
  householdObligationSchema,
  householdProfileSchema,
  householdRiskPolicySchema,
  householdSavingsGoalSchema,
  householdTextPolicySchema,
  householdTransactionRuleSchema,
  type HouseholdProfile,
} from './profile.js';

const mutationOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('upsert-member'),
    value: householdMemberSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-dependant'),
    value: householdDependantSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-income-cadence'),
    value: householdIncomeCadenceSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-obligation'),
    value: householdObligationSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-savings-goal'),
    value: householdSavingsGoalSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-account-role'),
    value: householdAccountRoleSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-merchant-rule'),
    value: householdMerchantRuleSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-transaction-rule'),
    value: householdTransactionRuleSchema,
  }),
  z.strictObject({
    kind: z.literal('upsert-exceptional-expense'),
    value: householdExceptionalExpenseSchema,
  }),
  z.strictObject({
    kind: z.literal('set-money-policy'),
    policy: z.enum([
      'minimumCashBufferMinorUnits',
      'emergencyFundTargetMinorUnits',
    ]),
    value: householdMoneyPolicySchema,
  }),
  z.strictObject({
    kind: z.literal('set-risk-policy'),
    policy: z.literal('safeBudgetRiskPreference'),
    value: householdRiskPolicySchema,
  }),
  z.strictObject({
    kind: z.literal('set-text-policy'),
    policy: z.enum(['giftPolicy', 'debtPriority']),
    value: householdTextPolicySchema,
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
    key: z.string().min(1).max(100),
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
]);

export const householdContextMutationSchema = z
  .strictObject({
    schemaVersion: z.literal('household-context-mutation.v1'),
    mutationId: z.uuid(),
    expectedRevision: z.number().int().safe().nonnegative(),
    actorId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
    requestedAt: z.iso.datetime({ offset: true }),
    operation: mutationOperationSchema,
  })
  .superRefine((mutation, context) => {
    if ('value' in mutation.operation) {
      const provenance = mutation.operation.value.provenance;
      if (
        provenance.actorId !== mutation.actorId ||
        provenance.messageId !== mutation.messageId ||
        provenance.recordedAt !== mutation.requestedAt ||
        (provenance.source !== 'talk-explicit' &&
          provenance.source !== 'talk-confirmed')
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Talk context mutation provenance must match its authenticated envelope',
          path: ['operation', 'value', 'provenance'],
        });
      }
    }
  });

export type HouseholdContextMutation = z.infer<
  typeof householdContextMutationSchema
>;

export class HouseholdContextRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super('Household context revision changed before mutation');
    this.name = 'HouseholdContextRevisionConflictError';
  }
}

export class HouseholdContextRecordNotFoundError extends Error {
  constructor() {
    super('Household context record was not found');
    this.name = 'HouseholdContextRecordNotFoundError';
  }
}

function upsertByKey<T>(
  values: readonly T[],
  replacement: T,
  key: (value: T) => string,
): T[] {
  const expectedKey = key(replacement);
  const index = values.findIndex((value) => key(value) === expectedKey);
  if (index < 0) {
    return [...values, replacement];
  }
  return values.map((value, position) =>
    position === index ? replacement : value,
  );
}

function removeByKey<T>(
  values: readonly T[],
  expectedKey: string,
  key: (value: T) => string,
): T[] {
  if (!values.some((value) => key(value) === expectedKey)) {
    throw new HouseholdContextRecordNotFoundError();
  }
  return values.filter((value) => key(value) !== expectedKey);
}

export function applyHouseholdContextMutation(
  current: HouseholdProfile,
  untrustedMutation: HouseholdContextMutation,
  appliedAt: string,
): HouseholdProfile {
  const profile = householdProfileSchema.parse(current);
  const mutation = householdContextMutationSchema.parse(untrustedMutation);
  z.iso.datetime({ offset: true }).parse(appliedAt);
  if (profile.revision !== mutation.expectedRevision) {
    throw new HouseholdContextRevisionConflictError(
      mutation.expectedRevision,
      profile.revision,
    );
  }
  if (!Number.isSafeInteger(profile.revision + 1)) {
    throw new RangeError('Household context revision is exhausted');
  }

  const next: HouseholdProfile = structuredClone(profile);
  const operation = mutation.operation;
  switch (operation.kind) {
    case 'upsert-member':
      next.members = upsertByKey(
        next.members,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-dependant':
      next.dependants = upsertByKey(
        next.dependants,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-income-cadence':
      next.incomeCadences = upsertByKey(
        next.incomeCadences,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-obligation':
      next.obligations = upsertByKey(
        next.obligations,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-savings-goal':
      next.savingsGoals = upsertByKey(
        next.savingsGoals,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-account-role':
      next.accountRoles = upsertByKey(
        next.accountRoles,
        operation.value,
        (value) => value.alias,
      );
      break;
    case 'upsert-merchant-rule':
      next.merchantRules = upsertByKey(
        next.merchantRules,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-transaction-rule':
      next.transactionRules = upsertByKey(
        next.transactionRules,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'upsert-exceptional-expense':
      next.exceptionalExpenses = upsertByKey(
        next.exceptionalExpenses,
        operation.value,
        (value) => value.id,
      );
      break;
    case 'set-money-policy':
      if (operation.policy === 'minimumCashBufferMinorUnits') {
        next.policies.minimumCashBufferMinorUnits = operation.value;
      } else {
        next.policies.emergencyFundTargetMinorUnits = operation.value;
      }
      break;
    case 'set-risk-policy':
      next.policies.safeBudgetRiskPreference = operation.value;
      break;
    case 'set-text-policy':
      if (operation.policy === 'giftPolicy') {
        next.policies.giftPolicy = operation.value;
      } else {
        next.policies.debtPriority = operation.value;
      }
      break;
    case 'remove-policy':
      delete next.policies[operation.policy];
      break;
    case 'remove-record':
      switch (operation.collection) {
        case 'members':
          next.members = removeByKey(
            next.members,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'dependants':
          next.dependants = removeByKey(
            next.dependants,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'incomeCadences':
          next.incomeCadences = removeByKey(
            next.incomeCadences,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'obligations':
          next.obligations = removeByKey(
            next.obligations,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'savingsGoals':
          next.savingsGoals = removeByKey(
            next.savingsGoals,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'accountRoles':
          next.accountRoles = removeByKey(
            next.accountRoles,
            operation.key,
            (value) => value.alias,
          );
          break;
        case 'merchantRules':
          next.merchantRules = removeByKey(
            next.merchantRules,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'transactionRules':
          next.transactionRules = removeByKey(
            next.transactionRules,
            operation.key,
            (value) => value.id,
          );
          break;
        case 'exceptionalExpenses':
          next.exceptionalExpenses = removeByKey(
            next.exceptionalExpenses,
            operation.key,
            (value) => value.id,
          );
          break;
      }
      break;
  }

  next.revision += 1;
  next.updatedAt = appliedAt;
  return householdProfileSchema.parse(next);
}
