import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import type { Interpreter } from '../src/model.js';
import type { Message } from '../src/talk.js';
import { dueWeek, summaryText } from '../src/weekly.js';
import { FakeLedger, purchase, transaction } from './fixtures.js';

const SATURDAY = Date.parse('2026-09-05T12:00:00Z'); // 09:00 in Halifax
const stores: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SATURDAY + 60000);
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) s.close();
});
function setup() {
  const store = new Store(':memory:');
  stores.push(store);
  const ledger = new FakeLedger();
  ledger.rows = [{ ...transaction(), category: 'food' }];
  ledger.budgetRows = [
    {
      id: 'food',
      name: 'Food',
      income: false,
      budgeted: 50000,
      spent: -61000,
      balance: -11000,
    },
    {
      id: 'pay',
      name: 'Pay',
      income: true,
      budgeted: 0,
      spent: 0,
      balance: 0,
    },
  ];
  const model = {
    structured: vi.fn(async <T>(schema: z.ZodType<T>) => schema.parse({})),
  };
  const talk = {
    download: vi.fn(async () => Buffer.alloc(0)),
    archive: vi.fn(async () => purchase().sources[0]!),
    details: vi.fn(async () => ''),
    reply: vi.fn(async () => '99'),
  };
  const engine = new Engine(store, ledger, model as Interpreter, talk, {
    speakers: new Set(['andrew']),
    writeAccounts: new Set(['card']),
    currency: 'CAD',
  });
  return { store, ledger, model, talk, engine };
}
const replies = (store: Store) =>
  store.db.prepare('SELECT body FROM replies ORDER BY rowid').all() as {
    body: string;
  }[];
const weeklyJob = (store: Store) =>
  store.db.prepare("SELECT * FROM jobs WHERE kind='weekly'").get() as {
    state: string;
    due: number;
  };
const reply = (parent: string): Message => ({
  id: '5',
  speaker: 'andrew',
  message: 'done',
  parent,
  at: '2026-09-05T13:00:00Z',
  attachments: [],
});

it('runs from Saturday 09:00 local and never far behind', () => {
  const tz = 'America/Halifax';
  expect(dueWeek(SATURDAY - 1, tz)).toBeNull();
  expect(dueWeek(SATURDAY, tz)).toEqual({
    saturday: '2026-09-05',
    at: SATURDAY,
  });
  expect(dueWeek(SATURDAY + 2 * 86400000, tz)?.saturday).toBe('2026-09-05');
  expect(dueWeek(SATURDAY + 5 * 86400000, tz)).toBeNull();
});

it('summarizes the week without a model call when every bank is current', async () => {
  const f = setup();
  f.ledger.health = [
    { account: 'card', name: 'Card', bank: 'Bank', ok: true, lastSync: null },
  ];
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(f.ledger.bankSyncs).toBe(1);
  expect(weeklyJob(f.store).state).toBe('done');
  const [summary] = replies(f.store);
  expect(summary!.body).toContain('Weekly summary for Aug 29–Sep 4');
  expect(summary!.body).toContain('Spent $15.75 this week. Top: Food $15.75.');
  expect(summary!.body).toContain('Over budget: Food by $110.00.');
  expect(summary!.body).not.toContain('login');
  expect(f.model.structured).not.toHaveBeenCalled();
  await f.engine.discover();
  expect(f.store.next()).toBeUndefined();
});

it('nudges once for stale logins and summarizes after a reply', async () => {
  const f = setup();
  f.ledger.health = [
    {
      account: 'card',
      name: 'Card',
      bank: 'Tangerine',
      ok: false,
      lastSync: null,
    },
    {
      account: 'other',
      name: 'Other',
      bank: 'Tangerine',
      ok: false,
      lastSync: null,
    },
  ];
  await f.engine.discover();
  await f.engine.run(f.store.next()!);
  expect(replies(f.store).map((r) => r.body)).toEqual([
    expect.stringContaining('- Tangerine'),
  ]);
  expect(weeklyJob(f.store).due).toBe(Date.now() + 4 * 3600000);
  expect(f.store.next()).toBeUndefined();
  await f.engine.flushReplies();

  vi.setSystemTime(Date.now() + 4 * 3600000);
  await f.engine.run(f.store.next()!);
  expect(replies(f.store)).toHaveLength(1);

  f.store.intake(reply('99'), 'question', reply('99'));
  await f.engine.run(f.store.next()!);
  expect(f.model.structured).not.toHaveBeenCalled();
  await f.engine.run(f.store.next()!);
  expect(weeklyJob(f.store).state).toBe('done');
  const bodies = replies(f.store).map((r) => r.body);
  expect(bodies[1]).toContain('check the banks now');
  expect(bodies[2]).toContain('Tangerine still need a login');
});

it('sends the summary with older data after the Tuesday deadline', async () => {
  const f = setup();
  f.ledger.health = [
    { account: 'card', name: 'Card', bank: 'CIBC', ok: false, lastSync: null },
  ];
  await f.engine.discover();
  vi.setSystemTime(SATURDAY + 3 * 86400000);
  await f.engine.run(f.store.next()!);
  expect(weeklyJob(f.store).state).toBe('done');
  const bodies = replies(f.store).map((r) => r.body);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain('CIBC still need a login');
});

it('numbers the transactions that still need a category', () => {
  const rows = [
    { ...transaction(), id: 'a', date: '2026-09-03', merchant: 'Corner Store' },
    { ...transaction(), id: 'b', date: '2026-09-04', merchant: 'Hardware' },
  ];
  const text = summaryText({
    start: '2026-08-29',
    end: '2026-09-04',
    currency: 'CAD',
    accounts: new Set(['card']),
    transactions: rows,
    categories: [],
    budget: [],
    purchases: [purchase()],
    stale: [],
  });
  expect(text).toContain(
    'Receipts: 1 waiting for a bank charge, 0 need a look.',
  );
  expect(text).toContain('2 transactions still need a category');
  expect(text).toContain('1. Sep 4 Hardware $15.75');
  expect(text).toContain('2. Sep 3 Corner Store $15.75');
});
