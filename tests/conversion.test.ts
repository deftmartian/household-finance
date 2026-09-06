import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { hash } from '../src/domain.js';
import { planConversion } from '../scripts/conversion.js';
import type { Snapshot } from '../scripts/conversion.js';
import { applyConversion } from '../scripts/apply-conversion.js';
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function setup(stale = false) {
  const receiptId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const old = {
    schemaVersion: 'household-finance.receipt.v1',
    receiptId,
    status: 'active',
    merchant: 'Example Market',
    purchaseDate: '2026-09-04',
    currency: 'CAD',
    amounts: { totalMinor: 100 },
    items: [{ description: 'Milk', quantity: 1, totalMinor: 100 }],
    sources: [
      {
        sha256: 'a'.repeat(64),
        archivePath: 'Originals/milk.jpg',
        mediaType: 'image/jpeg',
        talk: { messageId: '1' },
      },
    ],
    updatedAt: '2026-09-04T12:00:00Z',
  };
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
              .map(([k, v]) => [k, sorted(v)]),
          )
        : value;
  const token = `[[household-finance:receipt-link:v1:${receiptId}:${stale ? 'b'.repeat(64) : hash(JSON.stringify(sorted(old)))}]]`;
  const source: Snapshot = {
    version: 1,
    at: '2026-09-05T12:00:00Z',
    accounts: [{ id: 'account', name: 'Example' }],
    transactions: [
      {
        id: 'bank',
        account: 'account',
        amount: -100,
        notes: `User memo\n${token}`,
        category: 'food',
      },
      { id: 'unrelated', account: 'account', amount: 20, notes: 'Other memo' },
    ],
    notes: [
      {
        id: `household-finance:receipt:${receiptId}`,
        note: JSON.stringify(old),
      },
      { id: 'household', note: 'Keep this too' },
    ],
    categories: [{ id: 'food', name: 'Food' }],
    rules: [],
    schedules: [],
  };
  let live = structuredClone(source),
    writes = 0,
    loseReply = false;
  const plan = planConversion(
    source,
    'https://cloud.example.test/remote.php/dav/files/finance',
  );
  const store = new Store(':memory:');
  stores.push(store);
  const target = {
    snapshot: async () => structuredClone(live),
    note: async (id: string, note: string) => {
      writes++;
      const n = live.notes.find((n) => n.id === id);
      if (n) n.note = note;
      else live.notes.push({ id, note });
      if (loseReply) {
        loseReply = false;
        throw new Error('lost reply');
      }
    },
    transactionNote: async (id: string, notes: string) => {
      writes++;
      live.transactions.find((t) => t.id === id)!.notes = notes;
    },
    detail: async () => {
      throw new Error('unexpected long details');
    },
  };
  return {
    source,
    plan,
    store,
    target,
    get live() {
      return live;
    },
    get writes() {
      return writes;
    },
    loseReply: () => {
      loseReply = true;
    },
    reset: () => {
      live = structuredClone(source);
    },
  };
}
it('converts purchase history once and preserves unrelated fields and user notes', async () => {
  const f = setup();
  await expect(
    applyConversion(f.source, f.plan, f.store, f.target),
  ).resolves.toMatchObject({ verified: true });
  expect(f.live.transactions[0]).toMatchObject({
    id: 'bank',
    amount: -100,
    category: 'food',
  });
  expect(f.live.transactions[0]!.notes).toContain('User memo\n');
  expect(f.live.transactions[0]!.notes).toContain('Milk × 1 = 1.00 CAD');
  expect(f.live.transactions[1]).toEqual(f.source.transactions[1]);
  const count = f.writes;
  await applyConversion(f.source, f.plan, f.store, f.target);
  expect(f.writes).toBe(count);
});
it('recovers a successful write after losing the response without duplicating data', async () => {
  const f = setup();
  f.loseReply();
  await expect(
    applyConversion(f.source, f.plan, f.store, f.target),
  ).rejects.toThrow('lost reply');
  await applyConversion(f.source, f.plan, f.store, f.target);
  expect(f.writes).toBe(f.plan.changes.length);
});
it('refuses unexpected data before any conversion writes', async () => {
  const f = setup();
  f.live.transactions[1]!.notes = 'Edited elsewhere';
  await expect(
    applyConversion(f.source, f.plan, f.store, f.target),
  ).rejects.toThrow('unplanned-data-change');
  expect(f.writes).toBe(0);
});
it('preserves a stale link as reviewable historical evidence without changing bank categorization', async () => {
  const f = setup(true);
  expect(f.plan.counts.historicalRevisions).toBe(1);
  expect(f.plan.purchases[0]!.state).toBe('attention');
  expect(f.plan.purchases[0]!.evidence?.historicalLinks).toHaveLength(1);
  await applyConversion(f.source, f.plan, f.store, f.target);
  expect(f.live.transactions[0]!.notes).toContain('details require review');
  expect(f.live.transactions[0]!.category).toBe('food');
});
