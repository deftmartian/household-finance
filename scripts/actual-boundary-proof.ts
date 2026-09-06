import * as api from '@actual-app/api';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { ActualLedger, Writer } from '../src/actual.js';
import { parsePurchase, PURCHASE_PREFIX, canonical } from '../src/domain.js';
import { quietSdk } from './actual-snapshot.js';
quietSdk();
const root = process.env.PROOF_DIR!;
mkdirSync(root + '/actual', { recursive: true, mode: 0o700 });
const url = 'http://127.0.0.1:15066',
  password = 'synthetic-local-rehearsal';
let phase = 'bootstrap';
try {
  const needs = (await fetch(url + '/account/needs-bootstrap').then((r) =>
    r.json(),
  )) as { data: { bootstrapped: boolean } };
  if (!needs.data.bootstrapped) {
    const r = await fetch(url + '/account/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) throw new Error('bootstrap-failed');
  }
  phase = 'create';
  const client = await api.init({
    dataDir: root + '/actual',
    serverURL: url,
    password,
  });
  let account = '',
    food = '',
    school = '';
  await api.runImport('Replacement proof', async () => {
    account = await api.createAccount({
      name: 'Proof card',
      offbudget: false,
      closed: false,
    });
    const group = await api.createCategoryGroup({
      name: 'Everyday',
      is_income: false,
    });
    food = await api.createCategory({
      name: 'Food',
      group_id: group,
      is_income: false,
    });
    school = await api.createCategory({
      name: 'School',
      group_id: group,
      is_income: false,
    });
    const payee = await api.createPayee({ name: 'Example Market' });
    await api.addTransactions(
      account,
      [
        {
          date: '2026-09-06',
          amount: -1575,
          payee,
          notes: 'Handwritten memo stays.',
          imported_id: 'synthetic-import',
        },
      ],
      { learnCategories: false, runTransfers: false },
    );
  });
  await api.sync();
  const ledger = new ActualLedger(new Set([account]), client),
    store = new Store(root + '/writer.sqlite'),
    writer = new Writer(store, ledger);
  const t = (await ledger.transactions())[0]!;
  const p = parsePurchase({
    schema: 'purchase.v2',
    id: 'synthetic-purchase',
    revision: 1,
    state: 'linked',
    merchant: 'Example Market',
    date: '2026-09-06',
    currency: 'CAD',
    total: 1575,
    subtotal: 1500,
    tax: 75,
    tip: null,
    shipping: null,
    discount: null,
    reference: null,
    payment: 'card',
    items: [
      { description: 'Milk', quantity: 2, unitPrice: 500, amount: 1000 },
      { description: 'Notebook', quantity: 1, unitPrice: 500, amount: 500 },
    ],
    sources: [
      {
        hash: 'a'.repeat(64),
        url: 'https://cloud.example.test/receipt.jpg',
        mediaType: 'image/jpeg',
        messageId: '1',
      },
    ],
    annotations: [],
    provenance: {
      method: 'synthetic',
      model: null,
      at: new Date().toISOString(),
    },
    transactions: [{ id: t.id, account, amount: t.amount }],
    allocations: [
      { category: food, amount: -1050 },
      { category: school, amount: -525 },
    ],
  });
  phase = 'publish';
  await writer.publish('publish', null, p);
  phase = 'split';
  await writer.apply('split', t, writer.desired(t, p.allocations, p));
  const split = (await ledger.transactions())[0]!;
  if (
    split.children.length !== 2 ||
    !split.notes.startsWith('Handwritten memo stays.')
  )
    throw new Error('split-proof-failed');
  phase = 'long-note';
  const longNote =
    split.notes + '\n' + 'Readable purchase detail. '.repeat(1000);
  await writer.apply('long-note', split, { ...split, notes: longNote });
  const budget =
    (await api.getBudgets()).find((b) => !b.cloudFileId && b.id) ??
    (await api.getBudgets())[0]!;
  writeFileSync(
    root + '/identity.json',
    JSON.stringify({ account, budget, expectedNote: longNote, purchase: p }),
    { mode: 0o600 },
  );
  phase = 'reconnect';
  await api.shutdown();
  const client2 = await api.init({
    dataDir: root + '/actual',
    serverURL: url,
    password,
  });
  if (!budget.id) throw new Error('budget-identity-missing');
  await api.loadBudget(budget.id);
  await api.sync();
  const fresh = new ActualLedger(new Set([account]), client2),
    row = (await fresh.transactions())[0]!;
  if (
    row.notes !== longNote ||
    row.children.length !== 2 ||
    (await fresh.note(PURCHASE_PREFIX + p.id)) !== canonical(p)
  )
    throw new Error('reconnect-proof-failed');
  process.stdout.write(
    JSON.stringify({
      purchase: true,
      split: true,
      noteCharacters: longNote.length,
      reconnect: true,
      amountPreserved: row.amount === t.amount,
    }) + '\n',
  );
  store.close();
} catch (error) {
  writeFileSync(
    root + '/error.json',
    JSON.stringify({
      phase,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      phase,
      error:
        error instanceof Error && /^[a-z-]+$/.test(error.message)
          ? error.message
          : 'actual-proof-failed',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await api.shutdown();
}
