import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ActualApiExistingTransactionUpdatePort,
  ActualExistingTransactionWriter,
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateReconciler,
  ActualUpdateWorkflow,
  type ActualUpdateApiFacade,
  type ActualUpdateCoreClient,
} from './actual-update/index.js';
import {
  loadActualWriterConfig,
  type ActualWriterConfig,
} from './actual-writer-config.js';
import {
  ActualReceiptNoteWriter,
  ReceiptNoteEnvelopeAuthenticator,
  ReceiptNoteOutboxStore,
  ReceiptNoteReconciler,
  ReceiptNoteWorkflow,
} from './actual-receipt-note/index.js';
import {
  ActualProductionBoundary,
  type ActualProductionApi,
} from './integrations/actual/actual-production-boundary.js';
import { ActualUpdateIntentStore } from './storage/actual-update-store.js';

export interface ActualWriterActualModule extends ActualProductionApi {
  readonly getTransactions: ActualUpdateApiFacade['getTransactions'];
  readonly getNote: (
    id: string,
  ) => Promise<{ readonly id: string; readonly note: string } | null>;
  readonly updateNote: (id: string, note: string) => Promise<void>;
}

export function assertActualUpdateCoreClient(
  value: unknown,
): asserts value is ActualUpdateCoreClient {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof (value as { readonly send?: unknown }).send !== 'function'
  ) {
    throw new TypeError(
      'Actual API init did not return the awaited core update client',
    );
  }
}

function startFatalWatchdog(scope: string, timeoutMs: number): () => void {
  const timeout = setTimeout(() => {
    process.stderr.write(`actual-writer ${scope} timed out; exiting safely\n`);
    process.exit(1);
  }, timeoutMs);
  return () => clearTimeout(timeout);
}

export interface ActualWriterWorkQueue {
  readonly runOne: () => Promise<boolean>;
}

export interface ActualWriterCloseable {
  readonly close: () => void;
}

export interface ActualWriterDestroyable {
  readonly destroy: () => void;
}

export interface ActualWriterServiceLoopOptions {
  readonly queues: readonly ActualWriterWorkQueue[];
  readonly boundary: Pick<ActualProductionBoundary, 'shutdown'>;
  readonly stores: readonly ActualWriterCloseable[];
  readonly authenticators: readonly ActualWriterDestroyable[];
  readonly pollIntervalMs: number;
  readonly operationTimeoutMs: number;
  readonly startWatchdog?: (scope: string, timeoutMs: number) => () => void;
  readonly onCycleFailure?: (error: unknown) => void;
  readonly onCleanupFailure?: (error: unknown) => void;
}

/**
 * One leased/reconciled intent is processed per watchdog window. Shutdown is
 * idempotent and always attempts every cleanup step, even when the active
 * cycle or Actual shutdown fails.
 */
export class ActualWriterServiceLoop {
  readonly #options: ActualWriterServiceLoopOptions;
  readonly #startWatchdog: (scope: string, timeoutMs: number) => () => void;
  #poller: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #shutdownPromise: Promise<void> | undefined;
  #started = false;
  #shutdownRequested = false;
  #cycleFailureHandled = false;
  #nextQueueIndex = 0;

  constructor(options: ActualWriterServiceLoopOptions) {
    if (
      !Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs < 250 ||
      options.pollIntervalMs > 60_000 ||
      !Number.isSafeInteger(options.operationTimeoutMs) ||
      options.operationTimeoutMs < 10_000 ||
      options.operationTimeoutMs > 120_000 ||
      options.queues.length === 0
    ) {
      throw new RangeError('Actual writer loop timing is invalid');
    }
    this.#options = options;
    this.#startWatchdog = options.startWatchdog ?? startFatalWatchdog;
  }

