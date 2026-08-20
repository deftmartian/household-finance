import { describe, expect, it, vi } from 'vitest';

import {
  ProductionWorkCoordinator,
  runWorkerKicksInOrder,
} from '../../src/workflow/worker-kicks.js';

describe('runWorkerKicksInOrder', () => {
  it('still wakes transaction categorization after earlier outbox work fails', async () => {
    const calls: string[] = [];
    const commonOutboxKick = vi.fn(async () => {
      calls.push('common-outbox');
      throw new Error('outbox unavailable');
    });
    const transactionCategorizationKick = vi.fn(async () => {
      calls.push('transaction-categorization');
    });

    await expect(
      runWorkerKicksInOrder([
        { name: 'common-outbox', kick: commonOutboxKick },
        {
          name: 'transaction-categorization',
          kick: transactionCategorizationKick,
        },
      ]),
    ).resolves.toEqual({
      attempted: 2,
      failures: ['common-outbox'],
    });
    expect(calls).toEqual(['common-outbox', 'transaction-categorization']);
    expect(transactionCategorizationKick).toHaveBeenCalledOnce();
  });
});

describe('ProductionWorkCoordinator', () => {
  it('coalesces overlapping signals and reruns a lane dirtied in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const kick = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
    });
    const coordinator = new ProductionWorkCoordinator({
      lanes: { primary: [{ name: 'worker', kick }] },
    });

    const first = coordinator.signal('primary');
    const second = coordinator.signal('primary');
    expect(kick).toHaveBeenCalledOnce();
    release();
    await Promise.all([first, second]);
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it('preserves worker order, reports bounded failures, and stops cleanly', async () => {
    const calls: string[] = [];
    const onRun = vi.fn();
    const coordinator = new ProductionWorkCoordinator({
      lanes: {
        primary: [
          {
            name: 'first',
            kick: () => {
              calls.push('first');
              throw new Error('synthetic');
            },
          },
          {
            name: 'second',
            kick: () => {
              calls.push('second');
            },
          },
        ],
      },
      onRun,
    });

    await coordinator.signal('primary');
    expect(calls).toEqual(['first', 'second']);
    expect(onRun).toHaveBeenCalledWith('primary', {
      attempted: 2,
      failures: ['first'],
    });
    coordinator.stop();
    await expect(coordinator.signal('primary')).resolves.toBeUndefined();
    await expect(coordinator.drain()).resolves.toBeUndefined();
    expect(calls).toEqual(['first', 'second']);
  });
});
