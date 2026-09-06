import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as api from '@actual-app/api';
import { config, secret } from './config.js';
import { Store } from './store.js';
import { ActualLedger } from './actual.js';
import { Model } from './model.js';
import { Engine } from './engine.js';
import { Talk, webhook, fromHistory } from './talk.js';
import { Fault } from './domain.js';

export async function main(): Promise<void> {
  const c = config(process.env.FINANCE_CONFIG ?? '/run/secrets/finance_config');
  if (!c.activate) throw new Fault('activation-disabled');
  mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(c.dataDir, 'finance.sqlite'), true);
  if (!store.getMeta('talk-cursor')) throw new Fault('talk-cursor-missing');
  // The Actual SDK emits transaction data in debug output. Never forward it
  // to production logs. Our operational output is explicit, aggregate JSON.
  console.log =
    console.warn =
    console.error =
    console.debug =
    console.info =
      () => {};
  mkdirSync(join(c.dataDir, 'actual-cache'), { recursive: true, mode: 0o700 });
  const client = await api.init({
    dataDir: join(c.dataDir, 'actual-cache'),
    serverURL: c.actual.url,
    password: secret(c.actual.passwordFile),
  });
  await api.downloadBudget(c.actual.budget);
  const ledger = new ActualLedger(new Set(c.actual.readAccounts), client);
  const talk = new Talk({
    ...c.talk,
    secret: secret(c.talk.secretFile),
    password: secret(c.talk.passwordFile),
  });
  const model = new Model({ ...c.model, key: secret(c.model.keyFile) }, store);
  const engine = new Engine(store, ledger, model, talk, {
    speakers: new Set(c.talk.users),
    writeAccounts: new Set(c.actual.writeAccounts),
    currency: c.currency,
    automaticCategories: new Set(c.actual.automaticCategories),
  });
  await engine.refresh();
  let stopping = false,
    busy = false,
    lastDiscover = 0,
    lastBackfill = 0,
    lastLoop = Date.now();
  const server = createServer((req, res) => {
    if (
      req.method === 'GET' &&
      (req.url === '/health/ready' || req.url === '/health/status')
    ) {
      res.writeHead(stopping || Date.now() - lastLoop > 180000 ? 503 : 200, {
        'content-type': 'application/json',
      });
      res.end(
        JSON.stringify({
          status: stopping ? 'stopping' : 'ok',
          revision: process.env.SOURCE_REVISION ?? 'development',
          ...(store.status() as object),
        }),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/talk/webhook') {
      res.writeHead(404);
      res.end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        res.writeHead(413);
        res.end();
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v[0] : v,
          ]),
        );
        const message = webhook(Buffer.concat(chunks), headers, talk.config);
        if (message)
          store.intake(
            message,
            message.attachments.length ? 'attachment' : 'question',
            message,
          );
        res.writeHead(202);
        res.end();
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
    req.on('error', () => undefined);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve) =>
    server.listen(c.port, '0.0.0.0', resolve),
  );
  async function tick(): Promise<void> {
    if (stopping || busy) return;
    busy = true;
    try {
      if (Date.now() - lastBackfill > 15000) {
        const cursor = store.getMeta('talk-cursor');
        if (!cursor) throw new Fault('talk-cursor-missing');
        lastBackfill = Date.now();
        const rows = await talk.history(cursor, true).catch(() => {
          store.setMeta('talk-backfill-error', new Date().toISOString());
          return [];
        });
        store.db.transaction(() => {
          for (const row of [...rows].sort(
            (a, b) => Number(a.id) - Number(b.id),
          )) {
            const message = fromHistory(row, talk.config);
            if (message)
              store.intake(
                message,
                message.attachments.length ? 'attachment' : 'question',
                message,
              );
            store.setMeta('talk-cursor', row.id);
          }
        })();
        lastBackfill = Date.now();
      }
      const job = store.next();
      if (job) await engine.run(job);
      else if (Date.now() - lastDiscover > 300000) {
        await engine.discover();
        lastDiscover = Date.now();
      }
      await engine.flushReplies();
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          event: 'worker-error',
          code: error instanceof Fault ? error.code : 'operation-failed',
        }) + '\n',
      );
    } finally {
      busy = false;
      lastLoop = Date.now();
    }
  }
  const timer = setInterval(() => {
    if (busy && Date.now() - lastLoop > 150000) {
      process.stderr.write('{"event":"worker-timeout"}\n');
      process.exit(1);
    }
    void tick();
  }, 1000);
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close();
    void (async () => {
      const deadline = Date.now() + 130000;
      while (busy && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      if (busy) process.exit(1);
      await api.shutdown();
      store.close();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdout.write(JSON.stringify({ event: 'ready', port: c.port }) + '\n');
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      event: 'startup-failed',
      code:
        error instanceof Fault
          ? error.code
          : 'invalid-configuration-or-dependency',
    }) + '\n',
  );
  process.exitCode = 1;
});