  get isShuttingDown(): boolean {
    return this.#shutdownRequested;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error('Actual writer service loop can be started only once');
    }
    this.#started = true;
    try {
      await this.#runCycle();
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.shutdown();
      } catch (candidate) {
        cleanupError = candidate;
      }
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          'Actual writer startup cycle and cleanup both failed',
          { cause: error },
        );
      }
      throw error;
    }
    if (this.#shutdownRequested) {
      return;
    }
    this.#poller = setInterval(() => {
      void this.#runCycle().catch((error: unknown) => {
        void this.#handleCycleFailure(error);
      });
    }, this.#options.pollIntervalMs);
  }

  shutdown(): Promise<void> {
    this.#shutdownRequested = true;
    this.#shutdownPromise ??= this.#closeAllResources();
    return this.#shutdownPromise;
  }

  #runCycle(): Promise<void> {
    if (this.#shutdownRequested) {
      return Promise.resolve();
    }
    this.#running ??= (async () => {
      const clearWatchdog = this.#startWatchdog(
        'operation',
        this.#options.operationTimeoutMs,
      );
      try {
        const start = this.#nextQueueIndex % this.#options.queues.length;
        this.#nextQueueIndex =
          (this.#nextQueueIndex + 1) % this.#options.queues.length;
        for (
          let offset = 0;
          offset < this.#options.queues.length;
          offset += 1
        ) {
          const queue =
            this.#options.queues[
              (start + offset) % this.#options.queues.length
            ];
          if (queue !== undefined && (await queue.runOne())) {
            break;
          }
        }
      } finally {
        clearWatchdog();
      }
    })().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #handleCycleFailure(error: unknown): Promise<void> {
    if (this.#cycleFailureHandled) {
      return;
    }
    this.#cycleFailureHandled = true;
    this.#options.onCycleFailure?.(error);
    try {
      await this.shutdown();
    } catch (cleanupError) {
      this.#options.onCleanupFailure?.(cleanupError);
    }
  }

  async #closeAllResources(): Promise<void> {
    if (this.#poller !== undefined) {
      clearInterval(this.#poller);
      this.#poller = undefined;
    }
    const errors: unknown[] = [];
    const running = this.#running;
    if (running !== undefined) {
      try {
        await running;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.#options.boundary.shutdown();
    } catch (error) {
      errors.push(error);
    }
    for (const store of this.#options.stores) {
      try {
        store.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const authenticator of this.#options.authenticators) {
      try {
        authenticator.destroy();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'Actual writer shutdown did not complete cleanly',
      );
    }
  }
}

async function closePartialResources(input: {
  readonly boundary?: Pick<ActualProductionBoundary, 'shutdown'>;
  readonly stores?: readonly ActualWriterCloseable[];
  readonly authenticators?: readonly ActualWriterDestroyable[];
}): Promise<void> {
  const errors: unknown[] = [];
  if (input.boundary !== undefined) {
    try {
      await input.boundary.shutdown();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const store of input.stores ?? []) {
    try {
      store.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const authenticator of input.authenticators ?? []) {
    try {
      authenticator.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Actual writer partial startup cleanup failed',
    );
  }
}

export async function createActualWriterServiceLoop(
  config: ActualWriterConfig,
  actualModule: ActualWriterActualModule,
): Promise<ActualWriterServiceLoop> {
  const boundary = new ActualProductionBoundary(
    {
      dataDir: config.actualApiDataDirectory,
      serverURL: config.serverUrl,
      serverPassword: config.serverPassword,
      productionContract: config.productionContract,
    },
    actualModule,
  );
  let coreClient: ActualUpdateCoreClient | undefined;
  let store: ActualUpdateIntentStore | undefined;
  let authenticator: ActualUpdateEnvelopeAuthenticator | undefined;
  let receiptStore: ReceiptNoteOutboxStore | undefined;
  let receiptAuthenticator: ReceiptNoteEnvelopeAuthenticator | undefined;

  const clearStartupWatchdog = startFatalWatchdog(
    'startup',
    config.operationTimeoutMs,
  );
  try {
    const initialized = await boundary.initialize();
    assertActualUpdateCoreClient(initialized);
    coreClient = initialized;
  } catch (error) {
    let cleanupError: unknown;
    try {
      await closePartialResources({ boundary });
    } catch (candidate) {
      cleanupError = candidate;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        'Actual writer boundary initialization and cleanup both failed',
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearStartupWatchdog();
  }

  try {
    if (coreClient === undefined) {
      throw new Error('Actual update core client was not initialized');
    }
    const updateApi: ActualUpdateApiFacade = {
      sync: () => actualModule.sync(),
      getTransactions: (accountId, startDate, endDate) =>
        actualModule.getTransactions(accountId, startDate, endDate),
      getPayees: () => actualModule.getPayees(),
    };
    const writer = new ActualExistingTransactionWriter({
      port: new ActualApiExistingTransactionUpdatePort(updateApi, coreClient),
      allowedAccountIds: Object.values(config.productionContract.accounts).map(
        (account) => account.id,
      ),
      allowedCategoryIds: Object.values(
        config.productionContract.categories,
      ).map((category) => category.id),
    });
    authenticator = new ActualUpdateEnvelopeAuthenticator({
      activeKeyId: config.updateSigningKeyId,
      keys: config.updateSigningKeys,
      targetReferenceKey: config.updateTargetReferenceKey,
    });
    store = new ActualUpdateIntentStore(config.databasePath);
    const workflow = new ActualUpdateWorkflow({
      store,
      writer,
      authenticator,
    });
    const reconciler = new ActualUpdateReconciler(workflow);
    receiptAuthenticator = new ReceiptNoteEnvelopeAuthenticator({
      activeKeyId: config.updateSigningKeyId,
      keys: config.updateSigningKeys,
    });
    receiptStore = new ReceiptNoteOutboxStore(config.databasePath);
    const receiptWorkflow = new ReceiptNoteWorkflow({
      store: receiptStore,
      writer: new ActualReceiptNoteWriter({
        getNote: (id) => actualModule.getNote(id),
        updateNote: (id, note) => actualModule.updateNote(id, note),
        sync: () => actualModule.sync(),
      }),
      authenticator: receiptAuthenticator,
    });
    const receiptReconciler = new ReceiptNoteReconciler({
      store: receiptStore,
      workflow: receiptWorkflow,
    });
    return new ActualWriterServiceLoop({
      queues: [
        {
          runOne: async () => {
            const result = await reconciler.run(1);
            return result.processed.length > 0;
          },
        },
        receiptReconciler,
      ],
      boundary,
      stores: [store, receiptStore],
      authenticators: [authenticator, receiptAuthenticator],
      pollIntervalMs: config.pollIntervalMs,
      operationTimeoutMs: config.operationTimeoutMs,
      onCycleFailure: () => {
        process.stderr.write(
          'actual-writer cycle failed; stopping for startup recovery\n',
        );
        process.exitCode = 1;
      },
      onCleanupFailure: () => {
        process.stderr.write(
          'actual-writer cleanup failed after cycle failure\n',
        );
        process.exitCode = 1;
      },
    });
  } catch (error) {
    let cleanupError: unknown;
    try {
      await closePartialResources({
        boundary,
        stores: [
          ...(store === undefined ? [] : [store]),
          ...(receiptStore === undefined ? [] : [receiptStore]),
        ],
        authenticators: [
          ...(authenticator === undefined ? [] : [authenticator]),
          ...(receiptAuthenticator === undefined ? [] : [receiptAuthenticator]),
        ],
      });
    } catch (candidate) {
      cleanupError = candidate;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [error, cleanupError],
        'Actual writer startup and cleanup both failed',
        { cause: error },
      );
    }
    throw error;
  }
}

export async function startActualWriterService(): Promise<void> {
  let loop: ActualWriterServiceLoop | undefined;
  let pendingSignal: NodeJS.Signals | undefined;
  const handleSignal = (signal: NodeJS.Signals): void => {
    process.stdout.write(`received ${signal}; actual-writer shutting down\n`);
    if (loop === undefined) {
      pendingSignal = signal;
      return;
    }
    void loop.shutdown().catch(() => {
      process.stderr.write('actual-writer graceful shutdown failed\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    const config = loadActualWriterConfig();
    const actualModule = await import('@actual-app/api');
    loop = await createActualWriterServiceLoop(config, actualModule);
    if (pendingSignal !== undefined) {
      await loop.shutdown();
      return;
    }
    await loop.start();
    if (loop.isShuttingDown) {
      return;
    }
    process.stdout.write('actual-writer ready\n');
  } catch (error) {
    if (loop !== undefined) {
      await loop.shutdown().catch(() => undefined);
    }
    throw error;
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    import.meta.url === pathToFileURL(resolve(entry)).href
  );
}

if (isEntrypoint()) {
  void startActualWriterService().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'UnknownError';
    process.stderr.write(`actual-writer startup failed: ${name}\n`);
    process.exitCode = 1;
  });
}
