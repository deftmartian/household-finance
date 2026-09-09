import { afterEach, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Interpreter } from '../src/model.js';
import {
  factsSchema,
  itemAllocations,
  key,
  withPurchaseNote,
} from '../src/domain.js';
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

it('preserves differing evidence for the same order without replacing prior facts', async () => {
  const f = setup();
  const old = purchase();
  old.reference = 'ORDER-123';
  old.id = 'existing-stable-purchase-id';
  f.ledger.seed(old);
  await f.engine.refresh();
  const facts = factsSchema.strip().parse(old);
  facts.items[0]!.description = 'Different printed item';
  f.engine.options.prepare = async () => ({
    type: 'facts',
    facts: [facts],
    mediaType: 'text/csv',
  });
  f.talk.archive.mockResolvedValue({
    ...old.sources[0]!,
    hash: 'b'.repeat(64),
    messageId: '2',
  });
  const incoming = message('Updated receipt');
  incoming.attachments = [
    { fileId: '123', etag: 'abc', size: 4, mediaType: 'text/csv' },
  ];
  f.store.intake(incoming, 'attachment', incoming);
  await f.engine.run(f.store.next()!);
  const saved = (await f.ledger.purchases())[0]!;
  expect(saved.items).toEqual(old.items);
  expect(saved.sources).toHaveLength(2);
  expect(saved.state).toBe('attention');
  expect(saved.evidence?.alternateRecords).toHaveLength(1);
  expect(f.ledger.writes).toBe(0);
});
it('uses bank cents for a single model-selected category', async () => {
  const f = setup([
    {
      allocations: [{ category: 'food', amount: 1575 }],
      needsClarification: false,
      question: '',
    },
  ]);
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.ledger.rows[0]!.category).toBe('food');
  expect(f.ledger.rows[0]!.amount).toBe(-1575);
});
it('asks for split evidence instead of inventing a bank-only split', async () => {
  const f = setup([
    {
      allocations: [
        { category: 'food', amount: -1000 },
        { category: 'school', amount: -575 },
      ],
      needsClarification: false,
      question: '',
    },
  ]);
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.ledger.writes).toBe(0);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM replies').get()).toEqual(
    { n: 1 },
  );
});

it('lets the model correct malformed transaction search arguments without losing the question', async () => {
  const f = setup([
    { action: 'read_transactions', arguments: '{"query":123}', reply: '' },
    {
      action: 'read_transactions',
      arguments: '{"query":"","start":"2026-09-01","end":"2026-09-07"}',
      reply: '',
    },
    { action: 'answer', arguments: '{}', reply: 'Search completed.' },
  ]);
  const request = message('Show recent transactions.');
  f.store.intake(request, 'question', request);
  for (let i = 0; i < 3; i++) await f.engine.run(f.store.next()!);
  const cp = JSON.parse(
    (
      f.store.db.prepare('SELECT checkpoint FROM jobs WHERE id=?').get('2') as {
        checkpoint: string;
      }
    ).checkpoint,
  );
  expect(cp.history[0].result.error).toBe('invalid-tool-arguments');
  expect(
    cp.history[0].result.issues.map((v: { path: string[] }) => v.path[0]),
  ).toEqual(['query']);
  expect(cp.done).toBe(true);
});

it('asks for clarification when a purchase category proposal is outside the category contract', async () => {
  const f = setup([
    {
      allocations: [{ category: 'missing-category', amount: -1575 }],
      needsClarification: false,
      question: '',
    },
  ]);
  f.ledger.seed(purchase());
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.ledger.writes).toBe(0);
  expect(
    f.store.db
      .prepare("SELECT count(*) AS n FROM jobs WHERE state='attention'")
      .get(),
  ).toEqual({ n: 0 });
  expect(f.store.db.prepare('SELECT count(*) AS n FROM replies').get()).toEqual(
    { n: 1 },
  );
});

it('allows bounded transaction results across more than one year of history', async () => {
  const f = setup([
    {
      action: 'read_transactions',
      arguments: '{"query":"","start":"2020-01-01","end":"2026-09-07"}',
      reply: '',
    },
    { action: 'answer', arguments: '{}', reply: 'History checked.' },
  ]);
  const request = message('Check my transaction history.');
  f.store.intake(request, 'question', request);
  await f.engine.run(f.store.next()!);
  await f.engine.run(f.store.next()!);
  expect(
    f.store.db.prepare("SELECT state FROM jobs WHERE id='2'").get(),
  ).toEqual({ state: 'done' });
});

it('delivers a final evidence-based answer when the tool budget is exhausted', async () => {
  const f = setup([
    {
      action: 'answer',
      arguments: '{}',
      reply:
        'I checked the available evidence; one detail still needs clarification.',
    },
  ]);
  const request = message('Check the pending work.');
  f.store.intake(request, 'question', request);
  f.store.checkpoint(request.id, {
    turn: 8,
    history: [{ action: 'read_work', result: [] }],
    contextRevision: f.store.revision(),
  });
  await f.engine.run(f.store.next()!);
  expect(
    f.store.db.prepare("SELECT state FROM jobs WHERE id='2'").get(),
  ).toEqual({ state: 'done' });
  expect(f.store.db.prepare('SELECT count(*) AS n FROM replies').get()).toEqual(
    { n: 1 },
  );
  expect(f.model.structured).toHaveBeenCalledTimes(1);
});

