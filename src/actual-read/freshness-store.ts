import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ActualReadFreshness } from './port.js';

export type StoredActualReadFreshness = Omit<
  ActualReadFreshness,
  'actualBudgetAsOf' | 'bankFeedAsOf' | 'expectedBankDelayHours'
>;

const attemptSummarySchema = z.strictObject({
  attemptedAccountCount: z.number().int().safe().positive(),
  succeededAccountCount: z.number().int().safe().nonnegative(),
  failedAccountCount: z.number().int().safe().nonnegative(),
  budgetRefreshSucceeded: z.boolean(),
});

const persistedSchema = z
  .strictObject({
    schemaVersion: z.literal('actual-read-freshness.v2'),
    generation: z.number().int().safe().nonnegative(),
    state: z.enum(['never', 'syncing', 'succeeded', 'partial', 'failed']),
    lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
    lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
    lastAnySuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
    lastAttemptSummary: attemptSummarySchema.nullable(),
  })
  .superRefine((value, context) => {
    const never = value.state === 'never';
    const summary = value.lastAttemptSummary;
    const countsAreConsistent =
      summary === null ||
      summary.succeededAccountCount + summary.failedAccountCount ===
        summary.attemptedAccountCount;
    const succeededStateIsConsistent =
      value.state !== 'succeeded' ||
      ((summary === null ||
        (summary.failedAccountCount === 0 && summary.budgetRefreshSucceeded)) &&
        value.lastSuccessfulSyncAt === value.lastAttemptAt &&
        value.lastAnySuccessfulSyncAt === value.lastAttemptAt);
    const partialStateIsConsistent =
      value.state !== 'partial' ||
      (summary !== null &&
        summary.succeededAccountCount > 0 &&
        summary.failedAccountCount > 0 &&
        summary.budgetRefreshSucceeded &&
        value.lastAnySuccessfulSyncAt === value.lastAttemptAt);
    if (
      (never &&
        (value.generation !== 0 ||
          value.lastAttemptAt !== null ||
          value.lastSuccessfulSyncAt !== null ||
          value.lastAnySuccessfulSyncAt !== null ||
          summary !== null)) ||
      (!never && (value.generation === 0 || value.lastAttemptAt === null)) ||
      (value.state === 'syncing' && summary !== null) ||
      !countsAreConsistent ||
      !succeededStateIsConsistent ||
      !partialStateIsConsistent ||
      (value.lastSuccessfulSyncAt !== null &&
        value.lastAttemptAt !== null &&
        Date.parse(value.lastSuccessfulSyncAt) >
          Date.parse(value.lastAttemptAt)) ||
      (value.lastAnySuccessfulSyncAt !== null &&
        value.lastAttemptAt !== null &&
        Date.parse(value.lastAnySuccessfulSyncAt) >
          Date.parse(value.lastAttemptAt)) ||
      (value.lastSuccessfulSyncAt !== null &&
        value.lastAnySuccessfulSyncAt !== null &&
        Date.parse(value.lastSuccessfulSyncAt) >
          Date.parse(value.lastAnySuccessfulSyncAt))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Actual read freshness state is inconsistent',
      });
    }
  });

export type PersistedActualReadFreshness = z.infer<typeof persistedSchema>;

const legacyPersistedSchema = z.strictObject({
  schemaVersion: z.literal('actual-read-freshness.v1'),
  generation: z.number().int().safe().nonnegative(),
  state: z.enum(['never', 'syncing', 'succeeded', 'failed']),
  lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
});

type LegacyPersistedActualReadFreshness = z.infer<typeof legacyPersistedSchema>;

export interface ActualReadFreshnessStore {
  load(): Promise<PersistedActualReadFreshness>;
  save(state: PersistedActualReadFreshness): Promise<void>;
}

export function initialActualReadFreshness(): PersistedActualReadFreshness {
  return {
    schemaVersion: 'actual-read-freshness.v2',
    generation: 0,
    state: 'never',
    lastAttemptAt: null,
    lastSuccessfulSyncAt: null,
    lastAnySuccessfulSyncAt: null,
    lastAttemptSummary: null,
  };
}

export class FileActualReadFreshnessStore implements ActualReadFreshnessStore {
  constructor(
    readonly path: string,
    readonly legacyPath?: string,
  ) {}

  async load(): Promise<PersistedActualReadFreshness> {
    const current = await this.#read(this.path);
    if (current !== undefined) {
      return persistedSchema.parse(JSON.parse(current) as unknown);
    }
    if (this.legacyPath === undefined) {
      return initialActualReadFreshness();
    }
    const legacyContent = await this.#read(this.legacyPath);
    if (legacyContent === undefined) {
      return initialActualReadFreshness();
    }
    const legacy = legacyPersistedSchema.parse(
      JSON.parse(legacyContent) as unknown,
    );
    return this.#upgrade(legacy);
  }

  async #read(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async save(untrustedState: PersistedActualReadFreshness): Promise<void> {
    const state = persistedSchema.parse(untrustedState);
    if (this.legacyPath !== undefined) {
      await this.#saveDocument(this.legacyPath, this.#downgrade(state));
    }
    await this.#saveDocument(this.path, state);
  }

  async #saveDocument(path: string, document: unknown): Promise<void> {
    const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
      const directory = await open(dirname(path), 'r');
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

  #upgrade(
    legacy: LegacyPersistedActualReadFreshness,
  ): PersistedActualReadFreshness {
    return {
      schemaVersion: 'actual-read-freshness.v2',
      generation: legacy.generation,
      state: legacy.state,
      lastAttemptAt: legacy.lastAttemptAt,
      lastSuccessfulSyncAt: legacy.lastSuccessfulSyncAt,
      lastAnySuccessfulSyncAt: legacy.lastSuccessfulSyncAt,
      lastAttemptSummary: null,
    };
  }

  #downgrade(
    state: PersistedActualReadFreshness,
  ): LegacyPersistedActualReadFreshness {
    return {
      schemaVersion: 'actual-read-freshness.v1',
      generation: state.generation,
      state: state.state === 'partial' ? 'failed' : state.state,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
    };
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
    ...(state.lastAttemptSummary === null
      ? {}
      : { lastAttemptSummary: state.lastAttemptSummary }),
  };
}
