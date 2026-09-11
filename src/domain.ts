import { createHash } from 'node:crypto';
import { z } from 'zod';

export const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/);
export const text = z
  .string()
  .max(8000)
  .refine((s) => !s.includes('\0'));
export const minor = z.number().int().safe().min(-100_000_000).max(100_000_000);
export const date = z.iso.date();
export const sourceSchema = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.url().refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password;
  }),
  mediaType: z.string().max(100),
  messageId: id,
});
export const itemSchema = z.strictObject({
  description: z.string().min(1).max(1000).nullable(),
  quantity: z.number().finite().min(0).max(100000).nullable(),
  unitPrice: minor.nullable(),
  amount: minor.nullable(),
});
export const factsSchema = z.strictObject({
  merchant: z.string().min(1).max(300).nullable(),
  date: date.nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  total: minor.nullable(),
  subtotal: minor.nullable(),
  tax: minor.nullable(),
  tip: minor.nullable().default(null),
  shipping: minor.nullable(),
  discount: minor.nullable(),
  reference: z.string().max(200).nullable(),
  payment: z.enum(['card', 'cash', 'unknown', 'split']),
  items: z.array(itemSchema).max(500),
});
export const allocationSchema = z.strictObject({ category: id, amount: minor });
export const purchaseSchema = factsSchema.extend({
  schema: z.literal('purchase.v2'),
  id,
  revision: z.number().int().positive(),
  state: z.enum(['pending', 'linked', 'attention', 'recorded', 'discarded']),
  sources: z.array(sourceSchema).min(1).max(50),
  annotations: z
    .array(
      z.strictObject({
        speaker: id,
        messageId: id,
        at: z.iso.datetime(),
        text,
      }),
    )
    .max(200),
  provenance: z.strictObject({
    method: z.string().max(100),
    model: z.string().max(100).nullable(),
    at: z.iso.datetime(),
  }),
  transactions: z
    .array(z.strictObject({ id, account: id, amount: minor }))
    .max(20),
  allocations: z.array(allocationSchema).max(50),
  // Imported historical evidence is retained, not interpreted by the runtime.
  evidence: z.record(z.string(), z.unknown()).optional(),
});
export type Purchase = z.infer<typeof purchaseSchema>;
export type Facts = z.infer<typeof factsSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export interface Transaction {
  id: string;
  account: string;
  date: string;
  amount: number;
  payee: string | null;
  merchant: string;
  importedMerchant?: string;
  notes: string;
  category: string | null;
  imported: boolean;
  transfer: boolean;
  starting: boolean;
  children: Array<{
    id: string;
    amount: number;
    category: string | null;
    notes: string;
  }>;
}
export const PURCHASE_PREFIX = 'household-purchase:v2:';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : canonical(value))
    .digest('hex');
}
export function key(...parts: string[]): string {
  return hash(parts);
}
export class Fault extends Error {
  constructor(
    readonly code: string,
    readonly retry = false,
  ) {
    super(code);
    this.name = 'Fault';
  }
}
export function parsePurchase(value: unknown): Purchase {
  if (Buffer.byteLength(canonical(value)) > 512 * 1024)
    throw new Fault('purchase-too-large');
  return purchaseSchema.parse(value);
}
export function validateAllocations(
  total: number,
  allocations: Allocation[],
  categories: ReadonlySet<string>,
): void {
  if (
    allocations.length === 0 ||
    allocations.some((a) => !categories.has(a.category)) ||
    allocations.reduce((n, a) => n + minor.parse(a.amount), 0) !== total
  )
    throw new Fault('invalid-allocation');
}
function line(value: string): string {
  return value.replace(/[\r\n[\]]/g, ' ').trim();
}
export function money(value: number | null, currency: string | null): string {
  return value === null
    ? 'amount unknown'
    : `${(value / 100).toFixed(2)} ${currency ?? 'currency unknown'}`;
}
export function purchaseDetails(p: Purchase): string {
  return [
    `Purchased at ${line(p.merchant ?? 'Unknown merchant')} — ${p.date ?? 'date unknown'}`,
    ...p.items.map(
      (i) =>
        `${line(i.description ?? 'Unknown item')}${i.quantity === null ? '' : ` × ${i.quantity}`}${i.amount === null ? ' (price unknown)' : ` = ${money(i.amount, p.currency)}`}`,
    ),
    ...(['tax', 'tip', 'shipping', 'discount'] as const)
      .filter((k) => p[k] !== null)
      .map((k) => `${k}: ${money(p[k]!, p.currency)}`),
    `Purchase total: ${money(p.total, p.currency)}`,
    ...(p.state === 'discarded'
      ? ['This purchase record is discarded.']
      : p.state === 'attention'
        ? ['Purchase details require review.']
        : []),
    ...p.annotations.map((a) => `Purpose/correction: ${line(a.text)}`),
    ...p.sources.map((s) => `Receipt: ${s.url}`),
  ].join('\n');
}
export function withPurchaseNote(
  notes: string,
  p: Purchase,
  detailUrl?: string,
): string {
  const start = `[purchase:${p.id}]`,
    end = `[/purchase:${p.id}]`;
  const begin = notes.indexOf(start),
    finish = notes.indexOf(end);
  if (
    (begin === -1) !== (finish === -1) ||
    (begin !== -1 &&
      (finish < begin || notes.indexOf(start, begin + start.length) !== -1))
  )
    throw new Fault('note-block-conflict');
  let details = purchaseDetails(p);
  if (details.length > 6500) {
    if (!detailUrl) throw new Fault('purchase-detail-link-required');
    details = `Purchased at ${line(p.merchant ?? 'Unknown merchant')} — ${p.date ?? 'date unknown'}\n${p.items.length} items; total ${money(p.total, p.currency)}\nComplete purchase details: ${detailUrl}`;
  }
  if (p.evidence?.historicalLinks)
    details +=
      '\nThis receipt changed after its original transaction link. Its details require review; the existing bank categorization is preserved.';
  if (p.transactions.length > 1)
    details +=
      '\nThis purchase is associated with multiple bank charges; the total above is for the whole purchase.';
  const block = `${start}\n${details}\n${end}`;
  const result =
    begin === -1
      ? `${notes}${notes ? '\n' : ''}${block}`
      : notes.slice(0, begin) + block + notes.slice(finish + end.length);
  if (result.length > 32000) throw new Fault('transaction-note-too-large');
  return result;
}
export function sameRecordedPurchase(
  existing: Purchase,
  incoming: Purchase,
): boolean {
  if (existing.id === incoming.id) return true;
  if (
    incoming.reference === null ||
    existing.reference !== incoming.reference ||
    existing.currency !== incoming.currency ||
    existing.merchant?.trim().toLowerCase() !==
      incoming.merchant?.trim().toLowerCase()
  )
    return false;
  if (incoming.date && existing.date && incoming.date !== existing.date)
    return false;
  if (
    incoming.total !== null &&
    existing.total !== null &&
    incoming.total !== existing.total
  )
    return false;
  return true;
}
export function matches(
  p: Purchase,
  transactions: Transaction[],
  currency: string,
): Transaction[][] {
  if (
    !p.date ||
    !p.merchant ||
    p.total === null ||
    p.currency !== currency ||
    p.payment === 'cash' ||
    p.payment === 'split' ||
    p.total === 0
  )
    return [];
  const terms = p.merchant.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const day = Date.parse(p.date),
    total = p.total;
  const candidates = transactions.filter(
    (t) =>
      t.imported &&
      !t.transfer &&
      !t.starting &&
      !t.notes.includes('[purchase:') &&
      Date.parse(t.date) >= day &&
      Date.parse(t.date) <= day + 7 * 86400000 &&
      Math.sign(t.amount) === -Math.sign(total) &&
      terms.some((term) => t.merchant.toLowerCase().includes(term)),
  );
  // A bounded search must not report uniqueness after truncating candidates.
  if (candidates.length > 16) throw new Fault('too-many-match-candidates');
  const found: Transaction[][] = [];
  function visit(at: number, picked: Transaction[], sum: number): void {
    if (found.length > 1) return;
    if (picked.length && sum === -total) {
      found.push(picked);
      return;
    }
    if (picked.length === 6) return;
    for (let i = at; i < candidates.length; i++) {
      const t = candidates[i]!;
      if (picked.length && picked[0]!.account !== t.account) continue;
      if (Math.abs(sum + t.amount) > Math.abs(total)) continue;
      visit(i + 1, [...picked, t], sum + t.amount);
    }
  }
  visit(0, [], 0);
  return found;
}

