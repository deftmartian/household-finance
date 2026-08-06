import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadActualWriterConfig } from '../src/actual-writer-config.js';
import {
  ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
  ACTUAL_PRODUCTION_SCOPE,
  actualProductionContractFingerprint,
  actualProductionSentinelPayeeName,
} from '../src/integrations/actual/index.js';

function files() {
  const directory = mkdtempSync(join(tmpdir(), 'actual-writer-config-'));
  const passwordPath = join(directory, 'password');
  const contractPath = join(directory, 'contract');
  const signingKeyPath = join(directory, 'update-signing-key');
  const identity = {
    schemaVersion: ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
    scope: ACTUAL_PRODUCTION_SCOPE,
    nonce: 'a'.repeat(64),
    budget: { syncId: 'budget-sync-id', name: 'Household Budget' },
    accounts: {
      card: { id: 'actual-card-id', name: 'Household Card' },
    },
    categories: {
      review: {
        id: 'actual-review-id',
        name: 'Receipt Review',
        kind: 'expense' as const,
      },
    },
    expectedCurrency: 'CAD' as const,
    maximumReceiptAmountMinorUnits: 100_000,
    receiptDateWindow: { pastDays: 90, futureDays: 1 },
  };
  const fingerprint = actualProductionContractFingerprint(identity);
  const contract = {
    ...identity,
    fingerprint,
    sentinelPayee: {
      id: 'actual-sentinel-id',
      name: actualProductionSentinelPayeeName(fingerprint),
    },
  };
  writeFileSync(passwordPath, 'test-password\n', { mode: 0o600 });
  writeFileSync(contractPath, JSON.stringify(contract), { mode: 0o600 });
  writeFileSync(
    signingKeyPath,
    `${JSON.stringify({
      schemaVersion: 'actual-update-signing-keyring.v1',
      targetReferenceKey: 'k'.repeat(48),
      keys: { 'production-v1': 'k'.repeat(48) },
    })}\n`,
    { mode: 0o600 },
  );
  return { passwordPath, contractPath, signingKeyPath };
}

function environment(
  privateFiles: ReturnType<typeof files>,
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATA_DIR: '/data',
    ACTUAL_WRITER_STATE_DIR: '/writer-data',
    ACTUAL_SERVER_URL: 'http://actual-server:5006',
    ACTUAL_SERVER_PASSWORD_FILE: privateFiles.passwordPath,
    ACTUAL_PRODUCTION_CONTRACT_FILE: privateFiles.contractPath,
    ACTUAL_UPDATE_SIGNING_KEY_FILE: privateFiles.signingKeyPath,
  };
}

describe('actual writer configuration', () => {
  it('loads the dedicated production writer configuration', () => {
    const config = loadActualWriterConfig(environment(files()));
    expect(config).toMatchObject({
      databasePath: '/data/attachment-shadow.sqlite',
      actualApiDataDirectory: '/writer-data/actual-api',
      serverUrl: 'http://actual-server:5006',
      serverPassword: 'test-password',
      updateSigningKeys: { 'production-v1': 'k'.repeat(48) },
      updateTargetReferenceKey: 'k'.repeat(48),
      updateSigningKeyId: 'production-v1',
      pollIntervalMs: 1_000,
      operationTimeoutMs: 120_000,
    });
    expect(config.productionContract.expectedCurrency).toBe('CAD');
  });

  it('bounds the operation watchdog configuration', () => {
    const privateFiles = files();
    expect(() =>
      loadActualWriterConfig({
        ...environment(privateFiles),
        ACTUAL_WRITER_OPERATION_TIMEOUT_MS: '9999',
      }),
    ).toThrow();
    expect(
      loadActualWriterConfig({
        ...environment(privateFiles),
        ACTUAL_WRITER_OPERATION_TIMEOUT_MS: '30000',
      }).operationTimeoutMs,
    ).toBe(30_000);
    expect(() =>
      loadActualWriterConfig({
        ...environment(privateFiles),
        ACTUAL_WRITER_OPERATION_TIMEOUT_MS: '120001',
      }),
    ).toThrow();
  });

  it('rejects external Actual endpoints and overlapping state', () => {
    const privateFiles = files();
    expect(() =>
      loadActualWriterConfig({
        ...environment(privateFiles),
        ACTUAL_SERVER_URL: 'https://actual.example.test',
      }),
    ).toThrow(/internal/);
    expect(() =>
      loadActualWriterConfig({
        ...environment(privateFiles),
        ACTUAL_WRITER_STATE_DIR: '/data/writer',
      }),
    ).toThrow(/must not overlap/);
  });

  it('rejects altered production contracts before reading credentials into an adapter', () => {
    const privateFiles = files();
    writeFileSync(
      privateFiles.contractPath,
      JSON.stringify({
        schemaVersion: ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
        scope: ACTUAL_PRODUCTION_SCOPE,
        invalid: true,
      }),
      { mode: 0o600 },
    );
    expect(() => loadActualWriterConfig(environment(privateFiles))).toThrow();
  });

  it('requires absolute, exact one-line secret files', () => {
    const privateFiles = files();
    expect(() =>
      loadActualWriterConfig({
        ...environment(privateFiles),
        ACTUAL_UPDATE_SIGNING_KEY_FILE: 'relative/signing-key',
      }),
    ).toThrow(/absolute path/);

    writeFileSync(
      privateFiles.signingKeyPath,
      `${'k'.repeat(48)}\nextra-line\n`,
      { mode: 0o600 },
    );
    expect(() => loadActualWriterConfig(environment(privateFiles))).toThrow(
      /one non-empty line/,
    );
  });

  it('rejects an obsolete bare signing secret', () => {
    const privateFiles = files();
    writeFileSync(privateFiles.signingKeyPath, `${'k'.repeat(48)}\n`, {
      mode: 0o600,
    });
    expect(() => loadActualWriterConfig(environment(privateFiles))).toThrow(
      /valid JSON/,
    );
  });

  it('loads retained verification keys with a stable target-reference key', () => {
    const privateFiles = files();
    const retainedKeyring = {
      schemaVersion: 'actual-update-signing-keyring.v1',
      targetReferenceKey: 't'.repeat(48),
      keys: {
        'production-v0': 'o'.repeat(48),
        'production-v1': 'n'.repeat(48),
      },
    };
    writeFileSync(
      privateFiles.signingKeyPath,
      `${JSON.stringify(retainedKeyring)}\n`,
      { mode: 0o600 },
    );

    expect(loadActualWriterConfig(environment(privateFiles))).toMatchObject({
      updateSigningKeys: retainedKeyring.keys,
      updateTargetReferenceKey: retainedKeyring.targetReferenceKey,
      updateSigningKeyId: 'production-v1',
    });
  });

  it('rejects a keyring that omits the configured active key', () => {
    const privateFiles = files();
    writeFileSync(
      privateFiles.signingKeyPath,
      `${JSON.stringify({
        schemaVersion: 'actual-update-signing-keyring.v1',
        targetReferenceKey: 't'.repeat(48),
        keys: { 'production-v0': 'o'.repeat(48) },
      })}\n`,
      { mode: 0o600 },
    );

    expect(() => loadActualWriterConfig(environment(privateFiles))).toThrow(
      /absent from the retained keyring/,
    );
  });
});
