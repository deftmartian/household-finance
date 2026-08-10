import { describe, expect, it, vi } from 'vitest';

import {
  ReceiptRecordPublicationWorker,
  type ReceiptRecordPublicationRunResult,
} from '../../src/receipts/record-projection.js';

const result = (
  nextSettlementAt: string | null,
): ReceiptRecordPublicationRunResult => ({
  scanned: 0,
  candidates: 0,
  bundles: 0,
  invalid: 0,
  unsettled: nextSettlementAt === null ? 0 : 1,
  nextSettlementAt,
  published: 0,
  waitingForActual: 0,
  visible: 0,
});

describe('ReceiptRecordPublicationWorker', () => {
  it('runs initially, on durable input changes, and at the settlement deadline', () => {
    let now = new Date('2026-07-29T12:00:00.000Z');
    let changeToken = 'input:0';
    const runOnce = vi.fn().mockReturnValue(result('2026-07-29T12:15:00.000Z'));
    const worker = new ReceiptRecordPublicationWorker({
      workflow: { runOnce },
      changeToken: () => changeToken,
      now: () => now,
    });

    expect(worker.kick()).toMatchObject({ unsettled: 1 });
    expect(worker.kick()).toMatchObject({ unsettled: 1 });
    expect(runOnce).toHaveBeenCalledOnce();

    changeToken = 'input:1';
    now = new Date('2026-07-29T12:00:01.000Z');
    worker.kick();
    expect(runOnce).toHaveBeenCalledTimes(2);

    now = new Date('2026-07-29T12:14:59.999Z');
    worker.kick();
    expect(runOnce).toHaveBeenCalledTimes(2);

    now = new Date('2026-07-29T12:15:00.000Z');
    worker.kick();
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed pass or trust a clock that moved backwards', () => {
    let now = new Date('2026-07-29T12:00:00.000Z');
    const runOnce = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('synthetic publication failure');
      })
      .mockReturnValue(result(null));
    const worker = new ReceiptRecordPublicationWorker({
      workflow: { runOnce },
      changeToken: () => 'input:0',
      now: () => now,
    });

    expect(() => worker.kick()).toThrow('synthetic publication failure');
    expect(worker.kick()).toMatchObject({ nextSettlementAt: null });
    expect(runOnce).toHaveBeenCalledTimes(2);

    now = new Date('2026-07-29T11:59:59.999Z');
    worker.kick();
    expect(runOnce).toHaveBeenCalledTimes(3);
  });
});