// Models choose category labels. Code derives every split cent from evidence.
export function itemAllocations(
  p: Purchase,
  labels: Array<{ index: number; category: string }>,
  allowed: ReadonlySet<string>,
): Allocation[] {
  if (
    p.total === null ||
    !p.items.length ||
    labels.length !== p.items.length ||
    new Set(labels.map((l) => l.index)).size !== p.items.length ||
    labels.some(
      (l) =>
        l.index < 0 || l.index >= p.items.length || !allowed.has(l.category),
    ) ||
    p.items.some((i) => i.amount === null)
  )
    throw new Fault('item-allocation-evidence');
  const subtotal = p.items.reduce((n, i) => n + i.amount!, 0);
  const extras = (p.tax ?? 0) + (p.tip ?? 0) + (p.shipping ?? 0);
  const discount = p.discount ?? 0;
  const overhead =
    subtotal + extras === p.total
      ? extras
      : subtotal + extras - discount === p.total
        ? extras - discount
        : null;
  if (
    subtotal === 0 ||
    overhead === null ||
    (p.subtotal !== null && p.subtotal !== subtotal)
  )
    throw new Fault('item-allocation-evidence');
  const categories = new Map<string, number>();
  for (const label of labels)
    categories.set(
      label.category,
      (categories.get(label.category) ?? 0) + p.items[label.index]!.amount!,
    );
  const rows = [...categories]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, amount]) => ({
      category,
      amount,
      share: Math.trunc((overhead * amount) / subtotal),
    }));
  let remainder = overhead - rows.reduce((n, r) => n + r.share, 0);
  for (let i = 0; remainder !== 0; i = (i + 1) % rows.length) {
    const delta = Math.sign(remainder);
    rows[i]!.share += delta;
    remainder -= delta;
  }
  const allocations = rows.map((r) => ({
    category: r.category,
    amount: -(r.amount + r.share),
  }));
  validateAllocations(-p.total, allocations, allowed);
  return allocations;
}
