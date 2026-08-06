import { describe, expect, it } from 'vitest';

import {
  ActualExistingTransactionWriter,
  ActualUpdateOutcomeUnknownError,
  ActualUpdateRefusedError,
  captureActualTransactionObservation,
  type ActualExistingTransactionUpdatePort,
  type ActualUpdateLedgerView,
  type ActualUpdateMutation,
  type ActualUpdatePayeeRecord,
  type ActualUpdateTransactionRecord,
  type UpdateExistingActualTransactionRequest,
} from '../../src/actual-update/index.js';

const timestamp = '2026-07-28T12:00:00.000Z';

function transaction(
  overrides: Partial<ActualUpdateTransactionRecord> = {},
): ActualUpdateTransactionRecord {
  return {
    id: 'transaction-1',
    is_parent: false,
    is_child: false,
    parent_id: null,
    account: 'account-1',
    category: 'category-old',
    amount: -1_000,
    payee: 'payee-old',
    notes: 'original note',
    date: '2026-07-28',
    imported_id: 'bank-import-1',
    imported_payee: 'Example Market',
    starting_balance_flag: false,
    transfer_id: null,
    sort_order: 42,
    cleared: true,
    reconciled: false,
    tombstone: false,
    schedule: null,
    raw_synced_data: '{"source":"synthetic"}',
    error: null,
    subtransactions: [],
    ...overrides,
  };
}

const safePayees: readonly ActualUpdatePayeeRecord[] = [
  { id: 'payee-old', transfer_acct: null },
  { id: 'payee-new', transfer_acct: null },
];

function cloneRecord(
  value: ActualUpdateTransactionRecord,
): ActualUpdateTransactionRecord {
  return structuredClone(value);
}

class FakeUpdatePort implements ActualExistingTransactionUpdatePort {
  readonly mutations: ActualUpdateMutation[] = [];
  readCount = 0;

  constructor(
    private current: ActualUpdateTransactionRecord,
    private readonly options: {
      readonly payees?: readonly ActualUpdatePayeeRecord[];
      readonly readViews?: readonly (
        ActualUpdateLedgerView | (() => ActualUpdateLedgerView)
      )[];
      readonly apply?: (
        mutation: ActualUpdateMutation,
        current: ActualUpdateTransactionRecord,
      ) =>
        ActualUpdateTransactionRecord | Promise<ActualUpdateTransactionRecord>;
    } = {},
  ) {}

  async readAccountDate(): Promise<ActualUpdateLedgerView> {
    const configured = this.options.readViews?.[this.readCount];
    this.readCount += 1;
    if (configured !== undefined) {
      return typeof configured === 'function'
        ? configured()
        : structuredClone(configured);
    }
    return {
      transactions: [cloneRecord(this.current)],
      payees: structuredClone(this.options.payees ?? safePayees),
    };
  }

  async applyMutation(mutation: ActualUpdateMutation): Promise<void> {
    this.mutations.push(structuredClone(mutation));
    if (this.options.apply !== undefined) {
      this.current = await this.options.apply(mutation, this.current);
      return;
    }
    this.current = {
      ...this.current,
      ...mutation.parentPatch,
      ...(mutation.addedChildren.length === 0
        ? mutation.deletedChildIds.length > 0
          ? { subtransactions: [] }
          : {}
        : {
            subtransactions: mutation.addedChildren.map((line) => ({
              ...line,
            })),
          }),
    };
  }
}

function request(
  original: ActualUpdateTransactionRecord,
  overrides: Partial<UpdateExistingActualTransactionRequest> = {},
): UpdateExistingActualTransactionRequest {
  return {
    idempotencyKey: 'approved-classification-1',
    observed: captureActualTransactionObservation(original),
    edit: {
      payee: { kind: 'preserve' },
      notes: { kind: 'preserve' },
      categorization: { kind: 'single', categoryId: 'category-new' },
    },
    ...overrides,
  };
}

