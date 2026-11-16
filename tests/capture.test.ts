import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Interpreter } from '../src/model.js';
import { factsSchema, key } from '../src/domain.js';
import { FakeLedger, purchase, transaction } from './fixtures.js';
import type { Message } from '../src/talk.js';

const stores: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-04T15:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) s.close();
});
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  const ledger = new FakeLedger();
  const model = {
    structured: vi.fn(async () => Promise.reject(new Error('x'))),
  };
  const hashes = ['1', '2', '3'].map((n) => n.repeat(64).slice(0, 64));
  let archived = 0;
  const talk = {
    download: vi.fn(async () => Buffer.from([255, 216, 255, 0])),
    archive: vi.fn(async () => ({
      ...purchase().sources[0]!,
      hash: hashes[archived++ % 3]!,
    })),
    details: vi.fn(async () => 'https://cloud.example.test/details.txt'),
    reply: vi.fn(async () => '99'),
  };
  const prepare = vi.fn(async () => {
    throw new Error('prepare must not run');
  });
  const engine = new Engine(store, ledger, model as Interpreter, talk, {
    speakers: new Set(['andrew']),
    writeAccounts: new Set(['card']),
    currency: 'CAD',
    capture: true,
    prepare,
  });
  return { store, ledger, model, talk, prepare, engine };
}
const message = (text: string, id = '2', types = ['image/jpeg']): Message => ({
  id,
  speaker: 'andrew',
  message: text,
  parent: null,
  at: '2026-09-06T12:00:00Z',
  attachments: types.map((mediaType, n) => ({
    fileId: String(n + 1),
    etag: 'etag',
    size: 4,
    mediaType,
  })),
});
const replies = (s: Store) =>
  (
    s.db.prepare('SELECT body FROM replies ORDER BY rowid').all() as {
      body: string;
    }[]
  ).map((r) => r.body);
async function drain(f: ReturnType<typeof setup>) {
  for (let job = f.store.next(); job; job = f.store.next())
    await f.engine.run(job);
}

it('archives a photo as a null-fact pending purchase without preparing or a model', async () => {
  const f = setup();
  const m = message('for the school trip');
  f.store.intake(m, 'attachment', m);
  await drain(f);
  const [p] = await f.ledger.purchases();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.model.structured).not.toHaveBeenCalled();
  expect(p).toMatchObject({
    id: key('source', p!.sources[0]!.hash),
    state: 'pending',
    merchant: null,
    date: null,
    currency: null,
    total: null,
    subtotal: null,
    tax: null,
    tip: null,
    shipping: null,
    discount: null,
    reference: null,
    payment: 'unknown',
    items: [],
    transactions: [],
    allocations: [],
    provenance: { method: 'capture', model: null, at: m.at },
  });
  expect(p!.annotations.map((a) => a.text)).toEqual(['for the school trip']);
  expect(
    f.store.db.prepare("SELECT 1 FROM jobs WHERE kind='purchase'").get(),
  ).toBeUndefined();
  expect(replies(f.store)).toEqual([
    'Saved. It will be matched at the next review.',
  ]);
});
it('stores a grouped multi-photo message as one purchase with every source', async () => {
  const f = setup();
  const m = message('', '3', ['image/jpeg', 'image/png']);
  f.store.intake(m, 'attachment', m);
  await drain(f);
  const all = await f.ledger.purchases();
  expect(all).toHaveLength(1);
  expect(all[0]!.sources).toHaveLength(2);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(replies(f.store)).toHaveLength(1);
});
it('keeps the duplicate-source check', async () => {
  const f = setup();
  const first = message('', '4');
  f.store.intake(first, 'attachment', first);
  await drain(f);
  f.talk.archive.mockResolvedValue(
    (await f.ledger.purchases())[0]!.sources[0]!,
  );
  const again = message('', '5');
  f.store.intake(again, 'attachment', again);
  await drain(f);
  expect(await f.ledger.purchases()).toHaveLength(1);
  expect(replies(f.store)).toContain(
    'I already have this receipt and its purchase details.',
  );
});
it('still extracts structured exports without a model', async () => {
  const f = setup();
  const facts = factsSchema.strip().parse(purchase());
  f.engine.options.prepare = async () => ({
    type: 'facts',
    facts: [facts],
    mediaType: 'text/csv',
  });
  f.talk.download.mockResolvedValue(Buffer.from('a,b\n1,2'));
  f.talk.archive.mockResolvedValue({
    ...purchase().sources[0]!,
    mediaType: 'text/csv',
  });
  const m = message('', '6', ['text/csv']);
  f.store.intake(m, 'attachment', m);
  await drain(f);
  expect((await f.ledger.purchases())[0]).toMatchObject({ total: 1575 });
  expect(f.model.structured).not.toHaveBeenCalled();
});
it('captures a text export that would need a model', async () => {
  const f = setup();
  f.engine.options.prepare = async () => ({
    type: 'text',
    text: 'a,b',
    mediaType: 'text/csv',
  });
  f.talk.download.mockResolvedValue(Buffer.from('a,b\n1,2'));
  f.talk.archive.mockResolvedValue({
    ...purchase().sources[0]!,
    mediaType: 'text/csv',
  });
  const m = message('', '7', ['text/csv']);
  f.store.intake(m, 'attachment', m);
  await drain(f);
  expect((await f.ledger.purchases())[0]).toMatchObject({ total: null });
});
it('discover enqueues neither categorize nor factless purchase jobs but still schedules weekly', async () => {
  vi.setSystemTime(Date.parse('2026-11-07T15:00:00Z'));
  const f = setup();
  const captured = purchase();
  captured.id = 'captured';
  captured.total = null;
  captured.date = null;
  captured.merchant = null;
  f.ledger.seed(captured);
  const known = purchase();
  known.id = 'known';
  f.ledger.seed(known);
  f.ledger.rows = [transaction()];
  await f.engine.discover();
  const kinds = f.store.db
    .prepare('SELECT kind,payload FROM jobs ORDER BY kind')
    .all() as { kind: string; payload: string }[];
  expect(kinds.map((j) => j.kind)).toEqual(['purchase', 'weekly']);
  expect(kinds[0]!.payload).toContain('known');
});
it('answers questions with a fixed reply and no model call', async () => {
  const f = setup();
  const m = message('how much did we spend?', '8', []);
  f.store.intake(m, 'question', m);
  await drain(f);
  expect(f.model.structured).not.toHaveBeenCalled();
  expect(replies(f.store)).toEqual([
    'I only collect receipts now. Send a photo or PDF; questions are handled at the next review.',
  ]);
});
it('runs the weekly job without a model', async () => {
  vi.setSystemTime(Date.parse('2026-11-07T15:00:00Z'));
  const f = setup();
  await f.engine.discover();
  await drain(f);
  expect(f.model.structured).not.toHaveBeenCalled();
  expect(
    f.store.db.prepare("SELECT state FROM jobs WHERE kind='weekly'").get(),
  ).toEqual({ state: 'done' });
  expect(replies(f.store)).toHaveLength(1);
});
