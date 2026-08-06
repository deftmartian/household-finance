import { describe, expect, it } from 'vitest';

import { projectImportedTransactionForCategorization } from '../../src/actual-read/categorization-projection.js';
import type { ActualImportedTransactionObservation } from '../../src/actual-read/port.js';

const observation: ActualImportedTransactionObservation = {
  schemaVersion: 'actual-imported-transaction-observation.v1',
  transactionId: 'actual-transaction-secret',
  importedId: 'bank-import-secret',
  accountAlias: 'card',
  accountRole: 'credit-card',
  accountOnBudget: true,
  accountLastFour: '4242',
  date: '2026-07-07',
  amountMinorUnits: 500,
  direction: 'refund',
  payeeName: 'Example Market',
  memo: 'returned item',
  currentCategoryAlias: 'groceries',
  currentCategoryName: 'Groceries',
  currentCategoryStatus: 'contract-bound',
  split: false,
  cleared: true,
  specialKind: 'refund',
  alreadyLinkedReceipts: [
    {
      receiptId: '8dfc1bd9-e07a-4c62-9d58-9529361536b9',
      sourceSha256: 'a'.repeat(64),
    },
  ],
  observationFingerprint: 'c'.repeat(64),
};

describe('Actual categorization projection', () => {
  it('drops every ledger identifier and preserves only defensible evidence', () => {
    const projected = projectImportedTransactionForCategorization(observation);

    expect(projected).toEqual({
      schemaVersion: 'transaction-categorization-observation.v1',
      date: '2026-07-07',
      accountAlias: 'card',
      amountMinorUnits: 500,
      direction: 'refund',
      payeeName: 'Example Market',
      memo: 'returned item',
      specialKind: 'ordinary',
      currentCategoryAlias: 'groceries',
      originalRefundCategoryAlias: null,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /actual-transaction-secret|bank-import-secret|4242|8dfc1bd9/u,
    );
  });
});
