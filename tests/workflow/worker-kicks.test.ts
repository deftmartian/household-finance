import { describe, expect, it, vi } from 'vitest';

import { runWorkerKicksInOrder } from '../../src/workflow/worker-kicks.js';

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
