import { ActualApiReadPort } from './actual-read/actual-api-reader.js';
import { loadActualReaderServiceConfig } from './actual-read/config.js';
import { createActualReadHttpServer } from './actual-read/http-service.js';

function startFatalWatchdog(scope: string, timeoutMs: number): () => void {
  const timeout = setTimeout(() => {
    process.stderr.write(`actual-reader ${scope} timed out; exiting safely\n`);
    process.exit(1);
  }, timeoutMs);
  return () => clearTimeout(timeout);
}

async function start(): Promise<void> {
  const config = loadActualReaderServiceConfig();
  const reader = new ActualApiReadPort(
    {
      dataDir: config.dataDirectory,
      serverURL: config.serverUrl,
      serverPassword: config.serverPassword,
      readContract: config.readContract,
    },
    {
      startOperationWatchdog: () =>
        startFatalWatchdog('operation', config.operationTimeoutMs),
    },
  );
  await reader.initialize();

  let shuttingDown = false;
  const server = createActualReadHttpServer(reader);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
  } catch (error) {
    await reader.shutdown().catch(() => undefined);
    throw error;
  }
  process.stdout.write(
    `actual-reader listening on ${config.host}:${String(config.port)}\n`,
  );

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`received ${signal}; actual-reader shutting down\n`);
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
    await reader.shutdown();
  }
  process.once('SIGINT', (signal) => {
    void shutdown(signal).catch(() => {
      process.stderr.write('actual-reader graceful shutdown failed\n');
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', (signal) => {
    void shutdown(signal).catch(() => {
      process.stderr.write('actual-reader graceful shutdown failed\n');
      process.exitCode = 1;
    });
  });
}

void start().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`actual-reader startup failed: ${name}\n`);
  process.exitCode = 1;
});
