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
      schemaVersion: 'actual-read-freshness.v1',
      generation: 1,
      state: 'succeeded',
      lastAttemptAt: '2026-07-28T10:00:00.000Z',
      lastSuccessfulSyncAt: '2026-07-28T10:00:00.000Z',
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
