import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import * as api from '@actual-app/api';
import { config, secret } from './config.js';
import { Store } from './store.js';
import { ActualLedger } from './actual.js';
import { Talk } from './talk.js';
import { Fault } from './domain.js';
import * as review from './review.js';

const USAGE = new Set([
  'status',
  'sync',
  'pending',
  'receipt',
  'match',
  'apply',
  'items',
]);
function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function code(error: unknown): string {
  return error instanceof Fault
    ? error.code
    : error instanceof z.ZodError || error instanceof SyntaxError
      ? 'invalid-input'
      : 'operation-failed';
}
async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || !USAGE.has(command)) throw new Fault('usage');
  const flags = rest.filter((a) => a.startsWith('--'));
  const positional = rest.filter((a) => !a.startsWith('--'));
  if (flags.some((f) => f !== '--commit' || command !== 'apply'))
    throw new Fault('usage');
  const c = config(process.env.FINANCE_CONFIG ?? '/run/secrets/finance_config');
  // Read the operator's input before connecting to anything.
  const plan =
    command === 'apply'
      ? (() => {
          if (positional.length !== 1) throw new Fault('usage');
          return review.planSchema.parse(
            // '-' reads the plan from stdin, so nothing is staged in the container.
            JSON.parse(
              readFileSync(positional[0] === '-' ? 0 : positional[0]!, 'utf8'),
            ),
          );
        })()
      : undefined;
  if (command === 'receipt' && positional.length !== 3)
    throw new Fault('usage');
  if (
    ['status', 'sync', 'pending', 'match', 'items'].includes(command) &&
    positional.length
  )
    throw new Fault('usage');
  // The Actual SDK emits transaction data in debug output; never print it.
  console.log =
    console.warn =
    console.error =
    console.debug =
    console.info =
      () => {};
  const itemsPath = join(c.dataDir, 'item-map.json');
  mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(c.dataDir, 'finance.sqlite'));
  store.db.pragma('busy_timeout = 30000');
  // A private cache: never share the running bot's budget copy.
  const cache = mkdtempSync(join(tmpdir(), 'finance-session-'));
  let connected = false;
  try {
    const client = await api.init({
      dataDir: cache,
      serverURL: c.actual.url,
      password: secret(c.actual.passwordFile),
    });
    connected = true;
    await api.downloadBudget(c.actual.budget);
    const ledger = new ActualLedger(new Set(c.actual.readAccounts), client);
    const talk = new Talk({
      ...c.talk,
      secret: secret(c.talk.secretFile),
      password: secret(c.talk.passwordFile),
    });
    const session: review.Session = {
      store,
      ledger,
      writeAccounts: new Set(c.actual.writeAccounts),
      currency: c.currency,
      itemsPath,
      original: (url) => talk.original(url),
      details: (id, revision, body) => talk.details(id, revision, body),
      now: () => new Date(),
    };
    if (command === 'status') out(await review.status(session));
    else if (command === 'sync') out(await review.sync(session));
    else if (command === 'pending') out(await review.pending(session));
    else if (command === 'match') out(await review.match(session));
    else if (command === 'items') out(review.items(session));
    else if (command === 'receipt') {
      const index = Number(positional[1]);
      if (!Number.isInteger(index) || index < 0) throw new Fault('usage');
      // '-' streams the verified original to stdout and its metadata to stderr.
      const toStdout = positional[2] === '-';
      const result = await review.receipt(
        session,
        positional[0]!,
        index,
        toStdout ? undefined : resolve(positional[2]!),
      );
      if (toStdout) {
        await new Promise<void>((done, fail) =>
          process.stdout.write(result.data, (e) => (e ? fail(e) : done())),
        );
        process.stderr.write(JSON.stringify(result.meta) + '\n');
      } else out(result.meta);
    } else {
      const result = await review.apply(
        session,
        plan,
        flags.includes('--commit'),
      );
      out(result);
      if (!result.ok) process.exitCode = 1;
    }
  } finally {
    if (connected) await api.shutdown().catch(() => undefined);
    store.close();
    rmSync(cache, { recursive: true, force: true });
  }
}
run(process.argv.slice(2))
  .catch((error) => {
    out({ error: code(error) });
    process.exitCode = 1;
  })
  // The Actual SDK can keep handles open; leave once stdout has drained.
  .finally(() =>
    process.stdout.write('', () => process.exit(process.exitCode)),
  );
