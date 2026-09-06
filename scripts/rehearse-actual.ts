import * as api from '@actual-app/api';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { Store } from '../src/store.js';
import { hash } from '../src/domain.js';
import { planConversion, protectedHash, snapshotSchema } from './conversion.js';
import { applyConversion } from './apply-conversion.js';
import { snapshot, quietSdk } from './actual-snapshot.js';
quietSdk();
const root = '/private/rehearsal';
mkdirSync(root, { recursive: true, mode: 0o700 });
console.error = (...args: unknown[]) =>
  appendFileSync(
    root + '/sdk-errors.jsonl',
    JSON.stringify(
      args.map((v) =>
        v instanceof Error
          ? { name: v.name, message: v.message, stack: v.stack }
          : v,
      ),
    ) + '\n',
    { mode: 0o600 },
  );
let phase = 'init';
try {
  mkdirSync(root + '/actual', { recursive: true, mode: 0o700 });
  const client = await api.init({ dataDir: root + '/actual' });
  phase = 'restore';
  const budget = await api.importBudget(
    new Uint8Array(readFileSync('/private/current/actual.zip')),
    { type: 'actual' },
  );
  phase = 'snapshot';
  const source = await snapshot(false);
  const exported = snapshotSchema.parse(
    JSON.parse(readFileSync('/private/current/snapshot.json', 'utf8')),
  );
  if (protectedHash(source) !== protectedHash(exported))
    throw new Error('restore-preservation-failed');
  const plan = planConversion(
    source,
    'https://cloud.example.test/remote.php/dav/files/finance',
  );
  writeFileSync(root + '/plan.json', JSON.stringify(plan), { mode: 0o600 });
  const store = new Store(root + '/conversion.sqlite');
  let writes = 0;
  const target = {
    snapshot: () => snapshot(false),
    note: async (id: string, note: string) => {
      writes++;
      await api.updateNote(id, note);
    },
    transactionNote: async (id: string, notes: string) => {
      writes++;
      await (client.send as (name: string, args: unknown) => Promise<unknown>)(
        'transactions-batch-update',
        {
          added: [],
          updated: [{ id, notes }],
          deleted: [],
          learnCategories: false,
          runTransfers: false,
        },
      );
    },
    detail: async (url: string, body: string) => {
      writeFileSync(root + '/' + hash(url) + '.txt', body, { mode: 0o600 });
    },
  };
  phase = 'conversion';
  await applyConversion(source, plan, store, target);
  const firstWrites = writes;
  phase = 'replay';
  await applyConversion(source, plan, store, target);
  if (writes !== firstWrites) throw new Error('replay-wrote-data');
  phase = 'reconnect';
  await api.shutdown();
  await api.init({ dataDir: root + '/actual' });
  await api.loadBudget(budget.id);
  const after = await snapshot(false);
  if (protectedHash(after) !== protectedHash(source))
    throw new Error('reconnect-preservation-failed');
  const count = after.notes.filter(
    (n) => n.id.startsWith('household-purchase:v2:') && n.note,
  ).length;
  if (count !== plan.counts.receipts)
    throw new Error('reconnect-purchase-count');
  writeFileSync(root + '/converted.zip', await api.exportBudget(), {
    mode: 0o600,
  });
  store.close();
  process.stdout.write(
    JSON.stringify({
      restored: true,
      conversion: true,
      replayWrites: writes - firstWrites,
      reconnected: true,
      purchases: count,
      operations: firstWrites,
      historicalReview: plan.counts.historicalRevisions,
    }) + '\n',
  );
} catch (error) {
  writeFileSync(
    root + '/error.json',
    JSON.stringify({
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
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
          : 'rehearsal-failed',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await api.shutdown();
}
