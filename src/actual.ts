import { z } from 'zod';
import * as api from '@actual-app/api';
import {
  canonical,
  Fault,
  hash,
  key,
  parsePurchase,
  PURCHASE_PREFIX,
  validateAllocations,
  withPurchaseNote,
} from './domain.js';
import type { Allocation, Purchase, Transaction } from './domain.js';
import type { Store } from './store.js';
import type { BankHealth, BudgetCategory } from './weekly.js';

export interface Ledger {
  sync(): Promise<void>;
  transactions(): Promise<Transaction[]>;
  categories(): Promise<Array<{ id: string; name: string }>>;
  note(id: string): Promise<string | null>;
  writeNote(id: string, value: string): Promise<void>;
  update(expected: Transaction, desired: Transaction): Promise<void>;
  purchases(): Promise<Purchase[]>;
  report(month: string): Promise<unknown>;
  ruleCategory(t: Transaction): Promise<string | null>;
  bankSync(): Promise<BankHealth[]>;
  budget(month: string): Promise<BudgetCategory[]>;
}
const budgetMonthSchema = z.object({
  categoryGroups: z.array(
    z.object({
      is_income: z.boolean().optional(),
      hidden: z.boolean().optional(),
      categories: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            hidden: z.boolean().optional(),
            budgeted: z.number().optional(),
            spent: z.number().optional(),
            balance: z.number().optional(),
          }),
        )
        .optional(),
    }),
  ),
});
interface AccountRow {
  id: string;
  name: string;
  closed: number | boolean;
  tombstone: number | boolean;
  account_sync_source: string | null;
  bankName: string | null;
  last_sync: string | null;
  bank_sync_status: string | null;
}
export class ActualLedger implements Ledger {
  constructor(
    readonly accounts: ReadonlySet<string>,
    readonly client: Awaited<ReturnType<typeof api.init>>,
    readonly startDate = '2000-01-01',
  ) {}
  async sync(): Promise<void> {
    await api.sync();
  }
  async categories(): Promise<Array<{ id: string; name: string }>> {
    return (await api.getCategories())
      .filter((c) => !c.hidden)
      .map((c) => ({ id: c.id, name: c.name }));
  }
  async ruleCategory(t: Transaction): Promise<string | null> {
    // Imports already run Actual's full rule engine. Re-evaluate only exact,
    // category-only rules here: the core rules-run endpoint can create payees.
    const categories = new Set<string>();
    for (const rule of await api.getRules()) {
      if (
        rule.conditionsOp !== 'and' ||
        !rule.conditions.length ||
        rule.actions.length !== 1
      )
        continue;
      const a = rule.actions[0]!;
      if (
        a.op !== 'set' ||
        a.field !== 'category' ||
        typeof a.value !== 'string'
      )
        continue;
      if (
        rule.conditions.every(
          (c) =>
            c.op === 'is' &&
            ((c.field === 'account' && c.value === t.account) ||
              (c.field === 'payee' && c.value === t.payee) ||
              (c.field === 'imported_payee' && c.value === t.importedMerchant)),
        )
      )
        categories.add(a.value);
    }
    return categories.size === 1 ? [...categories][0]! : null;
  }
  async transactions(): Promise<Transaction[]> {
    const allAccounts = await api.getAccounts();
    if (
      [...this.accounts].some(
        (id) => !allAccounts.some((a) => a.id === id && !a.closed),
      )
    )
      throw new Fault('account-contract-drift');
    const payees = new Map((await api.getPayees()).map((p) => [p.id, p]));
    const result: Transaction[] = [];
    for (const account of this.accounts) {
      const rows = await api.getTransactions(
        account,
        this.startDate,
        new Date().toISOString().slice(0, 10),
      );
      for (const t of rows) {
        if (t.is_child) continue;
        result.push({
          id: t.id,
          account,
          date: t.date,
          amount: t.amount ?? 0,
          payee: t.payee ?? null,
          merchant: payees.get(t.payee ?? '')?.name ?? t.imported_payee ?? '',
          importedMerchant: t.imported_payee ?? '',
          notes: t.notes ?? '',
          category: t.category ?? null,
          imported: !!t.imported_id,
          transfer:
            !!t.transfer_id || !!payees.get(t.payee ?? '')?.transfer_acct,
          starting: !!t.starting_balance_flag,
          children: (t.subtransactions ?? []).map((c) => ({
            id: c.id,
            amount: c.amount ?? 0,
            category: c.category ?? null,
            notes: c.notes ?? '',
          })),
        });
      }
    }
    return result;
  }
  async bankSync(): Promise<BankHealth[]> {
    // The public runBankSync stops at the first failing account. The batch
    // handler behind it imports every healthy account and records per-account
    // status, so one expired login does not hide the rest.
    const send = this.client.send as (
      name: string,
      args?: unknown,
    ) => Promise<unknown>;
    const linked = ((await send('accounts-get')) as AccountRow[]).filter(
      (a) => a.account_sync_source === 'simpleFin' && !a.closed && !a.tombstone,
    );
    if (!linked.length) return [];
    const started = Date.now();
    try {
      await send('simplefin-batch-sync', { ids: linked.map((a) => a.id) });
      await this.sync();
    } catch {
      throw new Fault('bank-sync-failed', true);
    }
    const after = new Map(
      ((await send('accounts-get')) as AccountRow[]).map((a) => [a.id, a]),
    );
    return linked.map((a) => {
      const row = after.get(a.id);
      const last = Number(row?.last_sync ?? 0);
      return {
        account: a.id,
        name: a.name,
        bank: a.bankName,
        ok: last >= started - 60000 && (row?.bank_sync_status ?? 'ok') === 'ok',
        lastSync: last ? new Date(last).toISOString() : null,
      };
    });
  }
  async budget(month: string): Promise<BudgetCategory[]> {
    const result = budgetMonthSchema.parse(await api.getBudgetMonth(month));
    return result.categoryGroups
      .filter((g) => !g.hidden)
      .flatMap((g) =>
        (g.categories ?? [])
          .filter((c) => !c.hidden)
          .map((c) => ({
            id: c.id,
            name: c.name,
            income: !!g.is_income,
            budgeted: c.budgeted ?? 0,
            spent: c.spent ?? 0,
            balance: c.balance ?? 0,
          })),
      );
  }
  async note(id: string): Promise<string | null> {
    return (await api.getNote(id))?.note ?? null;
  }
  async writeNote(id: string, value: string): Promise<void> {
    if (!id.startsWith(PURCHASE_PREFIX)) throw new Fault('note-namespace');
    await api.updateNote(id, value);
  }
  async purchases(): Promise<Purchase[]> {
    const result = (await api.aqlQuery(
      api.q('notes').select(['id', 'note']),
    )) as { data: Array<{ id: string; note: string }> };
    return result.data
      .filter((n) => n.id.startsWith(PURCHASE_PREFIX) && n.note)
      .map((n) => {
        const p = parsePurchase(JSON.parse(n.note));
        if (n.id !== PURCHASE_PREFIX + p.id)
          throw new Fault('purchase-identity');
        return p;
      });
  }
  async report(month: string): Promise<unknown> {
    return {
      budget: await api.getBudgetMonth(month),
      schedules: await api.getSchedules(),
      balances: await Promise.all(
        [...this.accounts].map(async (id) => ({
          id,
          amount: await api.getAccountBalance(id),
        })),
      ),
    };
  }
  async update(expected: Transaction, desired: Transaction): Promise<void> {
    // API 26.8.1's transaction-update handler indexes an unawaited promise.
    // Use its awaited core batch handler, with only validated category/note fields.
    const changed =
      canonical(expected.children) !== canonical(desired.children);
    const updated = [
      {
        id: desired.id,
        notes: desired.notes,
        category: desired.children.length ? null : desired.category,
        ...(changed
          ? { is_parent: desired.children.length > 0, error: null }
          : {}),
      },
    ];
    const added = changed
      ? desired.children
          .filter((c) => !expected.children.some((e) => e.id === c.id))
          .map((c) => ({
            id: c.id,
            account: desired.account,
            date: desired.date,
            amount: c.amount,
            category: c.category,
            notes: c.notes,
            payee: desired.payee,
            parent_id: desired.id,
            is_child: true,
            is_parent: false,
          }))
      : [];
    const deleted = changed
      ? expected.children
          .filter((c) => !desired.children.some((d) => d.id === c.id))
          .map((c) => ({ id: c.id }))
      : [];
    if (
      changed &&
      desired.children.some((c) =>
        expected.children.some(
          (e) => e.id === c.id && canonical(e) !== canonical(c),
        ),
      )
    )
      throw new Fault('split-child-identity-conflict');
    const result = await (
      this.client.send as (name: string, args: unknown) => Promise<unknown>
    )('transactions-batch-update', {
      added,
      updated,
      deleted,
      learnCategories: false,
      runTransfers: false,
    });
    if (result && typeof result === 'object' && 'error' in result)
      throw new Fault('actual-batch-error');
  }
}
export class Writer {
  constructor(
    readonly store: Store,
    readonly ledger: Ledger,
  ) {}
  async publish(
    operationId: string,
    expected: Purchase | null,
    desired: Purchase,
  ): Promise<void> {
    parsePurchase(desired);
    const noteId = PURCHASE_PREFIX + desired.id;
    const op = this.store.prepare(
      operationId,
      'purchase',
      expected ? canonical(expected) : null,
      canonical(desired),
    );
    if (op.state === 'complete') return;
    await this.ledger.sync();
    const current = await this.ledger.note(noteId);
    if (current === canonical(desired)) {
      this.store.operationState(operationId, 'complete');
      this.store.cachePurchase(desired.id, desired);
      return;
    }
    if (current !== (expected ? canonical(expected) : null)) {
      this.store.operationState(operationId, 'attention');
      throw new Fault('purchase-conflict');
    }
    this.store.operationState(operationId, 'applying');
    try {
      await this.ledger.writeNote(noteId, canonical(desired));
      await this.ledger.sync();
    } catch {
      throw new Fault('purchase-write-uncertain', true);
    }
    if ((await this.ledger.note(noteId)) !== canonical(desired)) {
      this.store.operationState(operationId, 'attention');
      throw new Fault('purchase-readback-conflict');
    }
    this.store.cachePurchase(desired.id, desired);
    this.store.operationState(operationId, 'complete');
  }
  async apply(
    operationId: string,
    expected: Transaction,
    desired: Transaction,
  ): Promise<void> {
    const comparable = (t: Transaction | undefined) =>
      t
        ? canonical({
            ...t,
            children: [...t.children].sort((a, b) => a.id.localeCompare(b.id)),
          })
        : canonical(t);
    const immutable = (t: Transaction) => ({
      id: t.id,
      account: t.account,
      date: t.date,
      amount: t.amount,
      payee: t.payee,
      imported: t.imported,
      transfer: t.transfer,
      starting: t.starting,
    });
    if (
      !expected.imported ||
      expected.transfer ||
      expected.starting ||
      canonical(immutable(expected)) !== canonical(immutable(desired))
    )
      throw new Fault('transaction-boundary');
    const cats = new Set((await this.ledger.categories()).map((c) => c.id));
    if (desired.children.length)
      validateAllocations(
        desired.amount,
        desired.children.map((c) => ({
          category: c.category ?? '',
          amount: c.amount,
        })),
        cats,
      );
    else if (desired.category !== null && !cats.has(desired.category))
      throw new Fault('category-contract-drift');
    const op = this.store.prepare(
      operationId,
      'transaction',
      expected,
      desired,
    );
    if (op.state === 'complete') return;
    await this.ledger.sync();
    const current = (await this.ledger.transactions()).find(
      (t) => t.id === expected.id,
    );
    if (comparable(current) === comparable(desired)) {
      this.store.operationState(operationId, 'complete');
      return;
    }
    if (comparable(current) !== comparable(expected)) {
      this.store.operationState(operationId, 'attention');
      throw new Fault('transaction-conflict');
    }
    this.store.operationState(operationId, 'applying');
    try {
      await this.ledger.update(expected, desired);
      await this.ledger.sync();
    } catch {
      throw new Fault('transaction-write-uncertain', true);
    }
    const readback = (await this.ledger.transactions()).find(
      (t) => t.id === expected.id,
    );
    if (comparable(readback) !== comparable(desired)) {
      this.store.operationState(operationId, 'attention');
      throw new Fault('transaction-readback-conflict');
    }
    this.store.operationState(operationId, 'complete');
  }
  desired(
    t: Transaction,
    allocations: Allocation[],
    purchase?: Purchase,
    detailUrl?: string,
  ): Transaction {
    if (t.children.some((c) => c.notes.trim()))
      throw new Fault('split-notes-preservation-required');
    const desired: Transaction = {
      ...t,
      notes: purchase
        ? withPurchaseNote(t.notes, purchase, detailUrl)
        : t.notes,
    };
    if (allocations.length === 1) {
      desired.category = allocations[0]!.category;
      desired.children = [];
    }
    if (allocations.length > 1) {
      desired.category = null;
      desired.children = allocations.map((a, i) => ({
        id: `${key('split', t.id, hash(allocations), String(i)).slice(0, 8)}-${key(t.id, String(i)).slice(0, 4)}-4${key(t.id, String(i)).slice(5, 8)}-a${key(t.id, String(i)).slice(9, 12)}-${key(t.id, String(i)).slice(12, 24)}`,
        amount: a.amount,
        category: a.category,
        notes: '',
      }));
    }
    return desired;
  }
}
