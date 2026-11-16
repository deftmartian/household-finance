import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  allocationSchema,
  canonical,
  factsSchema,
  Fault,
  hash,
  id,
  itemAllocations,
  key,
  parsePurchase,
  purchaseDetails,
  text,
  validateAllocations,
  withPurchaseNote,
} from './domain.js';
import type { Allocation, Purchase, Transaction } from './domain.js';
import { Writer } from './actual.js';
import type { Ledger } from './actual.js';
import type { Store } from './store.js';
import { itemKey, loadItems, lookup, saveItems, upsert } from './items.js';
import { propose } from './matching.js';

export interface Session {
  store: Store;
  ledger: Ledger;
  writeAccounts: ReadonlySet<string>;
  currency: string;
  itemsPath: string;
  original(url: string): Promise<Buffer>;
  details(purchaseId: string, revision: number, body: string): Promise<string>;
  now(): Date;
}
const DAY = 86400000;
const open = (p: Purchase) => p.state === 'pending' || p.state === 'attention';
const uncategorized = (s: Session, t: Transaction) =>
  s.writeAccounts.has(t.account) &&
  t.imported &&
  !t.transfer &&
  !t.starting &&
  !t.category &&
  !t.children.length;
async function snapshot(s: Session) {
  await s.ledger.sync();
  return {
    purchases: new Map((await s.ledger.purchases()).map((p) => [p.id, p])),
    transactions: new Map(
      (await s.ledger.transactions()).map((t) => [t.id, t]),
    ),
    categories: new Set((await s.ledger.categories()).map((c) => c.id)),
  };
}
type State = Awaited<ReturnType<typeof snapshot>>;

export async function status(s: Session) {
  const state = await snapshot(s);
  const states: Record<string, number> = {};
  for (const p of state.purchases.values())
    states[p.state] = (states[p.state] ?? 0) + 1;
  return {
    banks: (await s.ledger.banks()).map(bankView),
    uncategorized: [...state.transactions.values()].filter((t) =>
      uncategorized(s, t),
    ).length,
    purchases: states,
  };
}
const bankView = (b: {
  name: string;
  bank: string | null;
  ok: boolean;
  lastSync: string | null;
}) => ({
  name: b.name,
  bank: b.bank,
  ok: b.ok,
  lastSync: b.lastSync,
});
export async function sync(s: Session) {
  return { banks: (await s.ledger.bankSync()).map(bankView) };
}
export function items(s: Session) {
  return loadItems(s.itemsPath);
}
function suggestion(
  p: Purchase,
  map: ReturnType<typeof loadItems>,
  categories: ReadonlySet<string>,
) {
  if (!p.items.length) return undefined;
  const rows = p.items.map((item, index) => ({
    index,
    key: itemKey(item.description),
    entry: lookup(map, p.merchant, item.description),
  }));
  const mapped = rows.flatMap((r) =>
    r.entry ? [{ index: r.index, category: r.entry.category }] : [],
  );
  const unmapped = rows
    .filter((r) => !r.entry)
    .map((r) => ({
      index: r.index,
      key: r.key,
      description: p.items[r.index]!.description,
    }));
  if (unmapped.length) return { mapped, unmapped };
  try {
    return { allocations: itemAllocations(p, mapped, categories) };
  } catch (error) {
    return {
      mapped,
      unmapped,
      error: error instanceof Fault ? error.code : 'invalid',
    };
  }
}
export async function pending(s: Session) {
  const state = await snapshot(s);
  const names = await s.ledger.accountNames();
  const map = loadItems(s.itemsPath);
  const now = s.now().getTime();
  const open_ = [...state.purchases.values()].filter(open);
  return {
    categories: [...(await s.ledger.categories())],
    uncategorized: [...state.transactions.values()]
      .filter((t) => uncategorized(s, t))
      .map((t) => ({
        id: t.id,
        date: t.date,
        amount: t.amount,
        merchant: t.merchant,
        importedMerchant: t.importedMerchant ?? '',
        account: names.get(t.account) ?? '',
        notes: t.notes,
      })),
    purchases: open_.map((p) => ({
      id: p.id,
      state: p.state,
      merchant: p.merchant,
      date: p.date,
      total: p.total,
      currency: p.currency,
      payment: p.payment,
      itemCount: p.items.length,
      hasFacts: p.total !== null && p.date !== null,
      sources: p.sources.map((x, index) => ({ index, mediaType: x.mediaType })),
      annotations: p.annotations.map((a) => a.text),
      ageDays: Math.max(
        0,
        Math.floor((now - Date.parse(p.date ?? p.provenance.at)) / DAY),
      ),
    })),
    suggestions: open_.flatMap((p) => {
      const found = suggestion(p, map, state.categories);
      return found ? [{ purchase: p.id, ...found }] : [];
    }),
  };
}
export async function match(s: Session) {
  const state = await snapshot(s);
  const writable = [...state.transactions.values()].filter((t) =>
    s.writeAccounts.has(t.account),
  );
  return {
    proposals: propose(
      [...state.purchases.values()],
      writable,
      s.currency,
      s.now().toISOString().slice(0, 10),
    ),
  };
}

