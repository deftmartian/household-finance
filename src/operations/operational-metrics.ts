import Database from 'better-sqlite3';

import type { ActualReadSyncResult } from '../actual-read/index.js';
import type {
  XaiAgentRunMetadata,
  XaiStructuredRunMetadata,
} from '../model/xai-structured-client.js';
import type { ReceiptModelRunMetadata } from '../model/adapter.js';
import type { WorkerKickRunSummary } from '../workflow/worker-kicks.js';

export type ModelClientName = 'receipt' | 'structured';

export interface OperationalQueueHealth {
  readonly queue: string;
  readonly due: number;
  readonly processing: number;
  readonly oldestDueAt: string | null;
}

export interface OperationalQueueHealthReader {
  read(now: string): readonly OperationalQueueHealth[];
  close(): void;
}

interface QueueDefinition {
  readonly queue: string;
  readonly databasePath: string;
  readonly table: string;
  readonly stateColumn: string;
  readonly dueStates: readonly string[];
  readonly processingStates: readonly string[];
  readonly dueColumn: string;
}

interface QueueRow {
  due: number;
  processing: number;
  oldest_due_at: string | null;
}

function sqlIdentifiersAreFixed(definition: QueueDefinition): boolean {
  return [definition.table, definition.stateColumn, definition.dueColumn].every(
    (value) => /^[a-z][a-z0-9_]*$/.test(value),
  );
}

function stateList(states: readonly string[]): string {
  if (
    states.length === 0 ||
    states.some((state) => !/^[a-z][a-z0-9-]*$/.test(state))
  ) {
    throw new TypeError('Queue health state list is invalid');
  }
  return states.map((state) => `'${state}'`).join(', ');
}

/**
 * Opens separate read-only SQLite handles and exposes only aggregate queue
 * state. The definitions are fixed in source; no table, state, or path is
 * accepted from an HTTP request.
 */
export class SqliteOperationalQueueHealthReader implements OperationalQueueHealthReader {
  readonly #databases = new Map<string, Database.Database>();
  readonly #queries: ReadonlyArray<{
    readonly queue: string;
    readonly statement: Database.Statement<[string, string], QueueRow>;
  }>;

  constructor(definitions: readonly QueueDefinition[]) {
    if (
      definitions.length === 0 ||
      new Set(definitions.map((definition) => definition.queue)).size !==
        definitions.length
    ) {
      throw new TypeError('Queue health definitions are invalid');
    }
    try {
      this.#queries = definitions.map((definition) => {
        if (
          !/^[a-z][a-z0-9-]{0,63}$/.test(definition.queue) ||
          !sqlIdentifiersAreFixed(definition)
        ) {
          throw new TypeError('Queue health definition is invalid');
        }
        let database = this.#databases.get(definition.databasePath);
        if (database === undefined) {
          database = new Database(definition.databasePath, {
            readonly: true,
            fileMustExist: true,
          });
          database.pragma('query_only = ON');
          database.pragma('busy_timeout = 1000');
          this.#databases.set(definition.databasePath, database);
        }
        const dueStates = stateList(definition.dueStates);
        const processingStates = stateList(definition.processingStates);
        return {
          queue: definition.queue,
          statement: database.prepare<[string, string], QueueRow>(
            `SELECT
               COUNT(*) FILTER (
                 WHERE ${definition.stateColumn} IN (${dueStates})
                   AND ${definition.dueColumn} <= ?
               ) AS due,
               COUNT(*) FILTER (
                 WHERE ${definition.stateColumn} IN (${processingStates})
               ) AS processing,
               MIN(
                 CASE
                   WHEN ${definition.stateColumn} IN (${dueStates})
                     AND ${definition.dueColumn} <= ?
                   THEN ${definition.dueColumn}
                 END
               ) AS oldest_due_at
             FROM ${definition.table}`,
          ),
        };
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  read(now: string): readonly OperationalQueueHealth[] {
    return this.#queries.map(({ queue, statement }) => {
      const row = statement.get(now, now);
      return {
        queue,
        due: row?.due ?? 0,
        processing: row?.processing ?? 0,
        oldestDueAt: row?.oldest_due_at ?? null,
      };
    });
  }

  close(): void {
    for (const database of this.#databases.values()) {
      database.close();
    }
    this.#databases.clear();
  }
}

