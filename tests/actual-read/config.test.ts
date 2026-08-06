import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadActualReaderServiceConfig } from '../../src/actual-read/config.js';
import {
  ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
  ACTUAL_READ_CONTRACT_SCOPE,
  actualReadContractFingerprint,
} from '../../src/actual-read/read-contract.js';

function files() {
  const directory = mkdtempSync(join(tmpdir(), 'actual-read-config-'));
  const password = join(directory, 'password');
  const contractPath = join(directory, 'contract');
  const identity = {
    schemaVersion: ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
    scope: ACTUAL_READ_CONTRACT_SCOPE,
    nonce: 'a'.repeat(64),
    budget: { syncId: 'budget-sync', name: 'Budget' },
    accounts: {
      daily: {
        id: 'account-daily',
        name: 'Daily',
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
  writeFileSync(password, 'synthetic-password\n', { mode: 0o600 });
  writeFileSync(
    contractPath,
    JSON.stringify({
      ...identity,
      fingerprint: actualReadContractFingerprint(identity),
    }),
    { mode: 0o600 },
  );
  return { password, contractPath };
}

function environment(privateFiles: ReturnType<typeof files>) {
  return {
    NODE_ENV: 'production',
    ACTUAL_SERVER_PASSWORD_FILE: privateFiles.password,
    ACTUAL_READ_CONTRACT_FILE: privateFiles.contractPath,
  };
}

describe('Actual reader service config', () => {
  it('uses the dedicated internal defaults and file-backed inputs', () => {
    expect(loadActualReaderServiceConfig(environment(files()))).toMatchObject({
      host: '0.0.0.0',
      port: 4_370,
      dataDirectory: '/reader-data',
      serverUrl: 'http://actual-server:5006',
      serverPassword: 'synthetic-password',
      operationTimeoutMs: 120_000,
    });
  });

  it('requires the exact internal Actual origin', () => {
    const privateFiles = files();
    expect(() =>
      loadActualReaderServiceConfig({
        ...environment(privateFiles),
        ACTUAL_SERVER_URL: 'https://actual.example.test',
      }),
    ).toThrow(/internal/);
  });
});
