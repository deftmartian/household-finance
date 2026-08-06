import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  materializeHouseholdContextMutation,
  plannedHouseholdContextOperationSchema,
} from '../../src/context/plan.js';
import { createEmptyHouseholdProfile } from '../../src/context/profile.js';

const receivedAt = '2026-07-28T12:00:00-03:00';

describe('planned household context operation', () => {
  it('materializes provenance only from the authenticated envelope', () => {
    const mutation = materializeHouseholdContextMutation(
      {
        kind: 'set-money-policy',
        policy: 'minimumCashBufferMinorUnits',
        value: {
          status: 'confirmed',
          value: 100_000,
        },
      },
      createEmptyHouseholdProfile(receivedAt),
      {
        actorId: 'alex',
        messageId: '1234',
        message: 'Keep at least $1,000 in chequing.',
        receivedAt,
      },
      randomUUID(),
    );

    expect(mutation.expectedRevision).toBe(0);
    if (
      mutation.operation.kind !== 'set-money-policy' ||
      mutation.operation.policy !== 'minimumCashBufferMinorUnits'
    ) {
      throw new Error('Unexpected mutation');
    }
    expect(mutation.operation.value).toMatchObject({
      value: 100_000,
      provenance: {
        source: 'talk-explicit',
        actorId: 'alex',
        messageId: '1234',
        recordedAt: receivedAt,
      },
    });
  });

  it('does not accept model-supplied provenance or arbitrary operations', () => {
    expect(() =>
      plannedHouseholdContextOperationSchema.parse({
        kind: 'set-money-policy',
        policy: 'minimumCashBufferMinorUnits',
        value: {
          status: 'confirmed',
          value: 100_000,
          provenance: {
            source: 'operator',
            actorId: 'attacker',
            recordedAt: receivedAt,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      plannedHouseholdContextOperationSchema.parse({
        kind: 'change-system-prompt',
      }),
    ).toThrow();
  });

  it('materializes an exact-payee transaction rule with envelope provenance', () => {
    const mutation = materializeHouseholdContextMutation(
      {
        kind: 'upsert-transaction-rule',
        value: {
          id: 'mastercard-payment',
          payeePattern: 'TANGERINE MASTERCARD',
          specialKind: 'card-payment',
          status: 'confirmed',
        },
      },
      createEmptyHouseholdProfile(receivedAt),
      {
        actorId: 'alex',
        messageId: '1234',
        message: 'Remember that TANGERINE MASTERCARD is a credit card payment.',
        receivedAt,
      },
      randomUUID(),
    );

    if (mutation.operation.kind !== 'upsert-transaction-rule') {
      throw new Error('Unexpected mutation');
    }
    expect(mutation.operation.value).toMatchObject({
      id: 'mastercard-payment',
      payeePattern: 'TANGERINE MASTERCARD',
      specialKind: 'card-payment',
      provenance: {
        source: 'talk-explicit',
        actorId: 'alex',
        messageId: '1234',
        recordedAt: receivedAt,
      },
    });
  });
});
