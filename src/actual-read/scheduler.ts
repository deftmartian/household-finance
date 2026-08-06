import type { ActualReadPort, ActualReadSyncResult } from './port.js';

export interface BankSyncSchedulerOptions {
  readonly reader: Pick<ActualReadPort, 'syncNow'>;
  readonly intervalMs: number;
  readonly onCompletedImportAttempt?: (
    result: ActualReadSyncResult,
  ) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly setIntervalImplementation?: typeof setInterval;
  readonly clearIntervalImplementation?: typeof clearInterval;
}

export class BankSyncScheduler {
  readonly #reader: Pick<ActualReadPort, 'syncNow'>;
  readonly #intervalMs: number;
  readonly #onCompletedImportAttempt:
    ((result: ActualReadSyncResult) => void | Promise<void>) | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #setInterval: typeof setInterval;
  readonly #clearInterval: typeof clearInterval;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<ActualReadSyncResult> | undefined;
  #stopped = false;

  constructor(options: BankSyncSchedulerOptions) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 60_000 ||
      options.intervalMs > 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new RangeError('Bank sync interval is outside the safe range');
    }
    this.#reader = options.reader;
    this.#intervalMs = options.intervalMs;
    this.#onCompletedImportAttempt = options.onCompletedImportAttempt;
    this.#onError =
      options.onError ??
      (() => {
        // The reader persists bounded failure freshness for user disclosure.
      });
    this.#setInterval = options.setIntervalImplementation ?? setInterval;
    this.#clearInterval = options.clearIntervalImplementation ?? clearInterval;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) {
      throw new Error('Bank sync scheduler cannot be started in this state');
    }
    void this.runNow().catch(this.#onError);
    this.#timer = this.#setInterval(() => {
      void this.runNow().catch(this.#onError);
    }, this.#intervalMs);
  }

  runNow(): Promise<ActualReadSyncResult> {
    if (this.#stopped) {
      return Promise.reject(new Error('Bank sync scheduler is stopped'));
    }
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      this.#clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#running;
  }

  async #run(): Promise<ActualReadSyncResult> {
    const result = await this.#reader.syncNow();
    if (result.outcome !== 'skipped-recent') {
      await this.#onCompletedImportAttempt?.(result);
    }
    return result;
  }
}
