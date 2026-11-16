import { Fault, matches } from './domain.js';
import type { Purchase, Transaction } from './domain.js';

const DAY = 86400000;
const GENERIC = new Set([
  'the',
  'inc',
  'ltd',
  'llc',
  'corp',
  'store',
  'stores',
  'pos',
  'purchase',
  'payment',
  'debit',
  'www',
  'com',
]);
export const STALE_DAYS = 60;
export function merchantTokens(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !GENERIC.has(t)),
    ),
  ];
}
export interface Proposal {
  purchase: string;
  result: 'unique' | 'by-merchant' | 'combination' | 'ambiguous' | 'none';
  transactions: string[];
  candidates: string[];
  stale: boolean;
}
export function eligible(p: Purchase, currency: string): boolean {
  return (
    (p.state === 'pending' || p.state === 'attention') &&
    !!p.date &&
    p.total !== null &&
    p.total !== 0 &&
    p.currency === currency &&
    p.payment !== 'cash'
  );
}
export function propose(
  purchases: Purchase[],
  transactions: Transaction[],
  currency: string,
  today: string,
): Proposal[] {
  const out = purchases
    .filter((p) => eligible(p, currency))
    .map((p): Proposal => {
      const total = p.total!,
        day = Date.parse(p.date!);
      const pool = transactions.filter((t) => {
        const at = Date.parse(t.date);
        return (
          t.imported &&
          !t.transfer &&
          !t.starting &&
          !t.notes.includes('[purchase:') &&
          Math.sign(t.amount) === -Math.sign(total) &&
          at >= day - 2 * DAY &&
          at <= day + 7 * DAY
        );
      });
      const ids = (rows: Transaction[]) => rows.map((t) => t.id).sort();
      const make = (
        result: Proposal['result'],
        picked: Transaction[],
        candidates: Transaction[] = [],
      ): Proposal => ({
        purchase: p.id,
        result,
        transactions:
          result === 'ambiguous' || result === 'none' ? [] : ids(picked),
        candidates: ids(candidates),
        stale: false,
      });
      const exact = pool.filter((t) => t.amount === -total);
      if (exact.length === 1) return make('unique', exact);
      if (exact.length > 1) {
        const terms = new Set(merchantTokens(p.merchant));
        const named = exact.filter((t) =>
          [
            ...merchantTokens(t.merchant),
            ...merchantTokens(t.importedMerchant),
          ].some((x) => terms.has(x)),
        );
        return named.length === 1
          ? make('by-merchant', named)
          : make('ambiguous', [], exact);
      }
      let found: Transaction[][];
      try {
        found = matches(p, pool, currency);
      } catch (error) {
        if (!(error instanceof Fault)) throw error;
        return make('ambiguous', [], pool);
      }
      if (found.length === 1) return make('combination', found[0]!);
      return found.length
        ? make('ambiguous', [], found.flat())
        : make('none', []);
    });
  // One bank line cannot settle two receipts.
  const claims = new Map<string, number>();
  for (const x of out)
    if (
      x.result === 'unique' ||
      x.result === 'by-merchant' ||
      x.result === 'combination'
    )
      for (const t of x.transactions) claims.set(t, (claims.get(t) ?? 0) + 1);
  const byId = new Map(purchases.map((p) => [p.id, p]));
  return out.map((x) => {
    if (x.transactions.some((t) => claims.get(t)! > 1))
      x = {
        ...x,
        result: 'ambiguous',
        candidates: x.transactions,
        transactions: [],
      };
    const age =
      (Date.parse(today) - Date.parse(byId.get(x.purchase)!.date!)) / DAY;
    return { ...x, stale: x.result === 'none' && age > STALE_DAYS };
  });
}