const links = z
  .array(
    z.strictObject({
      transaction: id,
      allocations: z.array(allocationSchema).min(1).max(30),
    }),
  )
  .min(1)
  .max(20);
const opSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('facts'), purchase: id, facts: factsSchema }),
  z.strictObject({ op: z.literal('resolve'), purchase: id, links }),
  z.strictObject({
    op: z.literal('categorize'),
    transaction: id,
    allocations: z.array(allocationSchema).min(1).max(30),
  }),
  z.strictObject({
    op: z.literal('discard'),
    purchase: id,
    reason: text.min(1).max(2000),
  }),
  z.strictObject({
    op: z.literal('rule'),
    importedMerchant: z.string().min(1).max(300),
    category: id,
    applyExisting: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal('item'),
    merchant: z.string().min(1).max(300),
    key: z.string().min(1).max(300),
    category: id,
  }),
]);
export const planSchema = z.strictObject({
  ops: z.array(opSchema).min(1).max(200),
});
export type Plan = z.infer<typeof planSchema>;
type Op = Plan['ops'][number];
interface Step {
  result: Record<string, unknown>;
  // Updates the dry-run view so later ops see this one's effect.
  after(state: State): void;
  run(): Promise<void>;
}
const noop = (result: Record<string, unknown>): Step => ({
  result: { ...result, already: true },
  after: () => undefined,
  run: async () => undefined,
});
function shape(t: Transaction, allocations: Allocation[]): boolean {
  const have = (
    t.children.length
      ? t.children.map((c) => ({
          category: c.category ?? '',
          amount: c.amount,
        }))
      : [{ category: t.category ?? '', amount: t.amount }]
  )
    .map((a) => canonical(a))
    .sort();
  return (
    canonical(have) === canonical(allocations.map((a) => canonical(a)).sort())
  );
}
function writable(s: Session, t: Transaction | undefined): Transaction {
  if (
    !t ||
    !s.writeAccounts.has(t.account) ||
    !t.imported ||
    t.transfer ||
    t.starting
  )
    throw new Fault('transaction-not-eligible');
  return t;
}
function stored<T>(
  s: Session,
  opId: string,
): { expected: T; desired: T } | undefined {
  const old = s.store.operation(opId);
  return old
    ? {
        expected: JSON.parse(old.expected) as T,
        desired: JSON.parse(old.desired) as T,
      }
    : undefined;
}
async function plan(
  s: Session,
  writer: Writer,
  op: Op,
  state: State,
): Promise<Step> {
  const purchase = (name: string) => {
    const p = state.purchases.get(name);
    if (!p) throw new Fault('purchase-missing');
    return p;
  };
  const publishing = (
    name: string,
    current: Purchase,
    next: Purchase,
    extra: Record<string, unknown> = {},
  ): Step => {
    parsePurchase(next);
    return {
      result: {
        purchase: current.id,
        revision: next.revision,
        state: next.state,
        ...extra,
      },
      after: (st) => void st.purchases.set(next.id, next),
      run: () => writer.publish(name, current, next),
    };
  };
  if (op.op === 'facts') {
    const p = purchase(op.purchase);
    if (
      p.provenance.method === 'capture' &&
      canonical(factsSchema.strip().parse(p)) === canonical(op.facts)
    )
      return noop({ op: 'facts', purchase: p.id });
    if (p.provenance.method !== 'capture' || !open(p) || p.transactions.length)
      throw new Fault('purchase-not-capture-only');
    const next = parsePurchase({
      ...p,
      ...op.facts,
      revision: p.revision + 1,
    });
    return publishing(
      key('session', 'facts', p.id, String(p.revision), hash(op.facts)),
      p,
      next,
      { op: 'facts' },
    );
  }
  if (op.op === 'discard') {
    const p = purchase(op.purchase);
    if (p.state === 'discarded') return noop({ op: 'discard', purchase: p.id });
    if (!open(p) || p.transactions.length) throw new Fault('purchase-not-open');
    const name = key(
      'session',
      'discard',
      p.id,
      String(p.revision),
      hash(op.reason),
    );
    const next =
      stored<Purchase>(s, name)?.desired ??
      parsePurchase({
        ...p,
        revision: p.revision + 1,
        state: 'discarded',
        annotations: [
          ...p.annotations,
          {
            speaker: 'session',
            messageId: 'session',
            at: s.now().toISOString(),
            text: op.reason,
          },
        ],
      });
    return publishing(name, p, next, { op: 'discard' });
  }
  if (op.op === 'resolve') return resolve(s, writer, op, state);
  if (op.op === 'categorize') {
    const t = writable(s, state.transactions.get(op.transaction));
    if (shape(t, op.allocations) && !uncategorized(s, t))
      return noop({ op: 'categorize', transaction: t.id });
    if (!uncategorized(s, t)) throw new Fault('transaction-not-uncategorized');
    validateAllocations(t.amount, op.allocations, state.categories);
    const desired = writer.desired(t, op.allocations);
    return {
      result: {
        op: 'categorize',
        transaction: t.id,
        allocations: op.allocations.length,
      },
      after: (st) => void st.transactions.set(t.id, desired),
      run: () =>
        writer.apply(
          key('session', 'categorize', hash(t), hash(desired)),
          t,
          desired,
        ),
    };
  }
  if (op.op === 'item') {
    if (!state.categories.has(op.category))
      throw new Fault('invalid-allocation');
    const current = loadItems(s.itemsPath);
    const next = upsert(
      current,
      op.merchant,
      op.key,
      op.category,
      s.now().toISOString(),
    );
    if (next === current) return noop({ op: 'item', key: itemKey(op.key) });
    return {
      result: { op: 'item', key: itemKey(op.key), category: op.category },
      after: () => undefined,
      run: async () => saveItems(s.itemsPath, next),
    };
  }
  // rule
  if (!state.categories.has(op.category)) throw new Fault('invalid-allocation');
  const exists = (await s.ledger.rules()).some(
    (r) =>
      r.conditionsOp === 'and' &&
      r.conditions.length === 1 &&
      r.conditions[0]!.field === 'imported_payee' &&
      r.conditions[0]!.op === 'is' &&
      r.conditions[0]!.value === op.importedMerchant,
  );
  if (exists) throw new Fault('rule-exists');
  const targets = op.applyExisting
    ? [...state.transactions.values()].filter(
        (t) =>
          uncategorized(s, t) && t.importedMerchant === op.importedMerchant,
      )
    : [];
  return {
    result: {
      op: 'rule',
      category: op.category,
      applyExisting: targets.length,
    },
    after: () => undefined,
    run: async () => {
      await s.ledger.createRule(op.importedMerchant, op.category);
      for (const t of targets) {
        const desired = writer.desired(t, [
          { category: op.category, amount: t.amount },
        ]);
        await writer.apply(
          key('session', 'rule-apply', hash(t), hash(desired)),
          t,
          desired,
        );
      }
    },
  };
}
async function resolve(
  s: Session,
  writer: Writer,
  op: Extract<Op, { op: 'resolve' }>,
  state: State,
): Promise<Step> {
  const p = state.purchases.get(op.purchase);
  if (!p) throw new Fault('purchase-missing');
  const ids = op.links.map((l) => l.transaction);
  const merged = new Map<string, number>();
  for (const l of op.links)
    for (const a of l.allocations)
      merged.set(a.category, (merged.get(a.category) ?? 0) + a.amount);
  const allocations = [...merged]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, amount]) => ({ category, amount }));
  if (
    p.state === 'linked' &&
    canonical(p.transactions.map((t) => t.id).sort()) ===
      canonical([...ids].sort()) &&
    canonical(p.allocations) === canonical(allocations)
  )
    return noop({ op: 'resolve', purchase: p.id });
  if (
    !open(p) ||
    p.total === null ||
    p.currency !== s.currency ||
    p.payment === 'cash' ||
    new Set(ids).size !== ids.length
  )
    throw new Fault('purchase-match-evidence');
  const targets = ids.map((i) => writable(s, state.transactions.get(i)));
  if (
    targets.some(
      (t) =>
        t.account !== targets[0]!.account ||
        (t.notes.includes('[purchase:') &&
          !t.notes.includes(`[purchase:${p.id}]`)),
    )
  )
    throw new Fault('purchase-match-evidence');
  if (targets.reduce((n, t) => n + t.amount, 0) !== -p.total)
    throw new Fault('purchase-match-evidence');
  op.links.forEach((l, i) =>
    validateAllocations(targets[i]!.amount, l.allocations, state.categories),
  );
  const next = parsePurchase({
    ...p,
    revision: p.revision + 1,
    state: 'linked',
    transactions: targets.map((t) => ({
      id: t.id,
      account: t.account,
      amount: t.amount,
    })),
    allocations,
  });
  const desire = (t: Transaction, allocs: Allocation[], detail?: string) =>
    shape(t, allocs)
      ? { ...t, notes: withPurchaseNote(t.notes, next, detail) }
      : writer.desired(t, allocs, next, detail);
  const base = key(
    'session',
    'resolve',
    p.id,
    String(p.revision),
    hash(op.links),
  );
  return {
    result: {
      op: 'resolve',
      purchase: p.id,
      transactions: ids.length,
      state: 'linked',
    },
    after: (st) => {
      st.purchases.set(p.id, next);
      for (const [i, t] of targets.entries())
        st.transactions.set(
          t.id,
          desire(t, op.links[i]!.allocations, 'detail-link'),
        );
    },
    run: async () => {
      const body = purchaseDetails(next);
      const detail =
        body.length > 6500
          ? await s.details(next.id, next.revision, body)
          : undefined;
      for (const [i, t] of targets.entries()) {
        const opId = key(base, 'transaction', t.id);
        const old = stored<Transaction>(s, opId);
        const allocs = op.links[i]!.allocations;
        const desired = old?.desired ?? desire(t, allocs, detail);
        await writer.apply(opId, old?.expected ?? t, desired);
      }
      await writer.publish(key(base, 'purchase'), p, next);
    },
  };
}

