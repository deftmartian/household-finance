import { describe, expect, it } from 'vitest';

import {
  ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
  ACTUAL_READ_CONTRACT_SCOPE,
  actualReadContractFingerprint,
  parseActualReadContract,
} from '../../src/actual-read/read-contract.js';

function identity() {
  return {
    schemaVersion: ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
    scope: ACTUAL_READ_CONTRACT_SCOPE,
    nonce: 'a'.repeat(64),
    budget: { syncId: 'budget-sync', name: 'Household Budget' },
    accounts: {
      card: {
        id: 'account-card',
        name: 'Household Card',
        role: 'credit-card' as const,
        onBudget: true,
        bankSyncEnabled: true,
        lastFour: '4242',
      },
      chequing: {
        id: 'account-chequing',
        name: 'Chequing',
        role: 'spending' as const,
        onBudget: true,
        bankSyncEnabled: true,
      },
    },
    categories: {
      groceries: { name: 'Groceries' },
      income: { name: 'Income' },
    },
    expectedCurrency: 'CAD' as const,
    maximumAggregateRangeDays: 366,
    maximumExplanationRangeDays: 90,
    maximumExplanationRows: 20,
    maximumObservationRangeDays: 45,
    maximumObservationRows: 500,
    freshnessMaximumAgeSeconds: 1_800,
    expectedBankDelayHours: 24,
    bankSyncMinimumIntervalSeconds: 300,
  };
}

describe('Actual read contract', () => {
  it('fingerprints every identity, sync flag, and disclosure bound', () => {
    const source = identity();
    const contract = parseActualReadContract({
      ...source,
      fingerprint: actualReadContractFingerprint(source),
    });

    expect(contract.scope).toBe(ACTUAL_READ_CONTRACT_SCOPE);
    expect(() =>
      parseActualReadContract({
        ...contract,
        maximumExplanationRows: 19,
      }),
    ).toThrow();
    expect(() =>
      parseActualReadContract({
        ...contract,
        accounts: {
          ...contract.accounts,
          card: { ...contract.accounts.card!, bankSyncEnabled: false },
        },
      }),
    ).toThrow();
    expect(() =>
      parseActualReadContract({
        ...contract,
        accounts: {
          ...contract.accounts,
          card: { ...contract.accounts.card!, lastFour: '9999' },
        },
      }),
    ).toThrow();
    expect(() =>
      parseActualReadContract({
        ...contract,
        categories: {
          ...contract.categories,
          groceries: { name: 'Food' },
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate IDs, no sync account, and an over-broad range', () => {
    const source = identity();
    expect(() =>
      actualReadContractFingerprint({
        ...source,
        accounts: {
          first: source.accounts.card,
          second: source.accounts.card,
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseActualReadContract({
        ...source,
        accounts: {
          first: source.accounts.card,
          second: source.accounts.card,
        },
        fingerprint: actualReadContractFingerprint({
          ...source,
          accounts: {
            first: source.accounts.card,
            second: source.accounts.card,
          },
        }),
      }),
    ).toThrow();
    const duplicateCategories = {
      ...source,
      categories: {
        first: { name: 'Groceries' },
        second: { name: 'groceries' },
      },
    };
    expect(() =>
      parseActualReadContract({
        ...duplicateCategories,
        fingerprint: actualReadContractFingerprint(duplicateCategories),
      }),
    ).toThrow();
    const noSync = {
      ...source,
      accounts: Object.fromEntries(
        Object.entries(source.accounts).map(([alias, account]) => [
          alias,
          { ...account, bankSyncEnabled: false },
        ]),
      ),
    };
    expect(() =>
      parseActualReadContract({
        ...noSync,
        fingerprint: actualReadContractFingerprint(noSync),
      }),
    ).toThrow();
    expect(() =>
      parseActualReadContract({
        ...source,
        maximumAggregateRangeDays: 3_661,
        fingerprint: 'b'.repeat(64),
      }),
    ).toThrow();
  });
});
