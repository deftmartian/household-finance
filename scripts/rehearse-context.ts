// Offline preservation proof. Inputs and database must remain outside Git.
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { convertContext } from './convert-context.js';
import type { Purchase } from '../src/domain.js';
const root = process.argv[2];
const output = process.argv[3];
if (!root || !output)
  throw new Error('provide-private-input-directory-and-output-database');
const read = (name: string) =>
  JSON.parse(readFileSync(`${root}/${name}`, 'utf8'));
const profile = read('profile.json');
const taxonomy = read('taxonomy.json');
const config = read('finance-config.json');
const plan = read('rehearsal/plan.json') as { purchases: Purchase[] };
const store = new Store(output);
try {
  const imported = convertContext(
    profile,
    `${root}/stores`,
    store,
    config.talk.users,
    plan.purchases,
    '1',
    taxonomy,
  );
  const replay = convertContext(
    profile,
    `${root}/stores`,
    store,
    config.talk.users,
    plan.purchases,
    '1',
    taxonomy,
  );
  const integrity = store.db.pragma('quick_check', { simple: true }) === 'ok';
  if (!integrity) throw new Error('context-integrity-failed');
  process.stdout.write(JSON.stringify({ imported, replay, integrity }) + '\n');
} finally {
  store.close();
}
