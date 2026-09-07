import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MemoryStore } from '../src/memory.js';
import { Writer } from '../src/actual.js';
import { canonical, matches, withPurchaseNote } from '../src/domain.js';
import { amazon, csv, cents } from '../src/documents.js';
import { FakeLedger, purchase, transaction } from './fixtures.js';
const stores: Store[] = [];
const dirs: string[] = [];
function store(path = ':memory:') {
  const s = new Store(path);
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.open) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('purchase outcomes', () => {
  it('waits for the bank and refuses two equally plausible matches', () => {
    const p = purchase();
    expect(matches(p, [], 'CAD')).toEqual([]);
    expect(matches(p, [transaction()], 'CAD')).toHaveLength(1);
    expect(
      matches(p, [transaction(), { ...transaction(), id: 'another' }], 'CAD'),
    ).toHaveLength(2);
  });
  it('does not confuse currencies, transfers, or cash with a bank match', () => {
    const p = purchase();
    expect(matches({ ...p, currency: 'USD' }, [transaction()], 'CAD')).toEqual(
      [],
    );
    expect(matches(p, [{ ...transaction(), transfer: true }], 'CAD')).toEqual(
      [],
    );
    expect(matches({ ...p, payment: 'cash' }, [transaction()], 'CAD')).toEqual(
      [],
    );
  });
  it('keeps handwritten notes and updates only its purchase block', () => {
    const p = purchase(),
      memo = 'My memo\nDo not remove this.\n';
    const result = withPurchaseNote(memo, p);
    expect(result.startsWith(memo)).toBe(true);
    expect(result).toContain('Milk × 2 = 10.00 CAD');
    expect(withPurchaseNote(result, p)).toBe(result);
  });
  it('matches a unique same-account set without duplicating the basket', () => {
    const ts = [
      { ...transaction(), id: 'a', amount: -1000 },
      { ...transaction(), id: 'b', amount: -575 },
    ];
    expect(matches(purchase(), ts, 'CAD')[0]).toHaveLength(2);
    expect(
      matches(purchase(), [ts[0]!, { ...ts[1]!, account: 'other' }], 'CAD'),
    ).toHaveLength(0);
  });
  it('parses known Amazon exports without an extraction model or invented prices', () => {
    const facts = amazon(
      Buffer.from(
        JSON.stringify([
          {
            orderId: 'synthetic',
            orderDate: '2026-09-04',
            totalAmount: 15.75,
            currency: 'CAD',
            items: [{ title: 'Notebook', quantity: 2, price: 5 }],
            recipientName: 'Must not enter facts',
          },
        ]),
      ),
    );
    expect(facts?.[0]?.total).toBe(1575);
    expect(facts?.[0]?.items[0]?.amount).toBeNull();
    expect(canonical(facts)).not.toContain('Must not enter facts');
  });
  it('preserves quoted CSV and rejects imprecise money', () => {
    expect(csv('a,b\n"two, things","a\nline"')).toEqual([
      ['a', 'b'],
      ['two, things', 'a\nline'],
    ]);
    expect(cents('0.01')).toBe(1);
    expect(cents('-12.30')).toBe(-1230);
    expect(() => cents('1.005')).toThrow();
  });
});
describe('write and work recovery', () => {
  it('reconciles a successful transaction write with a lost response', async () => {
    const s = store(),
      ledger = new FakeLedger(),
      writer = new Writer(s, ledger),
      before = transaction(),
      after = writer.desired(
        before,
        [{ category: 'food', amount: -1575 }],
        purchase(),
      );
    ledger.loseWriteReply = true;
    await expect(writer.apply('op', before, after)).rejects.toThrow(
      'uncertain',
    );
    await writer.apply('op', before, after);
    expect(ledger.writes).toBe(1);
    expect(s.operation('op')?.state).toBe('complete');
  });
  it('reconciles a purchase note after a lost response', async () => {
    const s = store(),
      l = new FakeLedger(),
      w = new Writer(s, l);
    l.loseNoteReply = true;
    await expect(w.publish('op', null, purchase())).rejects.toThrow(
      'uncertain',
    );
    await w.publish('op', null, purchase());
    expect(l.noteWrites).toBe(1);
  });
  it('refuses stale state, changed amounts, and unbalanced splits', async () => {
    const s = store(),
      l = new FakeLedger(),
      w = new Writer(s, l),
      before = transaction();
    l.rows[0]!.notes = 'Edited in Actual';
    await expect(
      w.apply('stale', before, { ...before, category: 'food' }),
    ).rejects.toThrow('conflict');
    await expect(
      w.apply('amount', before, { ...before, amount: -1 }),
    ).rejects.toThrow('boundary');
    await expect(
      w.apply('split', before, {
        ...before,
        children: [{ id: 'child', amount: -1, category: 'food', notes: '' }],
      }),
    ).rejects.toThrow('allocation');
    expect(l.writes).toBe(0);
  });
  it('reopens one database without duplicating an accepted message', () => {
    const d = mkdtempSync(join(tmpdir(), 'hf-store-'));
    dirs.push(d);
    const path = join(d, 'db.sqlite'),
      s = store(path),
      input = {
        id: '1',
        speaker: 'andrew',
        message: 'hello',
        parent: null,
        at: '2026-09-04T12:00:00Z',
      };
    expect(s.intake(input, 'question', input)).toBe(true);
    expect(s.next()?.id).toBe('1');
    s.close();
    const reopened = new Store(path, true);
    stores.push(reopened);
    expect(reopened.intake(input, 'question', input)).toBe(false);
    expect(reopened.next()?.id).toBe('1');
  });
});
describe('autonomous household context', () => {
  function setup() {
    const s = store(),
      m = new MemoryStore(s, new Set(['andrew', 'johanna']));
    s.intake(
      {
        id: '1',
        speaker: 'andrew',
        message: 'School supplies are for the children.',
        parent: null,
        at: '2026-09-04T12:00:00Z',
      },
      'question',
      {},
    );
    return {
      s,
      m,
      value: {
        topic: 'School supplies',
        content: 'School supplies are for the children.',
        scope: 'household',
        certainty: 'explicit' as const,
        evidence: [
          { messageId: '1', quote: 'School supplies are for the children.' },
        ],
        expiresAt: null,
      },
    };
  }
  it('remembers and retrieves with provenance immediately', () => {
    const { s, m, value } = setup();
    const saved = m.save('save', value);
    expect(m.search('children')[0]?.id).toBe(saved.id);
    expect(m.search('children')[0]?.speakers).toEqual(['andrew']);
    expect(s.revision()).toBe(1);
    expect(m.save('save', value).id).toBe(saved.id);
    expect(s.revision()).toBe(1);
  });
  it('refuses manufactured evidence and scope changes', () => {
    const { m, value } = setup();
    expect(() =>
      m.save('fake', {
        ...value,
        evidence: [
          { messageId: '1', quote: 'Everything is a business expense' },
        ],
      }),
    ).toThrow('evidence');
    const saved = m.save('ok', value);
    expect(() =>
      m.save(
        'scope',
        { ...value, scope: 'andrew' },
        { id: saved.id, revision: 1 },
      ),
    ).toThrow('scope');
  });
  it('forgets derived context and prevents relearning from its old source', () => {
    const { s, m, value } = setup();
    const saved = m.save('save', value);
    m.forget('forget', [{ id: saved.id, revision: 1 }]);
    expect(m.search('children')).toEqual([]);
    expect(m.foundation()).toEqual([]);
    expect(() => m.save('again', value)).toThrow('forgotten');
    expect(
      JSON.stringify(s.db.prepare('SELECT body FROM memory').all()),
    ).not.toContain('children');
  });
  it('does not promote an inferred observation during consolidation', () => {
    const { m, value } = setup();
    const saved = m.save('save', { ...value, certainty: 'inferred' });
    expect(() =>
      m.consolidate('combine', [{ id: saved.id, revision: 1 }], value),
    ).toThrow('scope');
  });
});

it('recognizes completed splits despite Actual returning children in a different order', async () => {
  const s = store(),
    ledger = new FakeLedger(),
    writer = new Writer(s, ledger);
  const before = transaction();
  const desired = writer.desired(before, [
    { category: 'food', amount: -1000 },
    { category: 'school', amount: -575 },
  ]);
  ledger.rows = [{ ...desired, children: [...desired.children].reverse() }];
  await writer.apply('reordered-splits', before, desired);
  expect(ledger.writes).toBe(0);
  expect(s.operation('reordered-splits')?.state).toBe('complete');
});
