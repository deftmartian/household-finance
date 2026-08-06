import { describe, expect, it, vi } from 'vitest';

import {
  ActualApiExistingTransactionUpdatePort,
  type ActualUpdateApiFacade,
  type ActualUpdateCoreClient,
  type ActualUpdateMutation,
} from '../../src/actual-update/index.js';

function splitMutation(): ActualUpdateMutation {
  return {
    kind: 'apply-split',
    parentPatch: {
      id: 'transaction-1',
      is_parent: true,
      category: null,
      payee: null,
      notes: 'split',
      error: null,
    },
    expectedParentAmountMinorUnits: -1_000,
    deletedChildIds: [],
    addedChildren: [
      {
        id: 'child-1',
        account: 'account-1',
        date: '2026-07-28',
        amount: -400,
        category: 'category-1',
        payee: 'payee-1',
        notes: null,
        imported_id: null,
        imported_payee: null,
        cleared: true,
        reconciled: false,
        transfer_id: null,
        starting_balance_flag: false,
        sort_order: -1,
        is_parent: false,
        is_child: true,
        parent_id: 'transaction-1',
        tombstone: false,
        error: null,
        schedule: null,
        raw_synced_data: null,
      },
      {
        id: 'child-2',
        account: 'account-1',
        date: '2026-07-28',
        amount: -600,
        category: 'category-2',
        payee: 'payee-1',
        notes: null,
        imported_id: null,
        imported_payee: null,
        cleared: true,
        reconciled: false,
        transfer_id: null,
        starting_balance_flag: false,
        sort_order: -2,
        is_parent: false,
        is_child: true,
        parent_id: 'transaction-1',
        tombstone: false,
        error: null,
        schedule: null,
        raw_synced_data: null,
      },
    ],
  };
}

function facade(events: string[]): ActualUpdateApiFacade {
  return {
    sync: vi.fn(async () => {
      events.push('sync');
    }),
    getTransactions: vi.fn(async () => {
      events.push('transactions');
      return [];
    }),
    getPayees: vi.fn(async () => {
      events.push('payees');
      return [];
    }),
  };
}

describe('Actual API existing-transaction update port', () => {
  it('syncs before a bounded account/date read', async () => {
    const events: string[] = [];
    const api = facade(events);
    const client: ActualUpdateCoreClient = {
      send: vi.fn(async () => undefined),
    };
    const port = new ActualApiExistingTransactionUpdatePort(api, client);

    await expect(
      port.readAccountDate('account-1', '2026-07-28'),
    ).resolves.toEqual({ transactions: [], payees: [] });
    expect(events[0]).toBe('sync');
    expect(api.getTransactions).toHaveBeenCalledWith(
      'account-1',
      '2026-07-28',
      '2026-07-28',
    );
  });

  it('allows an exact child-deleting undo batch and rejects widened deletes', async () => {
    const events: string[] = [];
    const api = facade(events);
    const client: ActualUpdateCoreClient = {
      send: vi.fn(async (_name, input) => {
        expect(input).toMatchObject({
          added: [],
          updated: [
            {
              id: 'transaction-1',
              is_parent: false,
              category: 'category-before',
              payee: 'payee-before',
              notes: 'before',
              error: null,
            },
          ],
          deleted: [{ id: 'child-1' }, { id: 'child-2' }],
          learnCategories: false,
          runTransfers: false,
        });
        return { added: [], updated: [], deleted: [], errors: [] };
      }),
    };
    const port = new ActualApiExistingTransactionUpdatePort(api, client);

    await port.applyMutation({
      kind: 'undo',
      parentPatch: {
        id: 'transaction-1',
        is_parent: false,
        category: 'category-before',
        payee: 'payee-before',
        notes: 'before',
        error: null,
      },
      addedChildren: [],
      deletedChildIds: ['child-1', 'child-2'],
      expectedParentAmountMinorUnits: -1_000,
    });

    expect(events).toEqual(['sync']);
    await expect(
      port.applyMutation({
        kind: 'undo',
        parentPatch: {
          id: 'transaction-1',
          is_parent: false,
          category: 'category-before',
          payee: 'payee-before',
          notes: 'before',
          error: null,
        },
        addedChildren: [],
        deletedChildIds: ['transaction-1'],
        expectedParentAmountMinorUnits: -1_000,
      }),
    ).rejects.toThrow('deleted child IDs');
  });

  it('awaits one whitelisted core batch mutation and then syncs', async () => {
    const events: string[] = [];
    const api = facade(events);
    const client: ActualUpdateCoreClient = {
      send: vi.fn(async (_name, input) => {
        events.push('batch');
        expect(input).toMatchObject({
          added: [
            { id: 'child-1', amount: -400 },
            { id: 'child-2', amount: -600 },
          ],
          updated: [
            {
              id: 'transaction-1',
              is_parent: true,
              category: null,
              payee: null,
            },
          ],
          deleted: [],
          learnCategories: false,
          runTransfers: false,
        });
        return { added: [], updated: [], deleted: [], errors: [] };
      }),
    };
    const port = new ActualApiExistingTransactionUpdatePort(api, client);

    await port.applyMutation(splitMutation());

    expect(client.send).toHaveBeenCalledWith(
      'transactions-batch-update',
      expect.any(Object),
    );
    expect(events).toEqual(['batch', 'sync']);
  });

  it('rejects an unbalanced or widened mutation before calling Actual', async () => {
    const events: string[] = [];
    const api = facade(events);
    const client: ActualUpdateCoreClient = {
      send: vi.fn(async () => undefined),
    };
    const port = new ActualApiExistingTransactionUpdatePort(api, client);
    const mutation = splitMutation();
    const firstChild = mutation.addedChildren[0];
    const secondChild = mutation.addedChildren[1];
    if (firstChild === undefined || secondChild === undefined) {
      throw new Error('Synthetic split fixture is incomplete');
    }

    await expect(
      port.applyMutation({
        ...mutation,
        addedChildren: [
          firstChild,
          {
            ...secondChild,
            amount: -599,
          },
        ],
      }),
    ).rejects.toThrow('unbalanced');
    await expect(
      port.applyMutation({
        ...mutation,
        parentPatch: {
          ...mutation.parentPatch,
          account: 'account-2',
        } as never,
      }),
    ).rejects.toThrow('unapproved field');
    expect(client.send).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('treats a core batch error result as a possibly-applied failure', async () => {
    const events: string[] = [];
    const api = facade(events);
    const client: ActualUpdateCoreClient = {
      send: vi.fn(async () => ({
        added: [],
        updated: [],
        deleted: [],
        errors: ['synthetic rule error'],
      })),
    };
    const port = new ActualApiExistingTransactionUpdatePort(api, client);

    await expect(port.applyMutation(splitMutation())).rejects.toThrow(
      'returned an error',
    );
    expect(events).toEqual([]);
  });
});
