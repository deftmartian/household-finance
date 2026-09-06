import { afterEach, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Interpreter } from '../src/model.js';
import { itemAllocations, key, withPurchaseNote } from '../src/domain.js';
import { FakeLedger, purchase, transaction } from './fixtures.js';
import type { Message } from '../src/talk.js';
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function setup(responses: unknown[] = []) {
  const store = new Store(':memory:');
  stores.push(store);
  const ledger = new FakeLedger();
  const model = {
    structured: vi.fn(async <T>(schema: z.ZodType<T>) =>
      schema.parse(responses.shift()),
    ),
  };
  const talk = {
    download: vi.fn(async () => Buffer.from([255, 216, 255, 0])),
    archive: vi.fn(async () => purchase().sources[0]!),
    details: vi.fn(async () => 'https://cloud.example.test/details.txt'),
    reply: vi.fn(async () => '99'),
  };
  const engine = new Engine(store, ledger, model as Interpreter, talk, {
    speakers: new Set(['andrew']),
    writeAccounts: new Set(['card']),
    currency: 'CAD',
    prepare: async () => ({
      type: 'images',
      mediaType: 'image/jpeg',
      images: ['synthetic'],
    }),
  });
  return { store, ledger, model, talk, engine };
}
const message = (text: string, id = '2'): Message => ({
  id,
  speaker: 'andrew',
  message: text,
  parent: null,
  at: '2026-09-06T12:00:00Z',
  attachments: [],
});
it('waits with zero model calls then applies a later import exactly once', async () => {
  const f = setup([
    {
      allocations: [{ category: 'food', amount: -1575 }],
      needsClarification: false,
      question: '',
    },
  ]);
  f.ledger.rows = [];
  f.ledger.seed(purchase());
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.model.structured).not.toHaveBeenCalled();
  f.ledger.rows = [transaction()];
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.ledger.writes).toBe(1);
  expect(f.ledger.rows[0]!.notes).toContain('Milk × 2');
  await f.engine.discover();
  expect(f.store.next()).toBeUndefined();
  expect(f.model.structured).toHaveBeenCalledTimes(1);
});
it('uses an established category rule without a model call', async () => {
  const f = setup();
  f.ledger.ruleCategory = async () => 'food';
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.model.structured).not.toHaveBeenCalled();
  expect(f.ledger.rows[0]!.category).toBe('food');
});
it('computes split cents from item evidence and rejects missing prices', () => {
  const p = purchase(),
    labels = [
      { index: 0, category: 'food' },
      { index: 1, category: 'school' },
    ];
  expect(itemAllocations(p, labels, new Set(['food', 'school']))).toEqual([
    { category: 'food', amount: -1050 },
    { category: 'school', amount: -525 },
  ]);
  p.items[0]!.amount = null;
  expect(() => itemAllocations(p, labels, new Set(['food', 'school']))).toThrow(
    'evidence',
  );
});
it('updates purchase purpose in Actual and its readable transaction note', async () => {
  const f = setup([
    {
      action: 'annotate_purchase',
      arguments: JSON.stringify({
        id: 'purchase-one',
        text: 'The notebook is for school.',
        quote: 'The notebook is for school.',
      }),
      reply: '',
    },
    { action: 'answer', arguments: '{}', reply: 'Saved the school purpose.' },
  ]);
  const p = {
    ...purchase(),
    state: 'linked' as const,
    transactions: [{ id: 'transaction-one', account: 'card', amount: -1575 }],
  };
  f.ledger.seed(p);
  f.ledger.rows[0]!.notes = withPurchaseNote('Keep this handwritten memo.', p);
  const m = message('The notebook is for school.');
  f.store.intake(m, 'question', m);
  await f.engine.run(f.store.next()!);
  await f.engine.run(f.store.next()!);
  expect(f.ledger.rows[0]!.notes).toContain('Keep this handwritten memo.');
  expect(f.ledger.rows[0]!.notes).toContain(
    'Purpose/correction: The notebook is for school.',
  );
  expect((await f.ledger.purchases())[0]!.annotations).toHaveLength(1);
});
it('preserves both photos while making one extraction request', async () => {
  const p = purchase();
  const {
    schema,
    id,
    revision,
    state,
    sources,
    annotations,
    provenance,
    transactions,
    allocations,
    ...facts
  } = p;
  void [
    schema,
    id,
    revision,
    state,
    sources,
    annotations,
    provenance,
    transactions,
    allocations,
  ];
  const f = setup([{ purchases: [facts] }]);
  const m = message('', '10');
  m.attachments = [1, 2].map((n) => ({
    fileId: String(n),
    etag: 'etag',
    size: 4,
    mediaType: 'image/jpeg',
  }));
  f.store.intake(m, 'attachment', m);
  for (let i = 0; i < 3; i++) await f.engine.run(f.store.next()!);
  expect(f.model.structured).toHaveBeenCalledTimes(1);
  expect((await f.ledger.purchases())[0]!.sources).toHaveLength(2);
});
it('retries replies independently of successful ledger work, with backoff', async () => {
  const f = setup();
  f.store.queueReply(key('reply'), '2', 'Saved.');
  f.talk.reply.mockRejectedValueOnce(new Error('network'));
  await f.engine.flushReplies();
  await f.engine.flushReplies();
  expect(f.talk.reply).toHaveBeenCalledTimes(1);
  f.store.db.prepare('UPDATE replies SET due=0').run();
  await f.engine.flushReplies();
  expect(f.talk.reply).toHaveBeenCalledTimes(2);
  expect(f.ledger.writes).toBe(0);
});
it('resumes unfinished work only with a current request and preserves its checkpoint', async () => {
  const f = setup([
    {
      action: 'retry_work',
      arguments: JSON.stringify({ id: 'old-work', quote: 'Retry the receipt' }),
      reply: '',
    },
  ]);
  f.store.enqueue('old-work', 'attachment', message('receipt', 'old-work'));
  f.store.checkpoint('old-work', { index: 1, extracted: true });
  f.store.db
    .prepare(
      "UPDATE jobs SET state='attention',attempts=3,error='temporary-failure' WHERE id=?",
    )
    .run('old-work');
  const request = message('Retry the receipt');
  f.store.intake(request, 'question', request);
  await f.engine.run(f.store.next()!);
  const job = f.store.db
    .prepare('SELECT state,attempts,checkpoint FROM jobs WHERE id=?')
    .get('old-work');
  expect(job).toEqual({
    state: 'ready',
    attempts: 0,
    checkpoint: JSON.stringify({ extracted: true, index: 1 }),
  });
  expect(f.ledger.writes).toBe(0);
});
it('rejects a retry justified only by text absent from the current message', async () => {
  const f = setup([
    {
      action: 'retry_work',
      arguments: JSON.stringify({ id: 'old-work', quote: 'Retry the receipt' }),
      reply: '',
    },
  ]);
  f.store.enqueue('old-work', 'attachment', message('receipt', 'old-work'));
  f.store.db
    .prepare("UPDATE jobs SET state='attention' WHERE id=?")
    .run('old-work');
  const request = message('What is unfinished?');
  f.store.intake(request, 'question', request);
  await f.engine.run(f.store.next()!);
  expect(
    f.store.db.prepare('SELECT state FROM jobs WHERE id=?').get('old-work'),
  ).toEqual({ state: 'attention' });
  expect(f.ledger.writes).toBe(0);
});
