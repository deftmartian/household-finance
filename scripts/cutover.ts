// Explicit offline release tool. Never included in the application image.
import * as api from '@actual-app/api';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config, secret } from '../src/config.js';
import { Store } from '../src/store.js';
import { Talk } from '../src/talk.js';
import { canonical, hash, purchaseDetails } from '../src/domain.js';
import { snapshot, quietSdk } from './actual-snapshot.js';
import { planConversion, snapshotSchema } from './conversion.js';
import type { Change, Conversion } from './conversion.js';
import { applyConversion } from './apply-conversion.js';
import { convertContext } from './convert-context.js';
quietSdk();
const mode = process.argv[2],
  root = process.env.CUTOVER_DIR ?? '/cutover';
const read = (name: string): unknown =>
  JSON.parse(readFileSync(root + '/' + name, 'utf8'));
let phase = 'configuration';
try {
  const c = config(process.env.FINANCE_CONFIG ?? '/run/secrets/finance_config');
  if (!['cursor', 'snapshot', 'apply', 'verify'].includes(mode ?? ''))
    throw new Error('invalid-cutover-mode');
  mkdirSync(root + '/actual-cache', { recursive: true, mode: 0o700 });
  const client = await api.init({
    dataDir: root + '/actual-cache',
    serverURL: c.actual.url,
    password: secret(c.actual.passwordFile),
  });
  phase = 'download';
  await api.downloadBudget(c.actual.budget);
  const talk = new Talk({
    ...c.talk,
    secret: secret(c.talk.secretFile),
    password: secret(c.talk.passwordFile),
  });
  const base = `${c.talk.url}/remote.php/dav/files/${encodeURIComponent(c.talk.user)}`;
  if (mode === 'cursor') {
    const history = await talk.history();
    const cursor = history.reduce(
      (n, r) => (BigInt(r.id) > BigInt(n) ? r.id : n),
      '0',
    );
    if (cursor === '0') throw new Error('talk-cursor-unavailable');
    writeFileSync(root + '/cursor.json', JSON.stringify({ cursor }), {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(JSON.stringify({ cursorCaptured: true }) + '\n');
  } else if (mode === 'snapshot') {
    if (existsSync(root + '/source.json'))
      throw new Error('snapshot-already-exists');
    const cursor = (read('cursor.json') as { cursor: string }).cursor;
    if (!/^[1-9][0-9]*$/.test(cursor))
      throw new Error('talk-cursor-unavailable');
    phase = 'snapshot';
    const source = await snapshot();
    const initial = planConversion(
      source,
      base,
      c.talk.archive + '/Purchase Details',
    );
    const detailLinks: Record<string, string> = {};
    for (const detail of initial.details) {
      const purchase = initial.purchases.find(
        (p) => purchaseDetails(p) === detail.body,
      );
      if (!purchase) throw new Error('unknown-purchase-detail');
      detailLinks[detail.url] = await talk.details(
        purchase.id,
        purchase.revision,
        detail.body,
      );
    }
    const plan = planConversion(
      source,
      base,
      c.talk.archive + '/Purchase Details',
      detailLinks,
    );
    writeFileSync(root + '/detail-links.json', JSON.stringify(detailLinks), {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(root + '/source.json', JSON.stringify(source), {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(root + '/actual.zip', await api.exportBudget(), {
      mode: 0o600,
      flag: 'wx',
    });
    writeFileSync(root + '/plan.json', JSON.stringify(plan), {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(
      JSON.stringify({
        snapshot: true,
        counts: plan.counts,
        operations: plan.changes.length,
        sourceHash: plan.sourceHash,
        protectedHash: plan.protectedHash,
        detailViews: plan.details.length,
      }) + '\n',
    );
  } else {
    const source = snapshotSchema.parse(read('source.json')),
      plan = read('plan.json') as Conversion;
    if (
      canonical(plan) !==
      canonical(
        planConversion(
          source,
          base,
          c.talk.archive + '/Purchase Details',
          read('detail-links.json') as Record<string, string>,
        ),
      )
    )
      throw new Error('conversion-manifest-mismatch');
    const journal = new Store(root + '/conversion.sqlite');
    let writes = 0;
    const target = {
      snapshot,
      current: async (change: Change) => {
        // Verification never writes; its full before/after snapshots sync once each.
        // Avoid hundreds of redundant server syncs while comparing cached notes.
        if (mode !== 'verify') await api.sync();
        if (change.kind === 'note')
          return (await api.getNote(change.id))?.note ?? null;
        const parent = source.transactions.find(
          (t) =>
            t.id === change.id ||
            (Array.isArray(t.subtransactions) &&
              t.subtransactions.some(
                (s: unknown) => (s as { id: string }).id === change.id,
              )),
        );
        if (!parent) throw new Error('unknown-conversion-transaction');
        const rows = await api.getTransactions(
          String(parent.account),
          '1900-01-01',
          '2100-01-01',
        );
        const row = rows
          .flatMap((t) => [t, ...(t.subtransactions ?? [])])
          .find((t) => t.id === change.id);
        if (!row) throw new Error('missing-conversion-transaction');
        return row.notes ?? null;
      },
      note: async (id: string, note: string) => {
        if (mode === 'verify') throw new Error('verification-would-write');
        writes++;
        await api.updateNote(id, note);
      },
      transactionNote: async (id: string, notes: string) => {
        if (mode === 'verify') throw new Error('verification-would-write');
        writes++;
        await (
          client.send as (name: string, args: unknown) => Promise<unknown>
        )('transactions-batch-update', {
          added: [],
          updated: [{ id, notes }],
          deleted: [],
          learnCategories: false,
          runTransfers: false,
        });
      },
      detail: async (url: string, body: string) => {
        const p = plan.purchases.find((p) => purchaseDetails(p) === body);
        if (!p) throw new Error('unknown-purchase-detail');
        if (mode === 'verify') return;
        if ((await talk.details(p.id, p.revision, body)) !== url)
          throw new Error('detail-url-mismatch');
      },
    };
    phase = 'conversion';
    await applyConversion(source, plan, journal, target);
    journal.close();
    phase = 'context';
    mkdirSync(root + '/app-data', { recursive: true, mode: 0o700 });
    const store = new Store(root + '/app-data/finance.sqlite');
    const context = convertContext(
      read('profile.json'),
      root + '/stores',
      store,
      c.talk.users,
      plan.purchases,
      (read('cursor.json') as { cursor: string }).cursor,
      read('taxonomy.json'),
    );
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    store.close();
    writeFileSync(
      root + '/verified.json',
      JSON.stringify({
        at: new Date().toISOString(),
        sourceHash: hash(source),
        writes,
        context,
      }),
      { mode: 0o600 },
    );
    process.stdout.write(
      JSON.stringify({ verified: true, writes, context }) + '\n',
    );
  }
} catch (error) {
  writeFileSync(
    root + '/failure.json',
    JSON.stringify({
      phase,
      name: error instanceof Error ? error.name : 'unknown',
      code: error instanceof Error && 'code' in error ? error.code : null,
      message: error instanceof Error ? error.message : 'unknown',
      stack: error instanceof Error ? error.stack : null,
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      phase,
      error:
        error instanceof Error && /^[a-z-]+$/.test(error.message)
          ? error.message
          : 'cutover-failed',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await api.shutdown();
}