export interface ProductionQueueHealthPaths {
  readonly attachment: string;
  readonly questions: string;
  readonly context: string;
  readonly receiptCategorization: string;
  readonly receiptMatching: string;
  readonly transactionCategorization: string;
}

export function createProductionQueueHealthReader(
  paths: ProductionQueueHealthPaths,
): SqliteOperationalQueueHealthReader {
  const outbox = (
    queue: string,
    databasePath: string,
    table: string,
  ): QueueDefinition => ({
    queue,
    databasePath,
    table,
    stateColumn: 'state',
    dueStates: ['pending'],
    processingStates: ['processing'],
    dueColumn: 'available_at',
  });
  return new SqliteOperationalQueueHealthReader([
    outbox('attachments', paths.attachment, 'attachment_outbox'),
    outbox('questions', paths.questions, 'question_outbox'),
    outbox('voice-questions', paths.questions, 'question_voice_outbox'),
    outbox('household-context', paths.context, 'household_context_outbox'),
    outbox(
      'receipt-categorization',
      paths.receiptCategorization,
      'receipt_categorization_outbox',
    ),
    outbox('receipt-matching', paths.receiptMatching, 'receipt_match_outbox'),
    outbox(
      'transaction-categorization',
      paths.transactionCategorization,
      'transaction_categorization_outbox',
    ),
    {
      queue: 'actual-updates',
      databasePath: paths.attachment,
      table: 'actual_update_state',
      stateColumn: 'status',
      dueStates: ['queued', 'undo-queued'],
      processingStates: [
        'claimed',
        'applying',
        'undo-claimed',
        'undo-applying',
      ],
      dueColumn: 'available_at',
    },
    {
      queue: 'receipt-notes',
      databasePath: paths.attachment,
      table: 'actual_receipt_note_state',
      stateColumn: 'status',
      dueStates: ['queued', 'reconcile'],
      processingStates: ['claimed', 'applying'],
      dueColumn: 'available_at',
    },
  ]);
}

interface ModelCounters {
  completed: number;
  failed: number;
  durationMilliseconds: number;
  costInUsdTicks: number;
  lastCompletedAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
}

interface WorkerCounters {
  runs: number;
  failures: number;
  lastCompletedAt: string | null;
  lastFailureAt: string | null;
}

export interface OperationalMetricsOptions {
  readonly model: string;
  readonly reasoningEffort: string;
  readonly sourceRevision?: string;
  readonly expectedBankSyncIntervalMs: number;
  readonly queueHealth: OperationalQueueHealthReader;
  readonly now?: () => Date;
}

type ModelMetadata =
  XaiStructuredRunMetadata | XaiAgentRunMetadata | ReceiptModelRunMetadata;

function safeTimestamp(value: Date): string {
  return value.toISOString();
}

function epochSeconds(value: string | null): number {
  return value === null ? 0 : Math.floor(Date.parse(value) / 1_000);
}

function prometheusLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
}

function safeFailureCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(code)) {
      const stage =
        (error as { readonly invalidResponseStage?: unknown })
          .invalidResponseStage ??
        (error as { readonly responseStage?: unknown }).responseStage;
      if (stage === 'model-mismatch') return 'model-mismatch';
      const httpStatus = (error as { readonly httpStatus?: unknown })
        .httpStatus;
      if (
        code === 'http-error' &&
        typeof httpStatus === 'number' &&
        [408, 429, 500, 502, 503, 504].includes(httpStatus)
      ) {
        return `http-${String(httpStatus)}`;
      }
      return code;
    }
  }
  return 'unknown-error';
}

export class OperationalMetrics {
  readonly #options: OperationalMetricsOptions;
  readonly #model = new Map<ModelClientName, ModelCounters>();
  readonly #workers = new Map<string, WorkerCounters>();
  readonly #modelFailures = new Map<string, number>();
  #bankSync: ActualReadSyncResult | undefined;
  #zdrFailures = 0;
  #modelMismatchFailures = 0;