export async function apply(s: Session, input: unknown, commit: boolean) {
  const parsed = planSchema.parse(input);
  const writer = new Writer(s.store, s.ledger);
  const results: Array<Record<string, unknown>> = [];
  let state = await snapshot(s);
  for (const [index, op] of parsed.ops.entries()) {
    try {
      if (commit && index) state = await snapshot(s);
      const step = await plan(s, writer, op, state);
      if (commit) await step.run();
      else step.after(state);
      results.push({ index, ok: true, ...step.result });
    } catch (error) {
      const code =
        error instanceof Fault
          ? error.code
          : error instanceof z.ZodError
            ? 'invalid-input'
            : 'operation-failed';
      results.push({ index, ok: false, op: op.op, error: code });
      return { ok: false, error: code, committed: commit, results };
    }
  }
  return { ok: true, committed: commit, results };
}

export async function receipt(
  s: Session,
  purchaseId: string,
  index: number,
  out: string,
) {
  const p = (await s.ledger.purchases()).find((x) => x.id === purchaseId);
  const source = p?.sources[index];
  if (!source) throw new Fault('source-missing');
  const bytes = await s.original(source.url);
  if (createHash('sha256').update(bytes).digest('hex') !== source.hash)
    throw new Fault('receipt-hash-mismatch');
  writeFileSync(out, bytes, { mode: 0o600 });
  chmodSync(out, 0o600);
  return { path: out, mediaType: source.mediaType, bytes: bytes.length };
}
