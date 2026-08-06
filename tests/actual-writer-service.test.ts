import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ActualWriterServiceLoop,
  assertActualUpdateCoreClient,
  createActualWriterServiceLoop,
} from '../src/actual-writer-service.js';
import type { ActualWriterConfig } from '../src/actual-writer-config.js';
import {
  ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
  ACTUAL_PRODUCTION_SCOPE,
  actualProductionContractFingerprint,
  actualProductionSentinelPayeeName,
} from '../src/integrations/actual/index.js';

function noWatchdog(): () => void {
  return () => undefined;
}

describe('scoped Actual writer service runtime', () => {
  it('runtime-checks the awaited core client', () => {
    expect(() => assertActualUpdateCoreClient({})).toThrow(
      /awaited core update client/,
    );
    const coreClient = {
      send: vi.fn(async () => ({ errors: [] })),
    };
    expect(() => assertActualUpdateCoreClient(coreClient)).not.toThrow();
  });

  it('processes one intent per watchdog window and closes every resource', async () => {
    const events: string[] = [];
    const loop = new ActualWriterServiceLoop({
      queues: [
        {
          runOne: vi.fn(async () => {
            events.push('run:1');
            return false;
          }),
        },
      ],
      boundary: {
        shutdown: vi.fn(async () => {
          events.push('actual:closed');
        }),
      },
      stores: [
        {
          close: vi.fn(() => {
            events.push('store:closed');
          }),
        },
      ],
      authenticators: [
        {
          destroy: vi.fn(() => {
            events.push('key:destroyed');
          }),
        },
      ],
      pollIntervalMs: 60_000,
      operationTimeoutMs: 10_000,
      startWatchdog: noWatchdog,
    });

    await loop.start();
    await loop.shutdown();
    await loop.shutdown();

    expect(events).toEqual([
      'run:1',
      'actual:closed',
      'store:closed',
      'key:destroyed',
    ]);
  });

  it('round-robins writer queues and falls through an idle queue', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const loop = new ActualWriterServiceLoop({
      queues: [
        {
          runOne: vi.fn(async () => {
            events.push('transaction');
            return true;
          }),
        },
        {
          runOne: vi.fn(async () => {
            events.push('receipt');
            return false;
          }),
        },
      ],
      boundary: {
        shutdown: vi.fn(async () => undefined),
      },
      stores: [],
      authenticators: [],
      pollIntervalMs: 250,
      operationTimeoutMs: 10_000,
      startWatchdog: noWatchdog,
    });

    try {
      await loop.start();
      await vi.advanceTimersByTimeAsync(250);
      await loop.shutdown();

      expect(events).toEqual(['transaction', 'receipt', 'transaction']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still closes state and destroys the key when a cycle and Actual shutdown fail', async () => {
    const storeClose = vi.fn();
    const keyDestroy = vi.fn();
    const loop = new ActualWriterServiceLoop({
      queues: [
        {
          runOne: vi.fn(async () => {
            throw new Error('synthetic cycle failure');
          }),
        },
      ],
      boundary: {
        shutdown: vi.fn(async () => {
          throw new Error('synthetic Actual shutdown failure');
        }),
      },
      stores: [{ close: storeClose }],
      authenticators: [{ destroy: keyDestroy }],
      pollIntervalMs: 60_000,
      operationTimeoutMs: 10_000,
      startWatchdog: noWatchdog,
    });

    await expect(loop.start()).rejects.toBeInstanceOf(AggregateError);
    expect(storeClose).toHaveBeenCalledOnce();
    expect(keyDestroy).toHaveBeenCalledOnce();
  });

  it('waits for an active cycle on shutdown and cleans up after its rejection', async () => {
    let rejectCycle: ((error: Error) => void) | undefined;
    const activeCycle = new Promise<never>((_resolve, reject) => {
      rejectCycle = reject;
    });
    const storeClose = vi.fn();
    const keyDestroy = vi.fn();
    const boundaryShutdown = vi.fn(async () => undefined);
    const loop = new ActualWriterServiceLoop({
      queues: [{ runOne: vi.fn(() => activeCycle) }],
      boundary: { shutdown: boundaryShutdown },
      stores: [{ close: storeClose }],
      authenticators: [{ destroy: keyDestroy }],
      pollIntervalMs: 60_000,
      operationTimeoutMs: 10_000,
      startWatchdog: noWatchdog,
    });
    const starting = loop.start();
    await Promise.resolve();
    const shuttingDown = loop.shutdown();
    rejectCycle?.(new Error('synthetic in-flight failure'));

    await expect(starting).rejects.toBeInstanceOf(AggregateError);
    await expect(shuttingDown).rejects.toBeInstanceOf(AggregateError);
    expect(boundaryShutdown).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce();
    expect(keyDestroy).toHaveBeenCalledOnce();
  });

  it('constructs a testable update-only service through the live contract boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'actual-writer-service-'));
    const identity = {
      schemaVersion: ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
      scope: ACTUAL_PRODUCTION_SCOPE,
      nonce: 'a'.repeat(64),
      budget: {
        syncId: 'production-sync-id',
        name: 'Synthetic Household Budget',
      },
      accounts: {
        card: { id: 'actual-card-id', name: 'Synthetic Household Card' },
      },
      categories: {
        groceries: {
          id: 'actual-groceries-id',
          name: 'Synthetic Groceries',
          kind: 'expense' as const,
        },
      },
      expectedCurrency: 'CAD' as const,
      maximumReceiptAmountMinorUnits: 100_000,
      receiptDateWindow: { pastDays: 90, futureDays: 1 },
    };
    const fingerprint = actualProductionContractFingerprint(identity);
    const productionContract = {
      ...identity,
      fingerprint,
      sentinelPayee: {
        id: 'actual-sentinel-id',
        name: actualProductionSentinelPayeeName(fingerprint),
      },
    };
    const coreClient = {
      send: vi.fn(async () => ({ errors: [] })),
    };
    const shutdown = vi.fn(async () => undefined);
    const sync = vi.fn(async () => undefined);
    const actualModule = {
      init: vi.fn(async () => coreClient),
      shutdown,
      downloadBudget: vi.fn(async () => undefined),
      getBudgets: vi.fn(async () => [
        {
          id: 'local-budget-id',
          cloudFileId: 'cloud-budget-id',
          groupId: identity.budget.syncId,
          name: identity.budget.name,
        },
        {
          cloudFileId: 'cloud-budget-id',
          groupId: identity.budget.syncId,
          name: identity.budget.name,
          state: 'remote' as const,
        },
      ]),
      getAccounts: vi.fn(async () => [
        {
          id: identity.accounts.card.id,
          name: identity.accounts.card.name,
          offbudget: false,
          closed: false,
        },
      ]),
      getCategories: vi.fn(async () => [
        {
          id: identity.categories.groceries.id,
          name: identity.categories.groceries.name,
          group_id: 'expense-group-id',
          is_income: false,
          hidden: false,
        },
      ]),
      getPayees: vi.fn(async () => [productionContract.sentinelPayee]),
      getTransactions: vi.fn(async () => []),
      getNote: vi.fn(async () => null),
      updateNote: vi.fn(async () => undefined),
      sync,
    };
    const config: ActualWriterConfig = {
      databasePath: join(directory, 'writer.sqlite'),
      actualApiDataDirectory: join(directory, 'actual-api'),
      serverUrl: 'http://actual-server:5006',
      serverPassword: 'synthetic-password',
      productionContract,
      updateSigningKeys: {
        'production-v1': 's'.repeat(48),
      },
      updateTargetReferenceKey: 't'.repeat(48),
      updateSigningKeyId: 'production-v1',
      pollIntervalMs: 60_000,
      operationTimeoutMs: 10_000,
    };

    try {
      const loop = await createActualWriterServiceLoop(
        config,
        actualModule as never,
      );
      await loop.start();
      await loop.shutdown();

      expect(actualModule.init).toHaveBeenCalledOnce();
      expect(actualModule.downloadBudget).toHaveBeenCalledWith(
        identity.budget.syncId,
      );
      expect(sync).toHaveBeenCalled();
      expect(shutdown).toHaveBeenCalledOnce();
      expect(coreClient.send).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
