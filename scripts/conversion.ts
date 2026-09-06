// One-time offline converter. This file is excluded from the runtime build.
import { z } from 'zod';
import {
  canonical,
  hash,
  parsePurchase,
  PURCHASE_PREFIX,
  purchaseDetails,
  withPurchaseNote,
} from '../src/domain.js';
import type { Purchase } from '../src/domain.js';

const raw = z.record(z.string(), z.unknown());
export const snapshotSchema = z
  .object({
    version: z.literal(1),
    at: z.string(),
    accounts: z.array(raw),
    transactions: z.array(raw),
    notes: z.array(z.object({ id: z.string(), note: z.string().nullable() })),
    categories: z.array(raw),
    rules: z.array(raw),
    schedules: z.array(raw),
  })
  .passthrough();
export type Snapshot = z.infer<typeof snapshotSchema>;
export interface Change {
  kind: 'note' | 'transaction-note';
  id: string;
  expected: string | null;
  desired: string;
  reason: 'publish' | 'link' | 'retire';
}
export interface Conversion {
  schema: 'conversion.v2';
  sourceHash: string;
  protectedHash: string;
  purchases: Purchase[];
  changes: Change[];
  details: Array<{ url: string; body: string }>;
  counts: {
    receipts: number;
    discarded: number;
    linkedTransactions: number;
    historicalRevisions: number;
  };
}
function rec(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('unsupported-predecessor-object');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('unsupported-predecessor-list');
  return value;
}
function nullableText(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function nullableNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}
function fileUrl(base: string, path: string): string {
  if (
    path.split('/').some((p) => p === '..' || p === '.') ||
    path.startsWith('/')
  )
    throw new Error('unsafe-source-path');
  return `${base.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
const legacyPrefix = 'household-finance:receipt:';
const tokens =
  /\[\[household-finance:receipt-link:v1:([0-9a-f-]{36}):([0-9a-f]{64})\]\]/gi;
function predecessorCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(predecessorCanonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
        .map(([k, v]) => [k, predecessorCanonical(v)]),
    );
  return value;
}
function links(notes: string): Array<{ id: string; hash: string }> {
  return [...notes.matchAll(tokens)].map((m) => ({
    id: m[1]!.toLowerCase(),
    hash: m[2]!.toLowerCase(),
  }));
}
export function protectedHash(snapshot: Snapshot): string {
  const transaction = (t: Record<string, unknown>): unknown => {
    const { notes, subtransactions, ...rest } = t;
    void notes;
    return {
      ...rest,
      ...(Array.isArray(subtransactions)
        ? { subtransactions: subtransactions.map((c) => transaction(rec(c))) }
        : {}),
    };
  };
  return hash({
    accounts: snapshot.accounts,
    transactions: snapshot.transactions.map(transaction),
    categories: snapshot.categories,
    rules: snapshot.rules,
    schedules: snapshot.schedules,
    otherNotes: snapshot.notes.filter(
      (n) =>
        !n.id.startsWith(legacyPrefix) && !n.id.startsWith(PURCHASE_PREFIX),
    ),
  });
}
export function planConversion(
  value: unknown,
  archiveBase: string,
  detailDirectory = 'Finance/Receipts/Purchase Details',
): Conversion {
  const snapshot = snapshotSchema.parse(value);
  const origin = new URL(archiveBase);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('unsafe-archive-base');
  const purchases: Purchase[] = [];
  const changes: Change[] = [];
  const details: Array<{ url: string; body: string }> = [];
  const receiptNotes = snapshot.notes.filter(
    (n) => n.id.startsWith(legacyPrefix) && n.note,
  );
  for (const note of receiptNotes) {
    const old = rec(JSON.parse(note.note!));
    if (
      old.schemaVersion !== 'household-finance.receipt.v1' ||
      note.id !== legacyPrefix + old.receiptId ||
      !['active', 'discarded'].includes(String(old.status))
    )
      throw new Error('unsupported-receipt-schema');
    const sources = list(old.sources).map((v) => {
      const s = rec(v),
        talk = rec(s.talk);
      return {
        hash: s.sha256,
        url: fileUrl(archiveBase, String(s.archivePath)),
        mediaType: s.mediaType,
        messageId: talk.messageId,
      };
    });
    const amounts = old.amounts ? rec(old.amounts) : {},
      extraction = old.extraction ? rec(old.extraction) : {};
    const annotations = Array.isArray(old.householdNotes)
      ? old.householdNotes.map((v) => {
          const n = rec(v),
            t = rec(n.talk);
          return {
            speaker: t.actorId,
            messageId: t.messageId,
            at: n.receivedAt,
            text: n.text,
          };
        })
      : [];
    const p = parsePurchase({
      schema: 'purchase.v2',
      id: old.receiptId,
      revision: 1,
      state:
        old.status === 'discarded'
          ? 'discarded'
          : extraction.automaticProcessingBlocked
            ? 'attention'
            : 'pending',
      merchant: nullableText(old.merchant),
      date: nullableText(old.purchaseDate),
      currency: nullableText(old.currency),
      total: nullableNumber(amounts.totalMinor),
      subtotal: nullableNumber(amounts.subtotalMinor),
      tax: nullableNumber(amounts.taxMinor),
      tip: nullableNumber(amounts.tipMinor),
      discount: nullableNumber(amounts.discountMinor),
      shipping: null,
      reference: nullableText(old.receiptReference),
      payment:
        old.paymentEvidence && rec(old.paymentEvidence).kind === 'cash'
          ? 'cash'
          : old.paymentEvidence &&
              rec(old.paymentEvidence).kind === 'masked-card'
            ? 'card'
            : 'unknown',
      items: Array.isArray(old.items)
        ? old.items.map((v) => {
            const i = rec(v);
            return {
              description: nullableText(i.description),
              quantity: nullableNumber(i.quantity),
              unitPrice: nullableNumber(i.unitPriceMinor),
              amount: nullableNumber(i.totalMinor),
            };
          })
        : [],
      sources,
      annotations,
      provenance: {
        method: 'preserved-receipt',
        model: nullableText(extraction.resolvedModel),
        at: nullableText(extraction.extractedAt) ?? String(old.updatedAt),
      },
      transactions: [],
      allocations: [],
      evidence: { originalRecord: old },
    });
    purchases.push(p);
  }
  const byId = new Map(purchases.map((p) => [p.id, p]));
  const historicalRevisions = new Set<string>();
  for (const t of snapshot.transactions) {
    const children = Array.isArray(t.subtransactions)
      ? t.subtransactions.map(rec)
      : [];
    const all = [t, ...children];
    const related = new Map<string, Purchase>();
    for (const row of all) {
      const notes = typeof row.notes === 'string' ? row.notes : '';
      if (
        notes.replace(tokens, '').includes('[[household-finance:receipt-link:')
      )
        throw new Error('malformed-receipt-link');
      for (const link of links(notes)) {
        const p = byId.get(link.id);
        if (!p) throw new Error('orphan-receipt-link');
        if (
          hash(
            JSON.stringify(predecessorCanonical(p.evidence!.originalRecord)),
          ) !== link.hash
        ) {
          // The old token establishes an association, but cannot establish that
          // the current receipt facts were the revision used for categorization.
          // Preserve the exact reference as evidence and prohibit automatic work.
          historicalRevisions.add(p.id);
          const references = (p.evidence!.historicalLinks ?? []) as Array<{
            transaction: string;
            recordHash: string;
          }>;
          if (
            !references.some(
              (r) =>
                r.transaction === String(row.id) && r.recordHash === link.hash,
            )
          )
            references.push({
              transaction: String(row.id),
              recordHash: link.hash,
            });
          p.evidence!.historicalLinks = references;
          if (p.state !== 'discarded') p.state = 'attention';
        }
        related.set(p.id, p);
        if (!p.transactions.some((x) => x.id === String(t.id)))
          p.transactions.push({
            id: String(t.id),
            account: String(t.account),
            amount: Number(t.amount),
          });
        if (p.state !== 'discarded' && !historicalRevisions.has(p.id))
          p.state = 'linked';
      }
    }
    if (!related.size) continue;
    let parentNotes = typeof t.notes === 'string' ? t.notes : '';
    parentNotes = parentNotes.replace(tokens, '');
    for (const p of related.values()) {
      const body = purchaseDetails(p);
      let detailUrl: string | undefined;
      if (body.length > 6500) {
        detailUrl = fileUrl(archiveBase, `${detailDirectory}/${p.id}-1.txt`);
        if (!details.some((d) => d.url === detailUrl))
          details.push({ url: detailUrl, body });
      }
      parentNotes = withPurchaseNote(parentNotes, p, detailUrl);
    }
    changes.push({
      kind: 'transaction-note',
      id: String(t.id),
      expected: typeof t.notes === 'string' ? t.notes : null,
      desired: parentNotes,
      reason: 'link',
    });
    for (const child of children) {
      const notes = typeof child.notes === 'string' ? child.notes : null;
      if (notes && links(notes).length)
        changes.push({
          kind: 'transaction-note',
          id: String(child.id),
          expected: notes,
          desired: notes.replace(tokens, ''),
          reason: 'link',
        });
    }
  }
  for (const p of purchases) {
    const newId = PURCHASE_PREFIX + p.id;
    const existing = snapshot.notes.find((n) => n.id === newId)?.note ?? null;
    const desired = canonical(p);
    if (existing !== null && existing !== desired)
      throw new Error('new-purchase-note-conflict');
    if (existing !== desired)
      changes.unshift({
        kind: 'note',
        id: newId,
        expected: null,
        desired,
        reason: 'publish',
      });
  }
  for (const note of receiptNotes)
    changes.push({
      kind: 'note',
      id: note.id,
      expected: note.note,
      desired: '',
      reason: 'retire',
    });
  return {
    schema: 'conversion.v2',
    sourceHash: hash(snapshot),
    protectedHash: protectedHash(snapshot),
    purchases,
    changes,
    details,
    counts: {
      receipts: purchases.length,
      discarded: purchases.filter((p) => p.state === 'discarded').length,
      linkedTransactions: changes.filter((c) => c.kind === 'transaction-note')
        .length,
      historicalRevisions: historicalRevisions.size,
    },
  };
}
