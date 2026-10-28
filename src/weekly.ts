import type { Purchase, Transaction } from './domain.js';

export interface BankHealth {
  account: string;
  name: string;
  bank: string | null;
  ok: boolean;
  lastSync: string | null;
}
export interface BudgetCategory {
  id: string;
  name: string;
  income: boolean;
  budgeted: number;
  spent: number;
  balance: number;
}

const DAY = 86400000;
// Saturday 09:00 local. A missed run is not started more than three days late.
const HOUR = 9,
  LATEST = 3 * DAY;
export const RECHECK = 4 * 3600000;
export const DEADLINE = 3 * DAY;

function offset(at: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return local - Math.floor(at / 1000) * 1000;
}
export function localDate(at: number, timezone: string): string {
  return new Date(at + offset(at, timezone)).toISOString().slice(0, 10);
}
/** The weekly run that is currently due, if any. */
export function dueWeek(
  now: number,
  timezone: string,
): { saturday: string; at: number } | null {
  const today = localDate(now, timezone);
  const back = (new Date(today + 'T00:00:00Z').getUTCDay() + 1) % 7;
  const saturday = shift(today, -back);
  const at =
    Date.parse(saturday + 'T00:00:00Z') +
    HOUR * 3600000 -
    offset(now, timezone);
  if (now < at) return null;
  return now - at <= LATEST ? { saturday, at } : null;
}
export function shift(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY)
    .toISOString()
    .slice(0, 10);
}
export function staleBanks(health: BankHealth[]): string[] {
  return [
    ...new Set(health.filter((h) => !h.ok).map((h) => h.bank ?? h.name)),
  ].sort();
}
export function nudgeText(banks: string[]): string {
  return [
    'Weekly check: these bank logins need refreshing before I can pull this week’s transactions:',
    ...banks.map((b) => `- ${b}`),
    '',
    'Log in again at SimpleFIN Bridge (https://beta-bridge.simplefin.org), then reply to this message and I’ll send the weekly summary. If I don’t hear back by Tuesday, I’ll send it with the older data.',
  ].join('\n');
}
function dollars(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(
    cents / 100,
  );
}
function day(date: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(Date.parse(date + 'T00:00:00Z'));
}
export function uncategorized(
  transactions: Transaction[],
  accounts: ReadonlySet<string>,
): Transaction[] {
  return transactions
    .filter(
      (t) =>
        accounts.has(t.account) &&
        t.imported &&
        !t.transfer &&
        !t.starting &&
        !t.category &&
        !t.children.length,
    )
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
export function summaryText(input: {
  start: string;
  end: string;
  currency: string;
  accounts: ReadonlySet<string>;
  transactions: Transaction[];
  categories: Array<{ id: string; name: string }>;
  budget: BudgetCategory[];
  purchases: Purchase[];
  stale: string[];
}): string {
  const { start, end, currency } = input;
  const money = (n: number) => dollars(n, currency);
  const income = new Set(input.budget.filter((c) => c.income).map((c) => c.id));
  const names = new Map(input.categories.map((c) => [c.id, c.name]));
  const week = input.transactions.filter(
    (t) =>
      input.accounts.has(t.account) &&
      !t.transfer &&
      !t.starting &&
      t.date >= start &&
      t.date <= end,
  );
  const byCategory = new Map<string, number>();
  for (const t of week)
    for (const part of t.children.length
      ? t.children
      : [{ category: t.category, amount: t.amount }]) {
      if (part.category && income.has(part.category)) continue;
      const name = part.category
        ? (names.get(part.category) ?? 'Other')
        : 'Not yet categorized';
      byCategory.set(name, (byCategory.get(name) ?? 0) - part.amount);
    }
  const spending = [...byCategory]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = spending.reduce((n, [, v]) => n + v, 0);
  const lines = [`Weekly summary for ${day(start)}–${day(end)}`];
  if (input.stale.length)
    lines.push(
      `Bank data is incomplete: ${input.stale.join(', ')} still need a login, so recent transactions there may be missing.`,
    );
  lines.push('');
  lines.push(
    spending.length
      ? `Spent ${money(total)} this week. Top: ${spending
          .slice(0, 5)
          .map(([name, n]) => `${name} ${money(n)}`)
          .join(', ')}.`
      : 'No spending was imported for this week.',
  );
  const biggest = week
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.amount - b.amount || a.id.localeCompare(b.id))
    .slice(0, 3);
  if (biggest.length)
    lines.push(
      `Biggest: ${biggest.map((t) => `${t.merchant || 'Unknown'} ${money(-t.amount)} (${day(t.date)})`).join(', ')}.`,
    );
  const expense = input.budget.filter((c) => !c.income);
  if (expense.length) {
    const budgeted = expense.reduce((n, c) => n + c.budgeted, 0);
    const spent = -expense.reduce((n, c) => n + c.spent, 0);
    const over = expense
      .filter((c) => c.balance < 0)
      .sort((a, b) => a.balance - b.balance)
      .slice(0, 3);
    lines.push(
      `Month to date: ${money(spent)} spent of ${money(budgeted)} budgeted.` +
        (over.length
          ? ` Over budget: ${over.map((c) => `${c.name} by ${money(-c.balance)}`).join(', ')}.`
          : ' Every category is within budget.'),
    );
  }
  const open = uncategorized(input.transactions, input.accounts);
  const pending = input.purchases.filter((p) => p.state === 'pending').length;
  const attention = input.purchases.filter(
    (p) => p.state === 'attention',
  ).length;
  if (pending || attention)
    lines.push(
      `Receipts: ${pending} waiting for a bank charge, ${attention} need a look.`,
    );
  if (open.length) {
    lines.push('');
    lines.push(
      `${open.length} transaction${open.length === 1 ? '' : 's'} still need a category. Reply with the numbers, e.g. “1 groceries, 2 kids”:`,
    );
    open.slice(0, 8).forEach((t, i) => {
      lines.push(
        `${i + 1}. ${day(t.date)} ${t.merchant || 'Unknown'} ${money(-t.amount)}`,
      );
    });
    if (open.length > 8) lines.push(`…and ${open.length - 8} more.`);
  } else lines.push('Everything imported is categorized.');
  return lines.join('\n');
}
