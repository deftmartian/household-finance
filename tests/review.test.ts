import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import {
  apply,
  items,
  match,
  pending,
  receipt,
  status,
} from '../src/review.js';
import type { Session } from '../src/review.js';
import { PURCHASE_PREFIX, parsePurchase } from '../src/domain.js';
import type { Purchase } from '../src/domain.js';
import { FakeLedger, purchase, transaction } from './fixtures.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
function setup() {
  const store = new Store(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  cleanup.push(
    () => store.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const ledger = new FakeLedger();
  const original = vi.fn(async () => Buffer.from('synthetic receipt'));
  const s: Session = {
    store,
    ledger,
    writeAccounts: new Set(['card']),
    currency: 'CAD',
    itemsPath: join(dir, 'item-map.json'),
    original,
    details: async () => 'https://cloud.example.test/details.txt',
    now: () => new Date('2026-09-10T12:00:00Z'),
  };
  return { s, ledger, store, dir, original };
}
const captured = (patch: Partial<Purchase> = {}): Purchase =>
  parsePurchase({
    ...purchase(),
    merchant: null,
    date: null,
    currency: null,
    total: null,
    subtotal: null,
    tax: null,
    payment: 'unknown',
    items: [],
    provenance: { method: 'capture', model: null, at: '2026-09-04T12:00:00Z' },
    ...patch,
  });
const facts = () => {
  const {
    id,
    revision,
    state,
    sources,
    annotations,
    provenance,
    transactions,
    allocations,
    schema,
    ...f
  } = purchase();
  void [
    id,
    revision,
    state,
    sources,
    annotations,
    provenance,
    transactions,
    allocations,
    schema,
  ];
  return f;
};
const saved = (l: FakeLedger, id = 'purchase-one') =>
  parsePurchase(JSON.parse(l.notes.get(PURCHASE_PREFIX + id)!));

it('reports status and pending work, including item suggestions', async () => {
  const f = setup();
  f.ledger.health = [
    {
      account: 'x',
      name: 'Example Bank',
      bank: 'Example',
      ok: true,
      lastSync: null,
    },
  ];
  f.ledger.seed(purchase());
  const st = await status(f.s);
  expect(st).toEqual({
    banks: [
      { name: 'Example Bank', bank: 'Example', ok: true, lastSync: null },
    ],
    uncategorized: 1,
    purchases: { pending: 1 },
  });
  let p = await pending(f.s);
  expect(p.uncategorized[0]).toMatchObject({
    id: 'transaction-one',
    account: 'Example Card',
    importedMerchant: '',
  });
  expect(p.purchases[0]).toMatchObject({
    hasFacts: true,
    itemCount: 2,
    ageDays: 6,
    sources: [{ index: 0, mediaType: 'image/jpeg' }],
  });
  expect(p.suggestions[0]).toMatchObject({
    unmapped: [
      { index: 0, key: 'milk' },
      { index: 1, key: 'notebook' },
    ],
  });
  await apply(
    f.s,
    {
      ops: [
        {
          op: 'item',
          merchant: 'Example Market',
          key: 'Milk',
          category: 'food',
        },
        {
          op: 'item',
          merchant: 'Example Market',
          key: 'Notebook',
          category: 'school',
        },
      ],
    },
    true,
  );
  p = await pending(f.s);
  expect(p.suggestions[0]).toEqual({
    purchase: 'purchase-one',
    allocations: [
      { category: 'food', amount: -1050 },
      { category: 'school', amount: -525 },
    ],
  });
  expect(items(f.s).entries).toHaveLength(2);
});
it('proposes matches without writing', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  expect((await match(f.s)).proposals).toMatchObject([
    {
      purchase: 'purchase-one',
      result: 'unique',
      transactions: ['transaction-one'],
    },
  ]);
  expect(f.ledger.writes + f.ledger.noteWrites).toBe(0);
});
it('dry-runs a plan without writing, simulating earlier ops', async () => {
  const f = setup();
  f.ledger.seed(captured());
  const plan = {
    ops: [
      { op: 'facts', purchase: 'purchase-one', facts: facts() },
      {
        op: 'resolve',
        purchase: 'purchase-one',
        links: [
          {
            transaction: 'transaction-one',
            allocations: [{ category: 'food', amount: -1575 }],
          },
        ],
      },
    ],
  };
  const r = await apply(f.s, plan, false);
  expect(r).toMatchObject({ ok: true, committed: false });
  expect(f.ledger.writes + f.ledger.noteWrites).toBe(0);
  expect(
    f.store.db.prepare('SELECT count(*) AS n FROM operations').get(),
  ).toEqual({ n: 0 });
});
it('commits facts then resolve, links the transaction, and is idempotent on re-run', async () => {
  const f = setup();
  f.ledger.seed(captured());
  const plan = {
    ops: [
      { op: 'facts', purchase: 'purchase-one', facts: facts() },
      {
        op: 'resolve',
        purchase: 'purchase-one',
        links: [
          {
            transaction: 'transaction-one',
            allocations: [
              { category: 'food', amount: -1000 },
              { category: 'school', amount: -575 },
            ],
          },
        ],
      },
    ],
  };
  const r = await apply(f.s, plan, true);
  expect(r.ok).toBe(true);
  const p = saved(f.ledger);
  expect(p).toMatchObject({ state: 'linked', revision: 3, total: 1575 });
  expect(p.transactions).toEqual([
    { id: 'transaction-one', account: 'card', amount: -1575 },
  ]);
  expect(p.allocations).toEqual([
    { category: 'food', amount: -1000 },
    { category: 'school', amount: -575 },
  ]);
  const t = f.ledger.rows[0]!;
  expect(t.notes).toContain('My handwritten memo');
  expect(t.notes).toContain('[purchase:purchase-one]');
  expect(t.children.map((c) => c.amount)).toEqual([-1000, -575]);
  const writes = f.ledger.writes + f.ledger.noteWrites;
  const again = await apply(f.s, plan, true);
  expect(again.results.map((x) => x.already)).toEqual([true, true]);
  expect(f.ledger.writes + f.ledger.noteWrites).toBe(writes);
});
it('stops at the first failing op and reports the code', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  const r = await apply(
    f.s,
    {
      ops: [
        {
          op: 'categorize',
          transaction: 'transaction-one',
          allocations: [{ category: 'nope', amount: -1575 }],
        },
        { op: 'discard', purchase: 'purchase-one', reason: 'duplicate' },
      ],
    },
    true,
  );
  expect(r).toMatchObject({ ok: false, error: 'invalid-allocation' });
  expect(r.results).toHaveLength(1);
  expect(saved(f.ledger).state).toBe('pending');
});
it('refuses resolves that break the evidence', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  const one = (patch: object) =>
    apply(
      f.s,
      {
        ops: [
          {
            op: 'resolve',
            purchase: 'purchase-one',
            links: [
              {
                transaction: 'transaction-one',
                allocations: [{ category: 'food', amount: -1575 }],
              },
            ],
            ...patch,
          },
        ],
      },
      true,
    );
  f.ledger.rows[0]!.notes = '[purchase:other]\nx\n[/purchase:other]';
  expect((await one({})).error).toBe('purchase-match-evidence');
  f.ledger.rows[0]!.notes = '';
  f.ledger.rows[0]!.amount = -1500;
  expect(
    (
      await one({
        links: [
          {
            transaction: 'transaction-one',
            allocations: [{ category: 'food', amount: -1500 }],
          },
        ],
      })
    ).error,
  ).toBe('purchase-match-evidence');
  f.ledger.rows[0]!.amount = -1575;
  f.ledger.rows[0]!.account = 'other';
  expect((await one({})).error).toBe('transaction-not-eligible');
  f.ledger.rows[0]!.account = 'card';
  expect(
    (
      await one({
        links: [
          {
            transaction: 'transaction-one',
            allocations: [{ category: 'food', amount: -1 }],
          },
        ],
      })
    ).error,
  ).toBe('invalid-allocation');
  expect(f.ledger.writes + f.ledger.noteWrites).toBe(0);
});
it('links several charges to one purchase', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  f.ledger.rows = [
    { ...transaction(), id: 't1', amount: -1000 },
    { ...transaction(), id: 't2', amount: -575 },
  ];
  const r = await apply(
    f.s,
    {
      ops: [
        {
          op: 'resolve',
          purchase: 'purchase-one',
          links: [
            {
              transaction: 't1',
              allocations: [{ category: 'food', amount: -1000 }],
            },
            {
              transaction: 't2',
              allocations: [{ category: 'school', amount: -575 }],
            },
          ],
        },
      ],
    },
    true,
  );
  expect(r.ok).toBe(true);
  expect(f.ledger.rows.map((t) => t.category)).toEqual(['food', 'school']);
  expect(
    f.ledger.rows.every((t) => t.notes.includes('multiple bank charges')),
  ).toBe(true);
});
it('refuses facts on a purchase that did not come from capture', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  const r = await apply(
    f.s,
    { ops: [{ op: 'facts', purchase: 'purchase-one', facts: facts() }] },
    true,
  );
  expect(r.error).toBe('purchase-not-capture-only');
});
it('categorizes a single category or a split, only when uncategorized', async () => {
  const f = setup();
  const split = [
    { category: 'food', amount: -1000 },
    { category: 'school', amount: -575 },
  ];
  expect(
    (
      await apply(
        f.s,
        {
          ops: [
            {
              op: 'categorize',
              transaction: 'transaction-one',
              allocations: split,
            },
          ],
        },
        true,
      )
    ).ok,
  ).toBe(true);
  expect(f.ledger.rows[0]!.children).toHaveLength(2);
  expect(f.ledger.rows[0]!.notes).toBe('My handwritten memo');
  const other = await apply(
    f.s,
    {
      ops: [
        {
          op: 'categorize',
          transaction: 'transaction-one',
          allocations: [{ category: 'food', amount: -1575 }],
        },
      ],
    },
    true,
  );
  expect(other.error).toBe('transaction-not-uncategorized');
});
it('discards a pending purchase with an annotation', async () => {
  const f = setup();
  f.ledger.seed(purchase());
  const plan = {
    ops: [
      {
        op: 'discard',
        purchase: 'purchase-one',
        reason: 'Duplicate of another receipt',
      },
    ],
  };
  expect((await apply(f.s, plan, true)).ok).toBe(true);
  const p = saved(f.ledger);
  expect(p.state).toBe('discarded');
  expect(p.annotations.at(-1)).toMatchObject({
    speaker: 'session',
    text: 'Duplicate of another receipt',
  });
  expect((await apply(f.s, plan, true)).results[0]!.already).toBe(true);
});
it('creates a rule once, optionally recategorizing exact importedMerchant matches', async () => {
  const f = setup();
  f.ledger.rows = [
    { ...transaction(), id: 'a', importedMerchant: 'EXAMPLE MARKET' },
    { ...transaction(), id: 'b', importedMerchant: 'EXAMPLE MARKET 2' },
  ];
  const op = {
    op: 'rule',
    importedMerchant: 'EXAMPLE MARKET',
    category: 'food',
  };
  expect(
    (await apply(f.s, { ops: [{ ...op, applyExisting: true }] }, false))
      .results[0],
  ).toMatchObject({ applyExisting: 1 });
  expect(f.ledger.ruleRows).toHaveLength(0);
  expect((await apply(f.s, { ops: [op] }, true)).ok).toBe(true);
  expect(f.ledger.ruleRows).toHaveLength(1);
  expect(f.ledger.rows.map((t) => t.category)).toEqual([null, null]);
  expect(
    (await apply(f.s, { ops: [{ ...op, applyExisting: true }] }, true)).error,
  ).toBe('rule-exists');
  f.ledger.ruleRows = [];
  expect(
    (await apply(f.s, { ops: [{ ...op, applyExisting: true }] }, true)).ok,
  ).toBe(true);
  expect(f.ledger.rows.map((t) => t.category)).toEqual(['food', null]);
});
it('rejects malformed plans', async () => {
  const f = setup();
  await expect(apply(f.s, { ops: [{ op: 'nope' }] }, false)).rejects.toThrow();
  await expect(apply(f.s, { ops: [], extra: 1 }, false)).rejects.toThrow();
});
it('fetches a receipt only when its hash matches, with private permissions', async () => {
  const f = setup();
  const bytes = Buffer.from('synthetic receipt');
  const p = purchase();
  p.sources[0]!.hash = createHash('sha256').update(bytes).digest('hex');
  f.ledger.seed(p);
  const out = join(f.dir, 'r.jpg');
  expect((await receipt(f.s, 'purchase-one', 0, out)).meta).toEqual({
    path: out,
    mediaType: 'image/jpeg',
    bytes: bytes.length,
  });
  const streamed = await receipt(f.s, 'purchase-one', 0);
  expect(streamed.meta.path).toBe('-');
  expect(streamed.data).toEqual(bytes);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect(readFileSync(out)).toEqual(bytes);
  f.original.mockResolvedValue(Buffer.from('tampered'));
  await expect(
    receipt(f.s, 'purchase-one', 0, join(f.dir, 'x')),
  ).rejects.toThrow('receipt-hash-mismatch');
  await expect(receipt(f.s, 'purchase-one', 3, out)).rejects.toThrow(
    'source-missing',
  );
});
