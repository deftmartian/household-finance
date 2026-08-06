import { describe, expect, it } from 'vitest';

import {
  actualTransactionPreservedFingerprint,
  actualTransactionRecordFingerprint,
  assertActualTransactionObservation,
  assertActualUpdateUndoIntent,
  captureActualTransactionObservation,
  createActualUpdateUndoIntent,
  deterministicActualSplitChildId,
  type ActualUpdateTransactionRecord,
} from '../../src/actual-update/index.js';

function record(
  overrides: Partial<ActualUpdateTransactionRecord> = {},
): ActualUpdateTransactionRecord {
  return {
    id: 'transaction-1',
    account: 'account-1',
    date: '2026-07-28',
    amount: -500,
    category: 'category-1',
    payee: 'payee-1',
    notes: null,
    imported_id: 'import-1',
    imported_payee: 'Synthetic Store',
    cleared: false,
    reconciled: false,
    transfer_id: null,
    is_parent: false,
    is_child: false,
    parent_id: null,
    tombstone: false,
    error: null,
    subtransactions: [],
    unrelated: { beta: 2, alpha: 1 },
    ...overrides,
  };
}

describe('Actual update domain guards', () => {
  it('uses canonical full and preserved fingerprints', () => {
    const first = record();
    const reordered = record({ unrelated: { alpha: 1, beta: 2 } });
    expect(actualTransactionRecordFingerprint(first)).toBe(
      actualTransactionRecordFingerprint(reordered),
    );
    expect(
      actualTransactionRecordFingerprint(
        record({ unrelated: { alpha: 1, beta: 3 } }),
      ),
    ).not.toBe(actualTransactionRecordFingerprint(first));
    expect(
      actualTransactionPreservedFingerprint(
        record({ category: 'category-2', payee: null, notes: 'changed' }),
      ),
    ).toBe(actualTransactionPreservedFingerprint(first));
  });

  it('captures a durable observation and binds undo to the exact applied state', () => {
    const before = captureActualTransactionObservation(record());
    const after = captureActualTransactionObservation(
      record({ category: 'category-2', notes: 'approved' }),
    );
    const intent = createActualUpdateUndoIntent({
      idempotencyKey: 'approval-1',
      original: before,
      expectedApplied: after,
      createdAt: '2026-07-28T12:00:00.000Z',
    });

    expect(intent).toMatchObject({
      schemaVersion: 'actual-update-undo.v1',
      transactionId: 'transaction-1',
      importedId: 'import-1',
      expectedApplied: {
        fullFingerprint: after.fullFingerprint,
      },
      original: {
        fullFingerprint: before.fullFingerprint,
      },
      restore: {
        payeeId: 'payee-1',
        notes: null,
        categorization: { kind: 'single', categoryId: 'category-1' },
      },
      idempotencyKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects a snapshot whose editable state was changed after capture', () => {
    const observed = captureActualTransactionObservation(record());
    expect(() =>
      assertActualTransactionObservation({
        ...observed,
        editable: {
          ...observed.editable,
          notes: 'tampered',
        },
      }),
    ).toThrow('fingerprint does not match');
  });

  it('rejects a durable undo intent whose exact restore guard was changed', () => {
    const before = captureActualTransactionObservation(record());
    const after = captureActualTransactionObservation(
      record({ category: 'category-2' }),
    );
    const intent = createActualUpdateUndoIntent({
      idempotencyKey: 'approval-1',
      original: before,
      expectedApplied: after,
      createdAt: '2026-07-28T12:00:00.000Z',
    });

    expect(() =>
      assertActualUpdateUndoIntent({
        ...intent,
        restore: {
          ...intent.restore,
          notes: 'tampered',
        },
      }),
    ).toThrow('exact original');
  });

  it('derives stable distinct UUID-shaped split child IDs', () => {
    const base = {
      idempotencyKey: 'approval-1',
      transactionId: 'transaction-1',
      categoryId: 'category-1',
      amountMinorUnits: -250,
      index: 0,
    };
    const first = deterministicActualSplitChildId(base);
    expect(deterministicActualSplitChildId(base)).toBe(first);
    expect(deterministicActualSplitChildId({ ...base, index: 1 })).not.toBe(
      first,
    );
    expect(first).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
    );
  });
});
