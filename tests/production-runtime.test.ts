import { describe, expect, it } from 'vitest';

import { createProductionWorkerKickPlan } from '../src/production-runtime.js';
import {
  type NamedWorkerKick,
  runWorkerKicksInOrder,
} from '../src/workflow/index.js';

describe('production worker kick plan', () => {
  it('wakes receipt matching on startup and bank sync, but not on the categorization poll', async () => {
    const calls: string[] = [];
    const worker = (name: string): NamedWorkerKick => ({
      name,
      kick: () => {
        calls.push(name);
      },
    });
    const receiptMatchWakeup = worker('receipt-match-wakeup');
    const questions = worker('questions');
    const plan = createProductionWorkerKickPlan({
      receiptMatchWakeup,
      primaryWorkers: [worker('attachments'), questions],
      receiptLedgerWorkers: [
        worker('receipt-record-hydration'),
        worker('receipt-matching'),
      ],
      transactionCategorization: worker('transaction-categorization'),
      questions,
    });

    await runWorkerKicksInOrder(plan.initial);
    expect(calls).toEqual([
      'receipt-match-wakeup',
      'attachments',
      'questions',
      'transaction-categorization',
    ]);

    calls.length = 0;
    await runWorkerKicksInOrder(plan.transactionCategorizationPoll);
    expect(calls).toEqual([
      'receipt-record-hydration',
      'receipt-matching',
      'transaction-categorization',
    ]);

    calls.length = 0;
    await runWorkerKicksInOrder(plan.postBankSync);
    expect(calls).toEqual([
      'receipt-match-wakeup',
      'questions',
      'receipt-record-hydration',
      'receipt-matching',
      'transaction-categorization',
    ]);
  });
});
