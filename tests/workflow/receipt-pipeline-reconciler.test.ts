import { describe, expect, it } from 'vitest';

import { ReceiptMatchStore } from '../../src/storage/index.js';
import { ReceiptPipelineReconciler } from '../../src/workflow/receipt-pipeline-reconciler.js';

const receivedAt = '2026-07-28T12:00:00.000Z';
const sourceSha256 = 'a'.repeat(64);

function recordReceipt(
  matches: ReceiptMatchStore,
  receiptId: string,
  idempotencyKey = `receipt-source-sha256:${sourceSha256}`,
): void {
  matches.recordReceipt({
    idempotencyKey,
    intent: {
      schemaVersion: 'receipt-match-intent.v1',
      receiptId,
      merchantName: 'Example Market',
      purchaseDate: '2026-07-28',
      currency: 'CAD',
      totalMinorUnits: 1_725,
      paymentEvidence: { kind: 'unknown' },
    },
    receivedAt,
  });
}

describe('ReceiptPipelineReconciler', () => {
  it('keeps canonical receipt intake waiting for a delayed transaction', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    try {
      const receiptId = '11111111-1111-4111-8111-111111111111';
      recordReceipt(matches, receiptId);
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: { candidatesForReceipt: async () => [] },
        now: () => new Date(receivedAt),
      });

      await reconciler.kick();

      expect(matches.getReceipt(receiptId)).toMatchObject({
        receiptId,
        status: 'awaiting-bank-transaction',
        matchAttemptCount: 1,
      });
      expect(matches.listAudit(receiptId).map((event) => event.action)).toEqual(
        expect.arrayContaining([
          'receipt-match.intake-recorded',
          'receipt-match.retry-scheduled',
        ]),
      );
    } finally {
      matches.close();
    }
  });

  it('retries a transient SimpleFIN candidate read and matches without a restart', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    try {
      const receiptId = '22222222-2222-4222-8222-222222222222';
      recordReceipt(matches, receiptId);
      let now = new Date(receivedAt);
      let calls = 0;
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error('temporary Actual read failure');
            }
            return [
              {
                transactionId: 'transaction-transient',
                importedId: 'import-transient',
                accountAlias: 'active-mastercard',
                accountLastFour: null,
                postingDate: '2026-07-28',
                payeeName: 'Example Market',
                currency: 'CAD',
                amountMinorUnits: -1_725,
                alreadyLinkedReceipts: [],
              },
            ];
          },
        },
        now: () => new Date(now),
      });

      await expect(reconciler.kick()).resolves.toBeGreaterThan(0);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'awaiting-bank-transaction',
      });
      expect(
        matches
          .listAudit(receiptId)
          .find(
            (event) =>
              event.action === 'receipt-match.retry-scheduled' &&
              (event.detail as { errorCode?: string }).errorCode ===
                'candidate-read-failed',
          ),
      ).toBeDefined();

      now = new Date(now.valueOf() + 5 * 60 * 1_000);
      await expect(reconciler.kick()).resolves.toBeGreaterThan(0);
      expect(calls).toBe(2);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'matched',
      });
      expect(matches.getImportedTransactionLinks(receiptId)).toEqual([
        expect.objectContaining({
          importedId: 'import-transient',
        }),
      ]);
    } finally {
      matches.close();
    }
  });

  it('rechecks canonical freshness after the candidate read before linking', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const receiptId = '55555555-5555-4555-8555-555555555555';
    let now = new Date(receivedAt);
    let current = true;
    let candidateReads = 0;
    try {
      matches.recordReceipt({
        idempotencyKey: `receipt-source-sha256:${sourceSha256}`,
        intent: {
          schemaVersion: 'receipt-match-intent.v1',
          receiptId,
          merchantName: 'Example Market',
          purchaseDate: '2026-07-28',
          currency: 'CAD',
          totalMinorUnits: 1_725,
          paymentEvidence: { kind: 'unknown' },
        },
        receivedAt,
      });
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => {
            candidateReads += 1;
            if (candidateReads === 1) {
              current = false;
            }
            return [
              {
                transactionId: 'transaction-freshness',
                importedId: 'import-freshness',
                accountAlias: 'active-mastercard',
                accountLastFour: null,
                postingDate: '2026-07-28',
                payeeName: 'Example Market',
                currency: 'CAD',
                amountMinorUnits: -1_725,
                alreadyLinkedReceipts: [],
              },
            ];
          },
        },
        freshness: {
          isCurrentReceiptSource: () => current,
        },
        now: () => new Date(now),
      });

      await reconciler.kick();

      expect(candidateReads).toBe(1);
      expect(matches.getImportedTransactionLinks(receiptId)).toEqual([]);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'awaiting-bank-transaction',
      });
      expect(
        matches
          .listAudit(receiptId)
          .find(
            (event) =>
              event.action === 'receipt-match.retry-scheduled' &&
              (event.detail as { errorCode?: string }).errorCode ===
                'canonical-receipt-not-ready',
          ),
      ).toBeDefined();

      current = true;
      now = new Date(now.valueOf() + 5 * 60 * 1_000);
      await reconciler.kick();
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'matched',
      });
    } finally {
      matches.close();
    }
  });

  it('defers Actual apply so a newer canonical revision can supersede the match', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const receiptId = '66666666-6666-4666-8666-666666666666';
    let freshnessChecks = 0;
    let applyCalls = 0;
    try {
      matches.recordReceipt({
        idempotencyKey: `receipt-source-sha256:${sourceSha256}`,
        intent: {
          schemaVersion: 'receipt-match-intent.v1',
          receiptId,
          merchantName: 'Example Market',
          purchaseDate: '2026-07-28',
          currency: 'CAD',
          totalMinorUnits: 1_725,
          paymentEvidence: { kind: 'unknown' },
        },
        receivedAt,
      });
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => [
            {
              transactionId: 'transaction-before-revision',
              importedId: 'import-before-revision',
              accountAlias: 'active-mastercard',
              accountLastFour: null,
              postingDate: '2026-07-28',
              payeeName: 'Example Market',
              currency: 'CAD',
              amountMinorUnits: -1_725,
              alreadyLinkedReceipts: [],
            },
          ],
        },
        freshness: {
          isCurrentReceiptSource: () => {
            freshnessChecks += 1;
            return freshnessChecks <= 2;
          },
        },
        applier: {
          applyReceiptMatch: async () => {
            applyCalls += 1;
          },
        },
        now: () => new Date(receivedAt),
      });

      await reconciler.kick();

      expect(matches.getImportedTransactionLinks(receiptId)).toHaveLength(1);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'matched',
      });
      expect(applyCalls).toBe(0);
      expect(
        matches.listAudit(receiptId).map((event) => event.action),
      ).toContain('receipt-match.apply-deferred');
    } finally {
      matches.close();
    }
  });

  it('defers a matched receipt without consuming retry budget until Actual is applied', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    try {
      const receiptId = '77777777-7777-4777-8777-777777777777';
      recordReceipt(matches, receiptId);
      let applyCalls = 0;
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => [
            {
              transactionId: 'transaction-1',
              importedId: 'import-1',
              accountAlias: 'active-mastercard',
              accountLastFour: null,
              postingDate: '2026-07-28',
              payeeName: 'Example Market',
              currency: 'CAD',
              amountMinorUnits: -1_725,
              alreadyLinkedReceipts: [],
            },
          ],
        },
        applier: {
          async applyReceiptMatch() {
            applyCalls += 1;
            return 'pending';
          },
        },
        now: () => new Date(receivedAt),
      });

      await reconciler.kick();

      expect(applyCalls).toBe(1);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'matched',
      });
      expect(matches.listAudit(receiptId).map((event) => event.action)).toEqual(
        expect.arrayContaining([
          'receipt-match.matched',
          'receipt-match.apply-deferred',
        ]),
      );

      await reconciler.kick();
      expect(applyCalls).toBe(1);
    } finally {
      matches.close();
    }
  });

  it('waits overnight for receipt clarification without exhausting apply retries', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    try {
      const receiptId = '88888888-8888-4888-8888-888888888888';
      recordReceipt(matches, receiptId);
      let now = new Date(receivedAt);
      let categorizationReady = false;
      let applyCalls = 0;
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => [
            {
              transactionId: 'transaction-delayed-category',
              importedId: 'import-delayed-category',
              accountAlias: 'active-mastercard',
              accountLastFour: null,
              postingDate: '2026-07-28',
              payeeName: 'Example Market',
              currency: 'CAD',
              amountMinorUnits: -1_725,
              alreadyLinkedReceipts: [],
            },
          ],
        },
        applier: {
          async applyReceiptMatch() {
            applyCalls += 1;
            return categorizationReady ? 'applied' : 'categorization-pending';
          },
        },
        now: () => new Date(now),
      });

      await reconciler.kick();
      for (let minute = 1; minute < 12 * 60; minute += 1) {
        now = new Date(now.valueOf() + 60_000);
        await reconciler.kick();
      }

      expect(applyCalls).toBe(12 * 60);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'matched',
      });
      expect(
        matches
          .listAudit(receiptId)
          .some(
            (event) =>
              event.action === 'receipt-match.attention-required' &&
              (event.detail as { reason?: string }).reason ===
                'apply-retry-exhausted',
          ),
      ).toBe(false);

      categorizationReady = true;
      now = new Date(now.valueOf() + 60_000);
      await reconciler.kick();

      expect(applyCalls).toBe(12 * 60 + 1);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'applied',
      });
    } finally {
      matches.close();
    }
  });

  it('persists and applies one unique exact multi-charge match set', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const receiptId = '33333333-3333-4333-8333-333333333333';
    const candidates = [
      {
        transactionId: 'transaction-part-one',
        importedId: 'import-part-one',
        accountAlias: 'active-mastercard',
        accountLastFour: null,
        postingDate: '2026-07-28',
        payeeName: 'Example Market',
        currency: 'CAD' as const,
        amountMinorUnits: -600,
        alreadyLinkedReceipts: [],
      },
      {
        transactionId: 'transaction-part-two',
        importedId: 'import-part-two',
        accountAlias: 'active-mastercard',
        accountLastFour: null,
        postingDate: '2026-07-28',
        payeeName: 'Example Market',
        currency: 'CAD' as const,
        amountMinorUnits: -1_125,
        alreadyLinkedReceipts: [],
      },
    ];
    let appliedLinks = 0;
    try {
      matches.recordReceipt({
        idempotencyKey: `receipt-match:${receiptId}`,
        intent: {
          schemaVersion: 'receipt-match-intent.v1',
          receiptId,
          merchantName: 'Example Market',
          purchaseDate: '2026-07-28',
          currency: 'CAD',
          totalMinorUnits: 1_725,
          paymentEvidence: { kind: 'unknown' },
        },
        receivedAt,
      });
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: { candidatesForReceipt: async () => candidates },
        applier: {
          async applyReceiptMatch(_receiptId, links) {
            appliedLinks = links.length;
            return 'pending';
          },
        },
        now: () => new Date(receivedAt),
      });

      await expect(reconciler.kick()).resolves.toBe(2);

      expect(matches.getImportedTransactionLinks(receiptId)).toHaveLength(2);
      expect(appliedLinks).toBe(2);
      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'matched',
      });
      expect(
        matches
          .listAudit(receiptId)
          .filter((event) => event.action === 'receipt-match.matched'),
      ).toHaveLength(1);
    } finally {
      matches.close();
    }
  });

  it('turns a plural categorization clarification into one calm review state', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const receiptId = '44444444-4444-4444-8444-444444444444';
    try {
      matches.recordReceipt({
        idempotencyKey: `receipt-match:${receiptId}`,
        intent: {
          schemaVersion: 'receipt-match-intent.v1',
          receiptId,
          merchantName: 'Example Market',
          purchaseDate: '2026-07-28',
          currency: 'CAD',
          totalMinorUnits: 1_725,
          paymentEvidence: { kind: 'unknown' },
        },
        receivedAt,
      });
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => [
            {
              transactionId: 'transaction-part-one',
              importedId: 'import-part-one',
              accountAlias: 'active-mastercard',
              accountLastFour: null,
              postingDate: '2026-07-28',
              payeeName: 'Example Market',
              currency: 'CAD',
              amountMinorUnits: -600,
              alreadyLinkedReceipts: [],
            },
            {
              transactionId: 'transaction-part-two',
              importedId: 'import-part-two',
              accountAlias: 'active-mastercard',
              accountLastFour: null,
              postingDate: '2026-07-28',
              payeeName: 'Example Market',
              currency: 'CAD',
              amountMinorUnits: -1_125,
              alreadyLinkedReceipts: [],
            },
          ],
        },
        applier: {
          async applyReceiptMatch() {
            return 'needs-clarification';
          },
        },
        now: () => new Date(receivedAt),
      });

      await reconciler.kick();

      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'attention',
        attentionReason: 'operator-review',
      });
      expect(
        matches
          .listAudit(receiptId)
          .filter(
            (event) => event.action === 'receipt-match.attention-required',
          ),
      ).toHaveLength(1);
    } finally {
      matches.close();
    }
  });

  it('turns competing exact charge sets into one review without linking either', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const receiptId = '55555555-5555-4555-8555-555555555555';
    const amounts = [600, 1_125, 700, 1_025];
    try {
      matches.recordReceipt({
        idempotencyKey: `receipt-match:${receiptId}`,
        intent: {
          schemaVersion: 'receipt-match-intent.v1',
          receiptId,
          merchantName: 'Example Market',
          purchaseDate: '2026-07-28',
          currency: 'CAD',
          totalMinorUnits: 1_725,
          paymentEvidence: { kind: 'unknown' },
        },
        receivedAt,
      });
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () =>
            amounts.map((amount, index) => ({
              transactionId: `transaction-choice-${String(index)}`,
              importedId: `import-choice-${String(index)}`,
              accountAlias: 'active-mastercard',
              accountLastFour: null,
              postingDate: '2026-07-28',
              payeeName: 'Example Market',
              currency: 'CAD',
              amountMinorUnits: -amount,
              alreadyLinkedReceipts: [],
            })),
        },
        now: () => new Date(receivedAt),
      });

      await reconciler.kick();

      expect(matches.getReceipt(receiptId)).toMatchObject({
        status: 'attention',
        attentionReason: 'operator-review',
      });
      expect(matches.getImportedTransactionLinks(receiptId)).toEqual([]);
      expect(
        matches
          .listAudit(receiptId)
          .filter(
            (event) => event.action === 'receipt-match.attention-required',
          ),
      ).toHaveLength(1);
    } finally {
      matches.close();
    }
  });

  it('retains the first immutable transaction owner and sends a conflicting second receipt to attention', async () => {
    const matches = new ReceiptMatchStore(':memory:');
    const firstReceiptId = '11111111-1111-4111-8111-111111111111';
    const secondReceiptId = '22222222-2222-4222-8222-222222222222';
    const candidate = {
      transactionId: 'transaction-shared',
      importedId: 'import-shared',
      accountAlias: 'active-mastercard',
      accountLastFour: null,
      postingDate: '2026-07-28',
      payeeName: 'Example Market',
      currency: 'CAD' as const,
      amountMinorUnits: -1_725,
      alreadyLinkedReceipts: [],
    };
    try {
      for (const receiptId of [firstReceiptId, secondReceiptId]) {
        matches.recordReceipt({
          idempotencyKey: `receipt-match:${receiptId}`,
          intent: {
            schemaVersion: 'receipt-match-intent.v1',
            receiptId,
            merchantName: 'Example Market',
            purchaseDate: '2026-07-28',
            currency: 'CAD',
            totalMinorUnits: 1_725,
            paymentEvidence: { kind: 'unknown' },
          },
          receivedAt,
        });
      }
      const reconciler = new ReceiptPipelineReconciler({
        matches,
        candidates: {
          candidatesForReceipt: async () => [candidate],
        },
        now: () => new Date(receivedAt),
      });

      await expect(reconciler.kick()).resolves.toBe(2);

      expect(matches.getReceipt(firstReceiptId)).toMatchObject({
        status: 'matched',
      });
      expect(matches.getImportedTransactionLinks(firstReceiptId)).toEqual([
        expect.objectContaining({
          receiptId: firstReceiptId,
          transactionId: candidate.transactionId,
          importedId: candidate.importedId,
        }),
      ]);
      expect(matches.getReceipt(secondReceiptId)).toMatchObject({
        status: 'attention',
        attentionReason: 'match-conflict',
      });
      expect(matches.getImportedTransactionLinks(secondReceiptId)).toEqual([]);
      expect(
        matches.listAudit(secondReceiptId).map((event) => event.action),
      ).toContain('receipt-match.attention-required');
    } finally {
      matches.close();
    }
  });
});
