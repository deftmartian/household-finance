import { describe, expect, it } from 'vitest';

import {
  createEmptyHouseholdProfile,
  householdProfileSchema,
} from '../../src/context/profile.js';

const provenance = {
  source: 'talk-explicit' as const,
  actorId: 'alex',
  messageId: '123',
  recordedAt: '2026-07-28T12:00:00-03:00',
};

describe('household profile', () => {
  it('creates a typed empty CAD household profile', () => {
    expect(createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00')).toEqual({
      schemaVersion: 'household-finance-profile.v1',
      revision: 0,
      updatedAt: '2026-07-28T12:00:00-03:00',
      currency: 'CAD',
      timezone: 'UTC',
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
  });

  it('defaults transaction rules for existing v1 profiles', () => {
    const current = createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00');
    const { transactionRules, ...existingV1Profile } = current;

    expect(transactionRules).toEqual([]);
    expect(
      householdProfileSchema.parse(existingV1Profile).transactionRules,
    ).toEqual([]);
  });

  it('accepts unique exact-payee special transaction rules', () => {
    const parsed = householdProfileSchema.parse({
      ...createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00'),
      transactionRules: [
        {
          id: 'mastercard-payment',
          payeePattern: 'TANGERINE MASTERCARD',
          specialKind: 'card-payment',
          status: 'confirmed',
          provenance,
        },
        {
          id: 'line-of-credit-payment',
          payeePattern: 'TANGERINE LINE OF CREDIT',
          specialKind: 'debt-payment',
          status: 'confirmed',
          provenance,
        },
      ],
    });

    expect(parsed.transactionRules.map((rule) => rule.specialKind)).toEqual([
      'card-payment',
      'debt-payment',
    ]);
  });

  it('rejects conflicting transaction rule IDs and payee patterns', () => {
    const parsed = householdProfileSchema.safeParse({
      ...createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00'),
      transactionRules: [
        {
          id: 'card-payment',
          payeePattern: 'TANGERINE MASTERCARD',
          specialKind: 'card-payment',
          status: 'confirmed',
          provenance,
        },
        {
          id: 'card-payment',
          payeePattern: 'tangerine mastercard',
          specialKind: 'transfer',
          status: 'candidate',
          provenance,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Transaction rule IDs must be unique',
        'Transaction rule payee patterns must be unique',
      ]),
    );
  });

  it('accepts the initial shared household and account-role context', () => {
    expect(
      householdProfileSchema
        .parse({
          ...createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00'),
          revision: 1,
          members: [
            {
              id: 'alex',
              displayName: 'Alex',
              kind: 'adult',
              talkActorIds: ['alex'],
              access: 'shared-adult',
              status: 'confirmed',
              provenance,
            },
            {
              id: 'sam',
              displayName: 'Sam',
              kind: 'adult',
              talkActorIds: ['sam'],
              access: 'shared-adult',
              status: 'confirmed',
              provenance,
            },
          ],
          policies: {
            minimumCashBufferMinorUnits: {
              value: 200_000,
              status: 'confirmed',
              provenance,
            },
          },
          accountRoles: [
            {
              alias: 'primary-chequing',
              displayName: 'Primary chequing',
              role: 'primary-chequing',
              budgetTreatment: 'on-budget',
              status: 'confirmed',
              provenance,
            },
            {
              alias: 'cashback-staging',
              displayName: 'Cashback staging',
              role: 'cashback-staging',
              budgetTreatment: 'on-budget',
              status: 'confirmed',
              provenance,
            },
            {
              alias: 'line-of-credit',
              displayName: 'Line of credit',
              role: 'debt',
              budgetTreatment: 'off-budget',
              status: 'confirmed',
              provenance,
            },
          ],
        })
        .members.map((member) => member.id),
    ).toEqual(['alex', 'sam']);
  });

  it('rejects duplicate Talk identities and dangling account-role references', () => {
    const parsed = householdProfileSchema.safeParse({
      ...createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00'),
      members: [
        {
          id: 'alex',
          displayName: 'Alex',
          kind: 'adult',
          talkActorIds: ['same-user'],
          access: 'shared-adult',
          status: 'confirmed',
          provenance,
        },
        {
          id: 'sam',
          displayName: 'Sam',
          kind: 'adult',
          talkActorIds: ['same-user'],
          access: 'shared-adult',
          status: 'confirmed',
          provenance,
        },
      ],
      obligations: [
        {
          id: 'internet',
          name: 'Internet',
          amountMinorUnits: 10_000,
          amountCertain: true,
          cadence: 'monthly',
          priority: 'required',
          accountRoleAlias: 'missing',
          status: 'confirmed',
          provenance,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Talk actor IDs must be unique',
        'Obligation accountRoleAlias must reference a profile account role',
      ]),
    );
  });

  it('rejects income references to unknown members and stale validity ranges', () => {
    const parsed = householdProfileSchema.safeParse({
      ...createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00'),
      incomeCadences: [
        {
          id: 'unknown-income',
          memberId: 'unknown',
          name: 'Unknown income',
          cadence: 'monthly',
          reliability: 'uncertain',
          status: 'candidate',
          validFrom: '2026-08-01',
          expiresAt: '2026-07-31T23:59:59-03:00',
          provenance,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Income cadence memberId must reference a profile member',
        'Context expiry cannot precede validFrom',
      ]),
    );
  });
});
