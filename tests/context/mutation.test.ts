import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  applyHouseholdContextMutation,
  createEmptyHouseholdProfile,
  HouseholdContextRecordNotFoundError,
  HouseholdContextRevisionConflictError,
  householdContextMutationSchema,
} from '../../src/context/index.js';

const requestedAt = '2026-07-28T12:00:00-03:00';

function envelope(operation: unknown, expectedRevision = 0) {
  return householdContextMutationSchema.parse({
    schemaVersion: 'household-context-mutation.v1',
    mutationId: randomUUID(),
    expectedRevision,
    actorId: 'alex',
    messageId: '100',
    requestedAt,
    operation,
  });
}

const provenance = {
  source: 'talk-explicit' as const,
  actorId: 'alex',
  messageId: '100',
  recordedAt: requestedAt,
};

describe('household context mutation', () => {
  it('adds and replaces authenticated household members', () => {
    const empty = createEmptyHouseholdProfile(requestedAt);
    const added = applyHouseholdContextMutation(
      empty,
      envelope({
        kind: 'upsert-member',
        value: {
          id: 'alex',
          displayName: 'Alex',
          kind: 'adult',
          talkActorIds: ['alex'],
          access: 'shared-adult',
          status: 'confirmed',
          provenance,
        },
      }),
      '2026-07-28T12:00:01-03:00',
    );
    const replaced = applyHouseholdContextMutation(
      added,
      envelope(
        {
          kind: 'upsert-member',
          value: {
            ...added.members[0],
            displayName: 'Alex B.',
            provenance,
          },
        },
        1,
      ),
      '2026-07-28T12:00:02-03:00',
    );

    expect(replaced).toMatchObject({
      revision: 2,
      updatedAt: '2026-07-28T12:00:02-03:00',
      members: [{ id: 'alex', displayName: 'Alex B.' }],
    });
  });

  it('sets and removes policy values without permitting arbitrary paths', () => {
    const empty = createEmptyHouseholdProfile(requestedAt);
    const set = applyHouseholdContextMutation(
      empty,
      envelope({
        kind: 'set-money-policy',
        policy: 'minimumCashBufferMinorUnits',
        value: {
          value: 200_000,
          status: 'confirmed',
          provenance,
        },
      }),
      '2026-07-28T12:00:01-03:00',
    );
    const removed = applyHouseholdContextMutation(
      set,
      envelope(
        {
          kind: 'remove-policy',
          policy: 'minimumCashBufferMinorUnits',
        },
        1,
      ),
      '2026-07-28T12:00:02-03:00',
    );

    expect(set.policies.minimumCashBufferMinorUnits?.value).toBe(200_000);
    expect(removed.policies.minimumCashBufferMinorUnits).toBeUndefined();
    expect(
      householdContextMutationSchema.safeParse({
        ...envelope({
          kind: 'remove-policy',
          policy: 'giftPolicy',
        }),
        operation: {
          kind: 'remove-policy',
          policy: '__proto__',
        },
      }).success,
    ).toBe(false);
  });

  it('upserts and removes exact-payee special transaction rules', () => {
    const empty = createEmptyHouseholdProfile(requestedAt);
    const added = applyHouseholdContextMutation(
      empty,
      envelope({
        kind: 'upsert-transaction-rule',
        value: {
          id: 'mastercard-payment',
          payeePattern: 'TANGERINE MASTERCARD',
          specialKind: 'card-payment',
          status: 'confirmed',
          provenance,
        },
      }),
      '2026-07-28T12:00:01-03:00',
    );
    const replaced = applyHouseholdContextMutation(
      added,
      envelope(
        {
          kind: 'upsert-transaction-rule',
          value: {
            ...added.transactionRules[0],
            specialKind: 'transfer',
            provenance,
          },
        },
        1,
      ),
      '2026-07-28T12:00:02-03:00',
    );
    const removed = applyHouseholdContextMutation(
      replaced,
      envelope(
        {
          kind: 'remove-record',
          collection: 'transactionRules',
          key: 'mastercard-payment',
        },
        2,
      ),
      '2026-07-28T12:00:03-03:00',
    );

    expect(added.transactionRules[0]).toMatchObject({
      id: 'mastercard-payment',
      specialKind: 'card-payment',
    });
    expect(replaced.transactionRules[0]?.specialKind).toBe('transfer');
    expect(removed.transactionRules).toEqual([]);
  });

  it('fails closed when the profile revision changed', () => {
    const current = {
      ...createEmptyHouseholdProfile(requestedAt),
      revision: 2,
    };
    expect(() =>
      applyHouseholdContextMutation(
        current,
        envelope({
          kind: 'remove-policy',
          policy: 'giftPolicy',
        }),
        '2026-07-28T12:00:01-03:00',
      ),
    ).toThrow(HouseholdContextRevisionConflictError);
  });

  it('rejects mutation provenance that does not match the Talk envelope', () => {
    expect(
      householdContextMutationSchema.safeParse({
        ...envelope({
          kind: 'remove-policy',
          policy: 'giftPolicy',
        }),
        operation: {
          kind: 'upsert-member',
          value: {
            id: 'alex',
            displayName: 'Alex',
            kind: 'adult',
            talkActorIds: ['alex'],
            access: 'shared-adult',
            status: 'confirmed',
            provenance: {
              ...provenance,
              actorId: 'attacker',
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it('does not silently succeed when removing an absent record', () => {
    expect(() =>
      applyHouseholdContextMutation(
        createEmptyHouseholdProfile(requestedAt),
        envelope({
          kind: 'remove-record',
          collection: 'merchantRules',
          key: 'missing',
        }),
        '2026-07-28T12:00:01-03:00',
      ),
    ).toThrow(HouseholdContextRecordNotFoundError);
  });
});
