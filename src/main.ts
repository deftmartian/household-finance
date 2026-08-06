import type { Server } from 'node:http';

import { loadConfig } from './config.js';
import { createHttpServer } from './http.js';
import {
  createProductionRuntime,
  type ProductionRuntime,
} from './production-runtime.js';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

async function cleanUpFailedStartup(runtime: ProductionRuntime): Promise<void> {
  runtime.beginShutdown();
  try {
    await runtime.stopBankSync();
  } finally {
    runtime.close();
  }
}

async function start(): Promise<void> {
  const config = loadConfig();
  const runtime =
    config.intakeMode === 'production'
      ? createProductionRuntime(config)
      : undefined;

  let server: Server;
  try {
    server = createHttpServer(config, runtime?.httpDependencies);
    runtime?.startBackgroundWork();
    server.listen(config.port, config.host, () => {
      process.stdout.write(
        `finance-bot listening on ${config.host}:${String(config.port)}; intake=${config.intakeMode}\n`,
      );
    });
  } catch (error) {
    if (runtime !== undefined) {
      try {
        await cleanUpFailedStartup(runtime);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Finance-bot startup and cleanup both failed',
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`received ${signal}; shutting down\n`);
    runtime?.beginShutdown();
    try {
      await runtime?.stopBankSync();
      await closeServer(server);
      await runtime?.drainWorkers();
    } finally {
      runtime?.close();
    }
  }

  process.once('SIGINT', (signal) => {
    void shutdown(signal).catch(() => {
      process.stderr.write('graceful shutdown failed\n');
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', (signal) => {
    void shutdown(signal).catch(() => {
      process.stderr.write('graceful shutdown failed\n');
      process.exitCode = 1;
    });
  });
}

void start().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  process.stderr.write(`finance-bot startup failed: ${name}\n`);
  process.exitCode = 1;
});