it('searches uncategorized records by merchant separately from categorization state', async () => {
  const args = JSON.stringify({ query: 'Example', uncategorized: true });
  const f = setup([
    { action: 'read_transactions', arguments: args, reply: '' },
  ]);
  f.ledger.rows = [
    transaction(),
    { ...transaction(), id: 'categorized', category: 'food' },
    { ...transaction(), id: 'transfer', transfer: true },
  ];
  const request = message('Find uncategorized Example transactions.');
  f.store.intake(request, 'question', request);
  await f.engine.run(f.store.next()!);
  const cp = JSON.parse(
    (
      f.store.db.prepare("SELECT checkpoint FROM jobs WHERE id='2'").get() as {
        checkpoint: string;
      }
    ).checkpoint,
  );
  expect(cp.history[0].arguments).toBe(args);
  expect(cp.history[0].result).toMatchObject({
    searchAvailable: true,
    availableCount: 3,
    uncategorizedCount: 1,
    total: 1,
    returned: 1,
    hasMore: false,
  });
  expect(cp.history[0].result.transactions[0].id).toBe('transaction-one');
});

it('reports receipt availability and matches independent item and merchant words', async () => {
  const f = setup([
    {
      action: 'read_purchases',
      arguments: '{"query":"Notebook Example"}',
      reply: '',
    },
  ]);
  f.ledger.seed(purchase());
  const request = message('Find that notebook receipt.');
  f.store.intake(request, 'question', request);
  await f.engine.run(f.store.next()!);
  const cp = JSON.parse(
    (
      f.store.db.prepare("SELECT checkpoint FROM jobs WHERE id='2'").get() as {
        checkpoint: string;
      }
    ).checkpoint,
  );
  expect(cp.history[0].result).toMatchObject({
    searchAvailable: true,
    availableCount: 1,
    total: 1,
    hasMore: false,
  });
});

it('does not rescan unchanged pending purchases or block unrelated bank categorization', async () => {
  const f = setup();
  const p = purchase();
  p.total = 9999;
  f.ledger.seed(p);
  f.ledger.ruleCategory = async () => 'food';
  await f.engine.discover();
  let job;
  while ((job = f.store.next())) await f.engine.run(job);
  expect(f.ledger.rows[0]!.category).toBe('food');
  await f.engine.discover();
  while ((job = f.store.next())) await f.engine.run(job);
  await f.engine.discover();
  expect(f.store.next()).toBeUndefined();
  expect(f.model.structured).not.toHaveBeenCalled();
});

it('records cash purchases without waiting for an impossible bank match', async () => {
  const f = setup();
  const p = purchase();
  p.payment = 'cash';
  f.ledger.seed(p);
  f.ledger.rows = [];
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect((await f.ledger.purchases())[0]!.state).toBe('recorded');
  expect(f.model.structured).not.toHaveBeenCalled();
});

it('links a receipt while preserving existing split categories and handwritten child notes', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  f.ledger.rows[0]!.children = [
    { id: 'child-a', amount: -1000, category: 'food', notes: 'Keep this memo' },
    { id: 'child-b', amount: -575, category: 'school', notes: '' },
  ];
  const before = structuredClone(f.ledger.rows[0]!.children);
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.ledger.rows[0]!.children).toEqual(before);
  expect(f.ledger.rows[0]!.notes).toContain('Milk');
  expect((await f.ledger.purchases())[0]!.state).toBe('linked');
  expect(f.model.structured).not.toHaveBeenCalled();
});

it('updates linked transaction notes when an additional receipt source arrives', async () => {
  const f = setup();
  const p = purchase();
  p.state = 'linked';
  p.reference = 'ORDER-LINKED';
  p.allocations = [{ category: 'food', amount: -1575 }];
  p.transactions = [{ id: transaction().id, account: 'card', amount: -1575 }];
  f.ledger.seed(p);
  f.ledger.rows[0]!.category = 'food';
  f.ledger.rows[0]!.notes = withPurchaseNote(transaction().notes, p);
  f.engine.options.prepare = async () => ({
    type: 'facts',
    facts: [factsSchema.strip().parse(p)],
    mediaType: 'text/csv',
  });
  f.talk.archive.mockResolvedValue({
    ...p.sources[0]!,
    hash: 'b'.repeat(64),
    url: 'https://cloud.example.test/additional.csv',
    messageId: '2',
  });
  const incoming = message('');
  incoming.attachments = [
    { fileId: '123', etag: 'abc', size: 4, mediaType: 'text/csv' },
  ];
  f.store.intake(incoming, 'attachment', incoming);
  await f.engine.run(f.store.next()!);
  expect(f.ledger.rows[0]!.category).toBe('food');
  expect(f.ledger.rows[0]!.notes).toContain('additional.csv');
  expect(f.ledger.rows[0]!.notes).toContain('My handwritten memo');
});

it('resolves new evidence to the survivor of a consolidated duplicate', async () => {
  const f = setup();
  const p = purchase();
  p.reference = 'ORDER-MERGED';
  f.ledger.seed(p);
  f.ledger.seed({
    ...p,
    id: 'retired-copy',
    state: 'discarded',
    evidence: { mergedInto: p.id },
  });
  f.engine.options.prepare = async () => ({
    type: 'facts',
    facts: [factsSchema.strip().parse(p)],
    mediaType: 'text/csv',
  });
  f.talk.archive.mockResolvedValue({
    ...p.sources[0]!,
    hash: 'b'.repeat(64),
    messageId: '2',
  });
  const incoming = message('');
  incoming.attachments = [
    { fileId: '123', etag: 'abc', size: 4, mediaType: 'text/csv' },
  ];
  f.store.intake(incoming, 'attachment', incoming);
  await f.engine.run(f.store.next()!);
  expect(
    (await f.ledger.purchases()).find((x) => x.id === p.id)!.sources,
  ).toHaveLength(2);
  expect(
    f.store.db
      .prepare("SELECT count(*) as n FROM jobs WHERE state='attention'")
      .get(),
  ).toEqual({ n: 0 });
});
