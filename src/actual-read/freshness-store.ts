import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ActualReadFreshness } from './port.js';

export type StoredActualReadFreshness = Omit<
  ActualReadFreshness,
  'actualBudgetAsOf' | 'bankFeedAsOf' | 'expectedBankDelayHours'
>;

const persistedSchema = z
  .strictObject({
    schemaVersion: z.literal('actual-read-freshness.v1'),
    generation: z.number().int().safe().nonnegative(),
    state: z.enum(['never', 'syncing', 'succeeded', 'failed']),
    lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
    lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine((value, context) => {
    const never = value.state === 'never';
    if (
      (never &&
        (value.generation !== 0 ||
          value.lastAttemptAt !== null ||
          value.lastSuccessfulSyncAt !== null)) ||
      (!never && (value.generation === 0 || value.lastAttemptAt === null)) ||
      (value.state === 'succeeded' &&
        value.lastSuccessfulSyncAt !== value.lastAttemptAt) ||
      (value.lastSuccessfulSyncAt !== null &&
        value.lastAttemptAt !== null &&
        Date.parse(value.lastSuccessfulSyncAt) >
          Date.parse(value.lastAttemptAt))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Actual read freshness state is inconsistent',
      });
    }
  });

export type PersistedActualReadFreshness = z.infer<typeof persistedSchema>;

export interface ActualReadFreshnessStore {
  load(): Promise<PersistedActualReadFreshness>;
  save(state: PersistedActualReadFreshness): Promise<void>;
}

export function initialActualReadFreshness(): PersistedActualReadFreshness {
  return {
    schemaVersion: 'actual-read-freshness.v1',
    generation: 0,
    state: 'never',
    lastAttemptAt: null,
    lastSuccessfulSyncAt: null,
  };
}

export class FileActualReadFreshnessStore implements ActualReadFreshnessStore {
  constructor(readonly path: string) {}

  async load(): Promise<PersistedActualReadFreshness> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return initialActualReadFreshness();
      }
      throw error;
    }
    return persistedSchema.parse(JSON.parse(content) as unknown);
  }

  async save(untrustedState: PersistedActualReadFreshness): Promise<void> {
    const state = persistedSchema.parse(untrustedState);
    const temporaryPath = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      const directory = await open(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      bytes.fill(0);
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export function publicActualReadFreshness(
  state: PersistedActualReadFreshness,
  now: Date,
  maximumAgeSeconds: number,
  outcomeOverride?: 'skipped-recent',
): StoredActualReadFreshness {
  const nowTime = now.valueOf();
  const successfulTime =
    state.lastSuccessfulSyncAt === null
      ? Number.NaN
      : Date.parse(state.lastSuccessfulSyncAt);
  const isFresh =
    Number.isFinite(nowTime) &&
    Number.isFinite(successfulTime) &&
    nowTime >= successfulTime &&
    nowTime - successfulTime <= maximumAgeSeconds * 1_000;
  return {
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
    lastOutcome:
      outcomeOverride ?? (state.state === 'syncing' ? 'failed' : state.state),
    isFresh,
  };
}