function writer(port: ActualExistingTransactionUpdatePort) {
  return new ActualExistingTransactionWriter({
    port,
    allowedAccountIds: ['account-1'],
    allowedCategoryIds: ['category-old', 'category-new', 'category-second'],
    allowedPayeeIds: ['payee-new'],
    now: () => new Date(timestamp),
  });
}

describe('Actual existing-transaction writer', () => {
  it('updates only approved fields after a second exact read and verifies readback', async () => {
    const original = transaction();
    const port = new FakeUpdatePort(original);
    const input = request(original, {
      edit: {
        payee: { kind: 'set', value: 'payee-new' },
        notes: { kind: 'set', value: 'approved note' },
        categorization: { kind: 'single', categoryId: 'category-new' },
      },
    });

    const result = await writer(port).update(input);

    expect(result).toMatchObject({
      status: 'updated',
      applied: {
        transactionId: 'transaction-1',
        accountId: 'account-1',
        amountMinorUnits: -1_000,
        importedId: 'bank-import-1',
        cleared: true,
        editable: {
          payeeId: 'payee-new',
          notes: 'approved note',
          categorization: {
            kind: 'single',
            categoryId: 'category-new',
          },
        },
      },
      undoIntent: {
        schemaVersion: 'actual-update-undo.v1',
        restore: {
          payeeId: 'payee-old',
          notes: 'original note',
          categorization: {
            kind: 'single',
            categoryId: 'category-old',
          },
        },
        createdAt: timestamp,
      },
    });
    expect(port.readCount).toBe(3);
    expect(port.mutations).toEqual([
      {
        kind: 'apply-single',
        parentPatch: {
          id: 'transaction-1',
          category: 'category-new',
          payee: 'payee-new',
          notes: 'approved note',
        },
        addedChildren: [],
        deletedChildIds: [],
        expectedParentAmountMinorUnits: -1_000,
      },
    ]);
    expect(result.applied.preservedFingerprint).toBe(
      input.observed.preservedFingerprint,
    );
  });

  it('returns unchanged without writing when the observed state is already desired', async () => {
    const original = transaction({ category: 'category-new' });
    const port = new FakeUpdatePort(original);

    await expect(writer(port).update(request(original))).resolves.toMatchObject(
      {
        status: 'unchanged',
        undoIntent: null,
      },
    );
    expect(port.readCount).toBe(1);
    expect(port.mutations).toHaveLength(0);
  });

  it('reconciles an exact allowed post-state without a duplicate write', async () => {
    const original = transaction();
    const input = request(original, {
      edit: {
        payee: { kind: 'preserve' },
        notes: { kind: 'set', value: 'approved note' },
        categorization: { kind: 'single', categoryId: 'category-new' },
      },
    });
    const alreadyApplied = transaction({
      category: 'category-new',
      notes: 'approved note',
    });
    const port = new FakeUpdatePort(alreadyApplied);

    const result = await writer(port).update(input);

    expect(result.status).toBe('already-applied');
    expect(result.undoIntent?.restore.categorization).toEqual({
      kind: 'single',
      categoryId: 'category-old',
    });
    expect(port.readCount).toBe(1);
    expect(port.mutations).toHaveLength(0);
  });

  it('refuses a change that appears between the observation read and prewrite reread', async () => {
    const original = transaction();
    const firstView = { transactions: [original], payees: safePayees };
    const changed = transaction({ schedule: 'schedule-added-concurrently' });
    const secondView = { transactions: [changed], payees: safePayees };
    const port = new FakeUpdatePort(original, {
      readViews: [firstView, secondView],
    });

    await expect(writer(port).update(request(original))).rejects.toMatchObject({
      name: 'ActualUpdateRefusedError',
      code: 'target-changed',
    });
    expect(port.mutations).toHaveLength(0);
  });

  it.each([
    {
      name: 'missing target',
      view: { transactions: [], payees: safePayees },
      code: 'target-not-found',
    },
    {
      name: 'ambiguous target',
      view: {
        transactions: [transaction(), transaction()],
        payees: safePayees,
      },
      code: 'target-ambiguous',
    },
  ])('refuses a $name without mutation', async ({ view, code }) => {
    const original = transaction();
    const port = new FakeUpdatePort(original, { readViews: [view] });

    await expect(writer(port).update(request(original))).rejects.toMatchObject({
      name: 'ActualUpdateRefusedError',
      code,
    });
    expect(port.mutations).toHaveLength(0);
  });

  it('refuses non-imported, child, transfer, deleted, and unsafe-payee targets', async () => {
    const cases: readonly {
      readonly record: ActualUpdateTransactionRecord;
      readonly code: string;
      readonly payees?: readonly ActualUpdatePayeeRecord[];
    }[] = [
      {
        record: transaction({ imported_id: null }),
        code: 'target-non-imported',
      },
      {
        record: transaction({ is_child: true, parent_id: 'parent-1' }),
        code: 'target-child',
      },
      {
        record: transaction({ transfer_id: 'other-side' }),
        code: 'target-transfer',
      },
      { record: transaction({ tombstone: true }), code: 'target-deleted' },
      {
        record: transaction(),
        code: 'payee-not-safe',
        payees: [{ id: 'payee-old', transfer_acct: 'account-2' }],
      },
    ];

    for (const entry of cases) {
      const port = new FakeUpdatePort(
        entry.record,
        entry.payees === undefined ? {} : { payees: entry.payees },
      );
      await expect(
        writer(port).update(request(entry.record)),
      ).rejects.toMatchObject({
        name: 'ActualUpdateRefusedError',
        code: entry.code,
      });
      expect(port.mutations).toHaveLength(0);
    }
  });

  it('refuses update and undo targets outside the configured account allowlist', async () => {
    const original = transaction();
    const port = new FakeUpdatePort(original);
    const restricted = new ActualExistingTransactionWriter({
      port,
      allowedAccountIds: ['different-account'],
      allowedCategoryIds: ['category-old', 'category-new'],
      now: () => new Date(timestamp),
    });

    await expect(restricted.update(request(original))).rejects.toMatchObject({
      name: 'ActualUpdateRefusedError',
      code: 'target-account-not-safe',
    });
    expect(port.readCount).toBe(0);

    const applied = await writer(port).update(request(original));
    if (applied.undoIntent === null) {
      throw new Error('Synthetic update did not produce an undo intent');
    }
    await expect(restricted.undo(applied.undoIntent)).rejects.toMatchObject({
      name: 'ActualUpdateRefusedError',
      code: 'target-account-not-safe',
    });
    expect(port.mutations).toHaveLength(1);
  });

  it('creates a deterministic, balanced split and recognizes its retry', async () => {
    const original = transaction();
    const input = request(original, {
      edit: {
        payee: { kind: 'preserve' },
        notes: { kind: 'set', value: 'receipt allocation' },
        categorization: {
          kind: 'split',
          splits: [
            {
              categoryId: 'category-second',
              amountMinorUnits: -600,
              notes: 'second',
            },
            {
              categoryId: 'category-new',
              amountMinorUnits: -400,
              notes: 'first',
            },
          ],
        },
      },
    });
    const port = new FakeUpdatePort(original);

    const result = await writer(port).update(input);

    expect(result.status).toBe('updated');
    const mutation = port.mutations[0];
    expect(mutation).toBeDefined();
    expect(mutation?.kind).toBe('apply-split');
    expect(mutation?.deletedChildIds).toEqual([]);
    expect(mutation?.parentPatch).toEqual({
      id: 'transaction-1',
      is_parent: true,
      category: null,
      payee: null,
      notes: 'receipt allocation',
      error: null,
    });
    expect(
      mutation?.addedChildren.reduce((total, line) => total + line.amount, 0),
    ).toBe(-1_000);
    expect(mutation?.addedChildren).toMatchObject([
      {
        id: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
        category: 'category-new',
        amount: -400,
        payee: 'payee-old',
        is_child: true,
        parent_id: 'transaction-1',
      },
      {
        id: expect.any(String),
        category: 'category-second',
        amount: -600,
        payee: 'payee-old',
        is_child: true,
        parent_id: 'transaction-1',
      },
    ]);

    const current = {
      ...original,
      ...mutation?.parentPatch,
      subtransactions: mutation?.addedChildren,
    } as ActualUpdateTransactionRecord;
    const retryPort = new FakeUpdatePort(current);
    const retry = await writer(retryPort).update(input);
    expect(retry.status).toBe('already-applied');
    expect(retryPort.mutations).toHaveLength(0);
  });

  it('CAS-safely undoes a single-field update and recognizes its retry', async () => {
    const original = transaction();
    const port = new FakeUpdatePort(original);
    const input = request(original, {
      edit: {
        payee: { kind: 'set', value: 'payee-new' },
        notes: { kind: 'set', value: 'approved note' },
        categorization: { kind: 'single', categoryId: 'category-new' },
      },
    });
    const applied = await writer(port).update(input);
    if (applied.undoIntent === null) {
      throw new Error('Synthetic update did not produce an undo intent');
    }

    const undone = await writer(port).undo(applied.undoIntent);

    expect(undone).toMatchObject({
      status: 'undone',
      restored: {
        fullFingerprint: input.observed.fullFingerprint,
        editable: input.observed.editable,
      },
    });
    expect(port.mutations.at(-1)).toEqual({
      kind: 'undo',
      parentPatch: {
        id: 'transaction-1',
        category: 'category-old',
        payee: 'payee-old',
        notes: 'original note',
      },
      addedChildren: [],
      deletedChildIds: [],
      expectedParentAmountMinorUnits: -1_000,
    });
    await expect(writer(port).undo(applied.undoIntent)).resolves.toMatchObject({
      status: 'already-undone',
      restored: { fullFingerprint: input.observed.fullFingerprint },
    });
  });

  it('deletes only the exact applied split children during CAS-safe undo', async () => {
    const original = transaction();
    const port = new FakeUpdatePort(original);
    const input = request(original, {
      edit: {
        payee: { kind: 'preserve' },
        notes: { kind: 'set', value: 'split note' },
        categorization: {
          kind: 'split',
          splits: [
            { categoryId: 'category-new', amountMinorUnits: -400 },
            { categoryId: 'category-second', amountMinorUnits: -600 },
          ],
        },
      },
    });
    const applied = await writer(port).update(input);
    if (applied.undoIntent === null) {
      throw new Error('Synthetic split did not produce an undo intent');
    }
    const expectedIds =
      applied.applied.editable.categorization.kind === 'split'
        ? applied.applied.editable.categorization.splits.map(
            (line) => line.lineId,
          )
        : [];

    await expect(writer(port).undo(applied.undoIntent)).resolves.toMatchObject({
      status: 'undone',
      restored: {
        fullFingerprint: input.observed.fullFingerprint,
      },
    });
    expect(port.mutations.at(-1)).toEqual({
      kind: 'undo',
      parentPatch: {
        id: 'transaction-1',
        category: 'category-old',
        payee: 'payee-old',
        notes: 'original note',
        is_parent: false,
        error: null,
      },
      addedChildren: [],
      deletedChildIds: expectedIds,
      expectedParentAmountMinorUnits: -1_000,
    });
    expect(expectedIds).toHaveLength(2);
  });

  it('refuses undo after any concurrent drift without writing', async () => {
    const original = transaction();
    const updatePort = new FakeUpdatePort(original);
    const input = request(original);
    const applied = await writer(updatePort).update(input);
    if (applied.undoIntent === null) {
      throw new Error('Synthetic update did not produce an undo intent');
    }
    const concurrentlyChanged = transaction({
      category: 'category-new',
      schedule: 'new-schedule',
    });
    const undoPort = new FakeUpdatePort(concurrentlyChanged);

    await expect(
      writer(undoPort).undo(applied.undoIntent),
    ).rejects.toMatchObject({
      name: 'ActualUpdateRefusedError',
      code: 'target-changed',
    });
    expect(undoPort.mutations).toHaveLength(0);
  });

  it('rejects imbalanced, zero, wrong-sign, duplicate, and unallowed splits before reading', async () => {
    const original = transaction();
    const invalidSplits = [
      [
        { categoryId: 'category-new', amountMinorUnits: -400 },
        { categoryId: 'category-second', amountMinorUnits: -599 },
      ],
      [
        { categoryId: 'category-new', amountMinorUnits: 0 },
        { categoryId: 'category-second', amountMinorUnits: -1_000 },
      ],
      [
        { categoryId: 'category-new', amountMinorUnits: 400 },
        { categoryId: 'category-second', amountMinorUnits: -1_400 },
      ],
      [
        { categoryId: 'category-new', amountMinorUnits: -400 },
        { categoryId: 'category-new', amountMinorUnits: -600 },
      ],
      [
        { categoryId: 'category-new', amountMinorUnits: -400 },
        { categoryId: 'not-allowed', amountMinorUnits: -600 },
      ],
    ] as const;

    for (const splits of invalidSplits) {
      const port = new FakeUpdatePort(original);
      await expect(
        writer(port).update(
          request(original, {
            edit: {
              payee: { kind: 'preserve' },
              notes: { kind: 'preserve' },
              categorization: { kind: 'split', splits },
            },
          }),
        ),
      ).rejects.toMatchObject({
        name: 'ActualUpdateRefusedError',
        code: 'invalid-request',
      });
      expect(port.readCount).toBe(0);
      expect(port.mutations).toHaveLength(0);
    }
  });

  it('refuses to rewrite a pre-existing non-matching split', async () => {
    const split = transaction({
      is_parent: true,
      category: null,
      payee: null,
      subtransactions: [
        transaction({
          id: 'child-1',
          is_child: true,
          parent_id: 'transaction-1',
          amount: -500,
          category: 'category-old',
          imported_id: null,
          imported_payee: null,
        }),
        transaction({
          id: 'child-2',
          is_child: true,
          parent_id: 'transaction-1',
          amount: -500,
          category: 'category-second',
          imported_id: null,
          imported_payee: null,
        }),
      ],
    });
    const port = new FakeUpdatePort(split);

    await expect(writer(port).update(request(split))).rejects.toMatchObject({
      name: 'ActualUpdateRefusedError',
      code: 'unsupported-existing-split',
    });
    expect(port.mutations).toHaveLength(0);
  });

  it('marks a thrown mutation or mismatched readback as outcome-unknown', async () => {
    const original = transaction();
    const throwingPort = new FakeUpdatePort(original, {
      apply: async () => {
        throw new Error('synthetic transport loss');
      },
    });
    await expect(
      writer(throwingPort).update(request(original)),
    ).rejects.toBeInstanceOf(ActualUpdateOutcomeUnknownError);

    const staleReadbackPort = new FakeUpdatePort(original, {
      apply: async (_mutation, current) => current,
    });
    await expect(
      writer(staleReadbackPort).update(request(original)),
    ).rejects.toMatchObject({
      name: 'ActualUpdateOutcomeUnknownError',
      transactionId: 'transaction-1',
    });
  });

  it('exposes typed refusal errors for deterministic caller handling', () => {
    const error = new ActualUpdateRefusedError(
      'target-changed',
      'synthetic conflict',
    );
    expect(error).toMatchObject({
      name: 'ActualUpdateRefusedError',
      code: 'target-changed',
    });
  });
});
