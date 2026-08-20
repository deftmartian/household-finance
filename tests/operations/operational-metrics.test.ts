import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  OperationalMetrics,
  SqliteOperationalQueueHealthReader,
  type OperationalQueueHealthReader,
} from '../../src/operations/operational-metrics.js';

class FixedQueueReader implements OperationalQueueHealthReader {
  constructor(
    private readonly value: ReturnType<OperationalQueueHealthReader['read']>,
  ) {}

  read(): ReturnType<OperationalQueueHealthReader['read']> {
    return this.value;
  }

  close(): void {}
}

describe('operational metrics', () => {
  it('reads only aggregate due and processing state from SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'queue-health-'));
    const path = join(directory, 'queue.sqlite');
    const database = new Database(path);
    database.exec(`
      CREATE TABLE synthetic_outbox (
        state TEXT NOT NULL,
        available_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO synthetic_outbox VALUES
        ('pending', '2026-08-20T11:00:00.000Z'),
        ('pending', '2026-08-20T13:00:00.000Z'),
        ('processing', '2026-08-20T10:00:00.000Z'),
        ('completed', '2026-08-20T09:00:00.000Z');
    `);
    database.close();
    const reader = new SqliteOperationalQueueHealthReader([
      {
        queue: 'synthetic',
        databasePath: path,
        table: 'synthetic_outbox',
        stateColumn: 'state',
        dueStates: ['pending'],
        processingStates: ['processing'],
        dueColumn: 'available_at',
      },
    ]);
    try {
      expect(reader.read('2026-08-20T12:00:00.000Z')).toEqual([
        {
          queue: 'synthetic',
          due: 1,
          processing: 1,
          oldestDueAt: '2026-08-20T11:00:00.000Z',
        },
      ]);
    } finally {
      reader.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exports only fixed aggregate bank, queue, worker, and model state', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    const metrics = new OperationalMetrics({
      model: 'grok-4.6',
      reasoningEffort: 'high',
      sourceRevision: 'abc123',
      expectedBankSyncIntervalMs: 4 * 60 * 60 * 1_000,
      queueHealth: new FixedQueueReader([
        {
          queue: 'questions',
          due: 2,
          processing: 1,
          oldestDueAt: '2026-08-20T11:30:00.000Z',
        },
      ]),
      now: () => now,
    });
    metrics.recordBankSync({
      outcome: 'partial',
      freshness: {
        actualBudgetAsOf: now.toISOString(),
        bankFeedAsOf: now.toISOString(),
        lastAttemptAt: now.toISOString(),
        lastSuccessfulSyncAt: null,
        lastOutcome: 'partial',
        isFresh: true,
        expectedBankDelayHours: 4,
        lastAttemptSummary: {
          attemptedAccountCount: 3,
          succeededAccountCount: 2,
          failedAccountCount: 1,
          budgetRefreshSucceeded: true,
        },
      },
    });
    metrics.recordWorkerRun('primary', {
      attempted: 4,
      failures: ['questions'],
    });
    metrics.recordModelCompleted('structured', {
      provider: 'xai',
      requestedModel: 'grok-4.6',
      resolvedModel: 'grok-4.6',
      preflightAttempts: 1,
      requestAttempts: 1,
      durationMs: 1_500,
      zeroDataRetention: true,
      usage: { costInUsdTicks: 250 },
    });

    expect(metrics.status()).toMatchObject({
      status: 'degraded',
      build: {
        model: 'grok-4.6',
        reasoningEffort: 'high',
        sourceRevision: 'abc123',
      },
      bank: {
        state: 'partial',
        summary: { succeededAccountCount: 2, failedAccountCount: 1 },
      },
    });
    const output = metrics.prometheus();
    expect(output).toContain(
      'household_finance_bank_sync_outcome{outcome="partial"} 1',
    );
    expect(output).toContain(
      'household_finance_queue_due{queue="questions"} 2',
    );
    expect(output).toContain(
      'household_finance_model_cost_usd_ticks_total{client="structured"} 250',
    );
    expect(output).not.toContain('questions]');
  });

  it('counts fixed ZDR and model-mismatch failure classes', () => {
    const metrics = new OperationalMetrics({
      model: 'grok-4.6',
      reasoningEffort: 'medium',
      expectedBankSyncIntervalMs: 60_000,
      queueHealth: new FixedQueueReader([]),
    });
    metrics.recordModelFailure('receipt', { code: 'zdr-required' });
    metrics.recordModelFailure('receipt', {
      code: 'invalid-response',
      invalidResponseStage: 'model-mismatch',
    });
    expect(metrics.prometheus()).toContain(
      'household_finance_model_zdr_failures_total 1',
    );
    expect(metrics.prometheus()).toContain(
      'household_finance_model_mismatch_failures_total 1',
    );
  });
});