  constructor(options: OperationalMetricsOptions) {
    this.#options = options;
    for (const client of ['structured', 'receipt'] as const) {
      this.#model.set(client, {
        completed: 0,
        failed: 0,
        durationMilliseconds: 0,
        costInUsdTicks: 0,
        lastCompletedAt: null,
        lastFailureAt: null,
        lastFailureCode: null,
        requestedModel: null,
        resolvedModel: null,
      });
    }
  }

  recordBankSync(result: ActualReadSyncResult): void {
    this.#bankSync = result;
  }

  recordWorkerRun(lane: string, summary: WorkerKickRunSummary): void {
    const now = safeTimestamp(this.#now());
    const current = this.#workers.get(lane) ?? {
      runs: 0,
      failures: 0,
      lastCompletedAt: null,
      lastFailureAt: null,
    };
    current.runs += 1;
    current.failures += summary.failures.length;
    current.lastCompletedAt = now;
    if (summary.failures.length > 0) current.lastFailureAt = now;
    this.#workers.set(lane, current);
  }

  recordModelCompleted(client: ModelClientName, metadata: ModelMetadata): void {
    const counters = this.#requiredModel(client);
    counters.completed += 1;
    counters.durationMilliseconds += metadata.durationMs;
    counters.costInUsdTicks += metadata.usage?.costInUsdTicks ?? 0;
    counters.lastCompletedAt = safeTimestamp(this.#now());
    counters.requestedModel = metadata.requestedModel;
    counters.resolvedModel = metadata.resolvedModel;
    if (metadata.requestedModel !== metadata.resolvedModel) {
      this.#modelMismatchFailures += 1;
    }
  }

  recordModelFailure(client: ModelClientName, error: unknown): void {
    const counters = this.#requiredModel(client);
    const code = safeFailureCode(error);
    counters.failed += 1;
    counters.lastFailureAt = safeTimestamp(this.#now());
    counters.lastFailureCode = code;
    const key = `${client}:${code}`;
    this.#modelFailures.set(key, (this.#modelFailures.get(key) ?? 0) + 1);
    if (code === 'zdr-required') this.#zdrFailures += 1;
    if (code === 'model-mismatch') this.#modelMismatchFailures += 1;
  }

  status(): Readonly<Record<string, unknown>> {
    const now = this.#now();
    const queues = this.#options.queueHealth.read(now.toISOString());
    const overdue = queues.some(
      (queue) =>
        queue.oldestDueAt !== null &&
        now.valueOf() - Date.parse(queue.oldestDueAt) > 15 * 60 * 1_000,
    );
    const freshness = this.#bankSync?.freshness;
    const lastAny = freshness?.bankFeedAsOf ?? null;
    const bankStale =
      lastAny !== null &&
      now.valueOf() - Date.parse(lastAny) >
        this.#options.expectedBankSyncIntervalMs + 6 * 60 * 60 * 1_000;
    const degraded =
      overdue ||
      bankStale ||
      freshness?.lastOutcome === 'partial' ||
      freshness?.lastOutcome === 'failed';
    return {
      status: degraded ? 'degraded' : 'ok',
      build: {
        model: this.#options.model,
        reasoningEffort: this.#options.reasoningEffort,
        sourceRevision: this.#options.sourceRevision ?? 'unknown',
      },
      bank: {
        state: freshness?.lastOutcome ?? 'unknown',
        lastAttemptAt: freshness?.lastAttemptAt ?? null,
        lastFullSuccessAt: freshness?.lastSuccessfulSyncAt ?? null,
        lastAnySuccessAt: lastAny,
        summary: freshness?.lastAttemptSummary ?? null,
      },
      queues,
      model: Object.fromEntries(this.#model),
      workers: Object.fromEntries(this.#workers),
    };
  }

  prometheus(): string {
    const now = this.#now();
    const queues = this.#options.queueHealth.read(now.toISOString());
    const freshness = this.#bankSync?.freshness;
    const buildLabels = `model="${prometheusLabel(this.#options.model)}",reasoning_effort="${prometheusLabel(this.#options.reasoningEffort)}",revision="${prometheusLabel(this.#options.sourceRevision ?? 'unknown')}"`;
    const lines = [
      '# HELP household_finance_build_info Configured model and source revision.',
      '# TYPE household_finance_build_info gauge',
      `household_finance_build_info{${buildLabels}} 1`,
      '# TYPE household_finance_bank_last_attempt_timestamp_seconds gauge',
      `household_finance_bank_last_attempt_timestamp_seconds ${String(epochSeconds(freshness?.lastAttemptAt ?? null))}`,
      '# TYPE household_finance_bank_last_full_success_timestamp_seconds gauge',
      `household_finance_bank_last_full_success_timestamp_seconds ${String(epochSeconds(freshness?.lastSuccessfulSyncAt ?? null))}`,
      '# TYPE household_finance_bank_last_any_success_timestamp_seconds gauge',
      `household_finance_bank_last_any_success_timestamp_seconds ${String(epochSeconds(freshness?.bankFeedAsOf ?? null))}`,
      '# TYPE household_finance_bank_sync_outcome gauge',
      ...(
        ['succeeded', 'partial', 'failed', 'skipped-recent', 'never'] as const
      ).map(
        (outcome) =>
          `household_finance_bank_sync_outcome{outcome="${outcome}"} ${freshness?.lastOutcome === outcome ? '1' : '0'}`,
      ),
      '# TYPE household_finance_bank_accounts gauge',
      `household_finance_bank_accounts{result="attempted"} ${String(freshness?.lastAttemptSummary?.attemptedAccountCount ?? 0)}`,
      `household_finance_bank_accounts{result="succeeded"} ${String(freshness?.lastAttemptSummary?.succeededAccountCount ?? 0)}`,
      `household_finance_bank_accounts{result="failed"} ${String(freshness?.lastAttemptSummary?.failedAccountCount ?? 0)}`,
      '# TYPE household_finance_queue_due gauge',
      ...queues.map(
        (queue) =>
          `household_finance_queue_due{queue="${queue.queue}"} ${String(queue.due)}`,
      ),
      '# TYPE household_finance_queue_processing gauge',
      ...queues.map(
        (queue) =>
          `household_finance_queue_processing{queue="${queue.queue}"} ${String(queue.processing)}`,
      ),
      '# TYPE household_finance_queue_oldest_due_timestamp_seconds gauge',
      ...queues.map(
        (queue) =>
          `household_finance_queue_oldest_due_timestamp_seconds{queue="${queue.queue}"} ${String(epochSeconds(queue.oldestDueAt))}`,
      ),
      '# TYPE household_finance_worker_runs_total counter',
      ...[...this.#workers].map(
        ([lane, counters]) =>
          `household_finance_worker_runs_total{lane="${prometheusLabel(lane)}"} ${String(counters.runs)}`,
      ),
      '# TYPE household_finance_worker_failures_total counter',
      ...[...this.#workers].map(
        ([lane, counters]) =>
          `household_finance_worker_failures_total{lane="${prometheusLabel(lane)}"} ${String(counters.failures)}`,
      ),
      '# TYPE household_finance_model_runs_total counter',
      ...[...this.#model].flatMap(([client, counters]) => [
        `household_finance_model_runs_total{client="${client}",outcome="completed"} ${String(counters.completed)}`,
        `household_finance_model_runs_total{client="${client}",outcome="failed"} ${String(counters.failed)}`,
      ]),
      '# TYPE household_finance_model_duration_milliseconds_total counter',
      ...[...this.#model].map(
        ([client, counters]) =>
          `household_finance_model_duration_milliseconds_total{client="${client}"} ${String(counters.durationMilliseconds)}`,
      ),
      '# TYPE household_finance_model_cost_usd_ticks_total counter',
      ...[...this.#model].map(
        ([client, counters]) =>
          `household_finance_model_cost_usd_ticks_total{client="${client}"} ${String(counters.costInUsdTicks)}`,
      ),
      '# TYPE household_finance_model_zdr_failures_total counter',
      `household_finance_model_zdr_failures_total ${String(this.#zdrFailures)}`,
      '# TYPE household_finance_model_mismatch_failures_total counter',
      `household_finance_model_mismatch_failures_total ${String(this.#modelMismatchFailures)}`,
      '# TYPE household_finance_model_failures_total counter',
      ...[...this.#modelFailures].map(([key, count]) => {
        const [client, error] = key.split(':');
        return `household_finance_model_failures_total{client="${client}",error="${error}"} ${String(count)}`;
      }),
    ];
    return `${lines.join('\n')}\n`;
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #requiredModel(client: ModelClientName): ModelCounters {
    const counters = this.#model.get(client);
    if (counters === undefined) throw new TypeError('Unknown model client');
    return counters;
  }
}
