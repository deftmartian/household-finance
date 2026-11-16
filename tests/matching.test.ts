import { expect, it } from 'vitest';
import { merchantTokens, propose } from '../src/matching.js';
import type { Transaction } from '../src/domain.js';
import { purchase, transaction } from './fixtures.js';

const tx = (id: string, patch: Partial<Transaction> = {}): Transaction => ({
  ...transaction(),
  id,
  ...patch,
});
const run = (txs: Transaction[], patch = {}, today = '2026-09-06') =>
  propose([{ ...purchase(), ...patch }], txs, 'CAD', today)[0]!;

it('tokenizes merchants without generic or numeric words', () => {
  expect(merchantTokens('THE Example Market #1234 Inc. POS PURCHASE')).toEqual([
    'example',
    'market',
  ]);
  expect(merchantTokens(null)).toEqual([]);
});
it('proposes a unique exact-amount candidate', () => {
  const r = run([tx('a'), tx('b', { amount: -999 })]);
  expect(r).toMatchObject({
    result: 'unique',
    transactions: ['a'],
    stale: false,
  });
});
it('breaks an amount tie by a shared merchant token', () => {
  const r = run([
    tx('a', { merchant: 'Other Shop' }),
    tx('b', { merchant: 'STORE', importedMerchant: 'EXAMPLE MARKET 12' }),
  ]);
  expect(r).toMatchObject({ result: 'by-merchant', transactions: ['b'] });
});
it('stays ambiguous when the tie cannot be broken', () => {
  const same = run([tx('a'), tx('b')]);
  expect(same).toMatchObject({
    result: 'ambiguous',
    transactions: [],
    candidates: ['a', 'b'],
  });
  const none = run([
    tx('a', { merchant: 'Elsewhere' }),
    tx('b', { merchant: 'Another' }),
  ]);
  expect(none.result).toBe('ambiguous');
});
it('finds a unique multi-charge combination', () => {
  const r = run([
    tx('a', { amount: -1000 }),
    tx('b', { amount: -575 }),
    tx('c', { amount: -300 }),
  ]);
  expect(r).toMatchObject({ result: 'combination', transactions: ['a', 'b'] });
});
it('reports no match and flags a stale purchase', () => {
  expect(run([tx('a', { amount: -1 })]).result).toBe('none');
  expect(run([], {}, '2026-11-02').stale).toBe(false);
  expect(run([], {}, '2026-11-04')).toMatchObject({
    result: 'none',
    stale: true,
  });
});
it('matches a refund to a positive amount only', () => {
  const refund = { total: -1575 };
  expect(run([tx('a', { amount: 1575 })], refund).transactions).toEqual(['a']);
  expect(run([tx('a', { amount: -1575 })], refund).result).toBe('none');
  expect(run([tx('a', { amount: 1575 })]).result).toBe('none');
});
it('excludes linked, transfer, starting and non-imported transactions', () => {
  const r = run([
    tx('a', { notes: '[purchase:x]\ndetails\n[/purchase:x]' }),
    tx('b', { transfer: true }),
    tx('c', { starting: true }),
    tx('d', { imported: false }),
  ]);
  expect(r.result).toBe('none');
});
it('applies the date window inclusively from two days before to seven after', () => {
  const at = (date: string) => run([tx('a', { date })]).result;
  expect(at('2026-09-01')).toBe('none');
  expect(at('2026-09-02')).toBe('unique');
  expect(at('2026-09-11')).toBe('unique');
  expect(at('2026-09-12')).toBe('none');
});
it('skips cash, wrong-currency, zero, factless and settled purchases', () => {
  for (const patch of [
    { payment: 'cash' as const },
    { currency: 'USD' },
    { total: 0 },
    { date: null },
    { state: 'linked' as const },
  ])
    expect(
      propose([{ ...purchase(), ...patch }], [tx('a')], 'CAD', '2026-09-06'),
    ).toEqual([]);
});
it('does not let one bank line settle two receipts', () => {
  const second = { ...purchase(), id: 'purchase-two' };
  const r = propose([purchase(), second], [tx('a')], 'CAD', '2026-09-06');
  expect(r.map((x) => x.result)).toEqual(['ambiguous', 'ambiguous']);
});
