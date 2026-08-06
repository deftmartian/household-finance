import { describe, expect, it, vi } from 'vitest';

import { BankSyncScheduler } from '../../src/actual-read/scheduler.js';
import type { ActualReadSyncResult } from '../../src/actual-read/port.js';

const succeeded: ActualReadSyncResult = {
  outcome: 'succeeded',
  freshness: {
    actualBudgetAsOf: '2026-07-28T12:00:01.000Z',
    bankFeedAsOf: '2026-07-28T12:00:01.000Z',
    lastAttemptAt: '2026-07-28T12:00:00.000Z',
    lastSuccessfulSyncAt: '2026-07-28T12:00:01.000Z',
    lastOutcome: 'succeeded',
    isFresh: true,
    expectedBankDelayHours: 24,
  },
};

describe('BankSyncScheduler', () => {
  it('serializes overlapping runs and wakes after a completed import attempt', async () => {
    let resolve!: (value: ActualReadSyncResult) => void;
    const syncNow = vi.fn(
      () =>
        new Promise<ActualReadSyncResult>((complete) => {
          resolve = complete;
        }),
    );
    const onCompletedImportAttempt = vi.fn();
    const scheduler = new BankSyncScheduler({
      reader: { syncNow },
      intervalMs: 4 * 60 * 60 * 1_000,
      onCompletedImportAttempt,
    });

    const first = scheduler.runNow();
    const second = scheduler.runNow();
    expect(syncNow).toHaveBeenCalledTimes(1);
    resolve(succeeded);
    await expect(first).resolves.toEqual(succeeded);
    await expect(second).resolves.toEqual(succeeded);
    expect(onCompletedImportAttempt).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it('does not wake downstream work for a rate-limited sync', async () => {
    const onCompletedImportAttempt = vi.fn();
    const skipped: ActualReadSyncResult = {
      outcome: 'skipped-recent',
      freshness: {
        ...succeeded.freshness,
        lastOutcome: 'skipped-recent',
      },
    };
    const scheduler = new BankSyncScheduler({
      reader: { syncNow: vi.fn().mockResolvedValue(skipped) },
      intervalMs: 4 * 60 * 60 * 1_000,
      onCompletedImportAttempt,
    });
    await expect(scheduler.runNow()).resolves.toEqual(skipped);
    expect(onCompletedImportAttempt).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('wakes after an aggregate failure because another account may still have imported', async () => {
    const onCompletedImportAttempt = vi.fn();
    const failed: ActualReadSyncResult = {
      outcome: 'failed',
      freshness: {
        ...succeeded.freshness,
        lastOutcome: 'failed',
        isFresh: false,
      },
    };
    const scheduler = new BankSyncScheduler({
      reader: { syncNow: vi.fn().mockResolvedValue(failed) },
      intervalMs: 4 * 60 * 60 * 1_000,
      onCompletedImportAttempt,
    });

    await expect(scheduler.runNow()).resolves.toEqual(failed);
    expect(onCompletedImportAttempt).toHaveBeenCalledExactlyOnceWith(failed);
    await scheduler.stop();
  });
});
