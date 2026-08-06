import { describe, expect, it } from 'vitest';

import {
  ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
  ACTUAL_PRODUCTION_SCOPE,
  actualProductionContractFingerprint,
  actualProductionSentinelPayeeName,
  parseActualProductionContract,
} from '../../../src/integrations/actual/production-contract.js';
import type {
  ActualProductionContract,
  ActualProductionContractIdentity,
} from '../../../src/integrations/actual/production-contract.js';

const identity: ActualProductionContractIdentity = {
  schemaVersion: ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
  scope: ACTUAL_PRODUCTION_SCOPE,
  nonce: 'a'.repeat(64),
  budget: {
    syncId: 'household-budget-sync-id',
    name: 'Household Budget',
  },
  accounts: {
    daily: { id: 'actual-daily-account', name: 'Daily Chequing' },
    visa: { id: 'actual-visa-account', name: 'Household Visa' },
  },
  categories: {
    groceries: {
      id: 'actual-groceries',
      name: 'Groceries',
      kind: 'expense',
    },
    review: {
      id: 'actual-receipt-review',
      name: 'Receipt Review',
      kind: 'expense',
    },
  },
  expectedCurrency: 'CAD',
  maximumReceiptAmountMinorUnits: 500_000,
  receiptDateWindow: {
    pastDays: 120,
    futureDays: 1,
  },
};

function contract(
  source: ActualProductionContractIdentity = identity,
): ActualProductionContract {
  const fingerprint = actualProductionContractFingerprint(source);
  return {
    ...source,
    fingerprint,
    sentinelPayee: {
      id: 'actual-production-sentinel',
      name: actualProductionSentinelPayeeName(fingerprint),
    },
  };
}

describe('Actual production contract', () => {
  it('parses one strict credential-free contract', () => {
    expect(parseActualProductionContract(contract())).toEqual(contract());
  });

  it('fingerprints aliases canonically rather than by insertion order', () => {
    const reordered: ActualProductionContractIdentity = {
      ...identity,
      accounts: {
        visa: identity.accounts.visa!,
        daily: identity.accounts.daily!,
      },
      categories: {
        review: identity.categories.review!,
        groceries: identity.categories.groceries!,
      },
    };

    expect(actualProductionContractFingerprint(reordered)).toBe(
      actualProductionContractFingerprint(identity),
    );
  });

  it('rejects extra fields, including anything resembling a credential', () => {
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        serverPassword: 'must-not-be-in-contract',
      }),
    ).toThrow();
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        budget: {
          ...contract().budget,
          unexpected: true,
        },
      }),
    ).toThrow();
  });

  it('requires nonempty alias maps with distinct Actual identities', () => {
    const emptyAccounts = {
      ...identity,
      accounts: {},
    };
    expect(() =>
      parseActualProductionContract(contract(emptyAccounts)),
    ).toThrow();

    const duplicateCategoryId = {
      ...identity,
      categories: {
        groceries: identity.categories.groceries!,
        review: {
          id: identity.categories.groceries!.id,
          name: 'Receipt Review',
          kind: 'expense' as const,
        },
      },
    };
    expect(() =>
      parseActualProductionContract(contract(duplicateCategoryId)),
    ).toThrow();
  });

  it('rejects altered fingerprints and sentinel identities', () => {
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        fingerprint: 'b'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        sentinelPayee: {
          ...contract().sentinelPayee,
          name: 'Wrong sentinel',
        },
      }),
    ).toThrow();
  });

  it('binds CAD, receipt amount, and past/future date limits', () => {
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        expectedCurrency: 'USD',
      }),
    ).toThrow();
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        maximumReceiptAmountMinorUnits: 0,
      }),
    ).toThrow();
    expect(() =>
      parseActualProductionContract({
        ...contract(),
        receiptDateWindow: {
          pastDays: -1,
          futureDays: 1,
        },
      }),
    ).toThrow();
  });
});
