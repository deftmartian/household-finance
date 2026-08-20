import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileActualReadFreshnessStore,
  initialActualReadFreshness,
  publicActualReadFreshness,
} from '../../src/actual-read/freshness-store.js';

describe('Actual read freshness store', () => {
  it('atomically persists only bounded fixed freshness state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-read-freshness-'));
    chmodSync(directory, 0o700);
    const path = join(directory, 'freshness.json');
    const store = new FileActualReadFreshnessStore(path);
    expect(await store.load()).toEqual(initialActualReadFreshness());

    await store.save({
      schemaVersion: 'actual-read-freshness.v2',
      generation: 1,
      state: 'succeeded',
      lastAttemptAt: '2026-07-28T10:00:00.000Z',
      lastSuccessfulSyncAt: '2026-07-28T10:00:00.000Z',
      lastAnySuccessfulSyncAt: '2026-07-28T10:00:00.000Z',
      lastAttemptSummary: {
        attemptedAccountCount: 4,
        succeededAccountCount: 4,
        failedAccountCount: 0,
        budgetRefreshSucceeded: true,
      },
    });

    expect(await store.load()).toMatchObject({
      generation: 1,
      state: 'succeeded',
    });
    const serialized = readFileSync(path, 'utf8');
    expect(serialized).not.toContain('account');
    expect(serialized).not.toContain('error');
    expect(
      publicActualReadFreshness(
        await store.load(),
        new Date('2026-07-28T10:10:00.000Z'),
        900,
      ).isFresh,
    ).toBe(true);
    expect(
      publicActualReadFreshness(
        await store.load(),
        new Date('2026-07-28T10:20:00.000Z'),
        900,
      ).isFresh,
    ).toBe(false);
  });

  it('upgrades v1 state and writes a rollback-compatible legacy mirror', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-read-freshness-'));
    chmodSync(directory, 0o700);
    const path = join(directory, 'freshness.v2.json');
    const legacyPath = join(directory, 'freshness.json');
    const legacy = {
      schemaVersion: 'actual-read-freshness.v1',
      generation: 2,
      state: 'failed',
      lastAttemptAt: '2026-07-28T10:00:00.000Z',
      lastSuccessfulSyncAt: '2026-07-28T09:00:00.000Z',
    };
    const legacyBytes = Buffer.from(`${JSON.stringify(legacy)}\n`, 'utf8');
    const handle = await import('node:fs/promises').then(({ open }) =>
      open(legacyPath, 'wx', 0o600),
    );
    await handle.writeFile(legacyBytes);
    await handle.close();
    legacyBytes.fill(0);

    const store = new FileActualReadFreshnessStore(path, legacyPath);
    expect(await store.load()).toMatchObject({
      schemaVersion: 'actual-read-freshness.v2',
      state: 'failed',
      lastAnySuccessfulSyncAt: '2026-07-28T09:00:00.000Z',
      lastAttemptSummary: null,
    });
    await store.save({
      schemaVersion: 'actual-read-freshness.v2',
      generation: 3,
      state: 'partial',
      lastAttemptAt: '2026-07-28T11:00:00.000Z',
      lastSuccessfulSyncAt: '2026-07-28T09:00:00.000Z',
      lastAnySuccessfulSyncAt: '2026-07-28T11:00:00.000Z',
      lastAttemptSummary: {
        attemptedAccountCount: 4,
        succeededAccountCount: 3,
        failedAccountCount: 1,
        budgetRefreshSucceeded: true,
      },
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      schemaVersion: 'actual-read-freshness.v2',
      state: 'partial',
    });
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toMatchObject({
      schemaVersion: 'actual-read-freshness.v1',
      state: 'failed',
      lastSuccessfulSyncAt: '2026-07-28T09:00:00.000Z',
    });
  });

  it('rejects corrupt or expanded persisted state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-read-freshness-'));
    const path = join(directory, 'freshness.json');
    const store = new FileActualReadFreshnessStore(path);
    await expect(
      store.save({
        ...initialActualReadFreshness(),
        privateAccountId: 'must-not-persist',
      } as Parameters<typeof store.save>[0]),
    ).rejects.toThrow();
  });
});
