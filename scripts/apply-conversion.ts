// Offline only: the installed application never imports predecessor formats.
import { canonical, hash } from '../src/domain.js';
import type { Store } from '../src/store.js';
import { protectedHash, snapshotSchema } from './conversion.js';
import type { Change, Conversion, Snapshot } from './conversion.js';

export interface ConversionTarget {
  snapshot(): Promise<Snapshot>;
  current?(change: Change): Promise<string | null>;
  note(id: string, value: string): Promise<void>;
  transactionNote(id: string, value: string): Promise<void>;
  detail(url: string, body: string): Promise<void>;
}
function transactions(
  snapshot: Snapshot,
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const parent of snapshot.transactions) {
    for (const row of [
      parent,
      ...(Array.isArray(parent.subtransactions) ? parent.subtransactions : []),
    ]) {
      const t = row as Record<string, unknown>;
      const id = String(t.id);
      if (result.has(id)) throw new Error('duplicate-transaction-identity');
      result.set(id, t);
    }
  }
  return result;
}
function current(snapshot: Snapshot, change: Change): string | null {
  if (change.kind === 'note')
    return snapshot.notes.find((n) => n.id === change.id)?.note ?? null;
  const row = transactions(snapshot).get(change.id);
  if (!row) throw new Error('conversion-transaction-missing');
  return typeof row.notes === 'string' ? row.notes : null;
}
function normalized(snapshot: Snapshot): unknown {
  // Read order and capture time are not ledger data. Everything else is checked.
  const sort = (
    rows: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> =>
    rows
      .map<Record<string, unknown>>((row) => ({
        ...row,
        ...(Array.isArray(row.subtransactions)
          ? {
              subtransactions: sort(
                row.subtransactions as Array<Record<string, unknown>>,
              ),
            }
          : {}),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    accounts: sort(snapshot.accounts),
    transactions: sort(snapshot.transactions),
    categories: sort(snapshot.categories),
    rules: sort(snapshot.rules),
    schedules: sort(snapshot.schedules),
    notes: sort(snapshot.notes.filter((n) => n.note !== null && n.note !== '')),
  };
}
export function expectedSnapshot(source: Snapshot, plan: Conversion): Snapshot {
  const result = structuredClone(source),
    rows = transactions(result);
  for (const c of plan.changes) {
    if (c.kind === 'note') {
      const note = result.notes.find((n) => n.id === c.id);
      if (note) note.note = c.desired;
      else result.notes.push({ id: c.id, note: c.desired });
    } else {
      const row = rows.get(c.id);
      if (!row) throw new Error('conversion-transaction-missing');
      row.notes = c.desired;
    }
  }
  return result;
}
export async function applyConversion(
  source: Snapshot,
  plan: Conversion,
  store: Store,
  target: ConversionTarget,
): Promise<{ operations: number; verified: true }> {
  if (
    hash(source) !== plan.sourceHash ||
    protectedHash(source) !== plan.protectedHash
  )
    throw new Error('conversion-source-mismatch');
  const expected = expectedSnapshot(source, plan);
  const before = snapshotSchema.parse(await target.snapshot());
  const merged = structuredClone(source),
    rows = transactions(merged);
  // Refuse all unsupported predecessor states before the first external write.
  for (const c of plan.changes) {
    const value = current(before, c);
    if (
      value !== c.expected &&
      value !== c.desired &&
      !(c.reason === 'retire' && value === null)
    )
      throw new Error('conversion-predecessor-conflict');
    if (c.kind === 'note') {
      const note = merged.notes.find((n) => n.id === c.id);
      if (note) note.note = value;
      else if (value !== null) merged.notes.push({ id: c.id, note: value });
    } else rows.get(c.id)!.notes = value;
  }
  if (canonical(normalized(merged)) !== canonical(normalized(before)))
    throw new Error('conversion-unplanned-data-change');
  for (const detail of plan.details)
    await target.detail(detail.url, detail.body);
  for (const c of plan.changes) {
    const opId = hash({ conversion: plan.sourceHash, kind: c.kind, id: c.id });
    store.prepare(opId, 'conversion', c.expected, c.desired);
    const value = target.current
      ? await target.current(c)
      : current(snapshotSchema.parse(await target.snapshot()), c);
    if (value === c.desired || (c.reason === 'retire' && value === null)) {
      store.operationState(opId, 'complete');
      continue;
    }
    if (value !== c.expected) {
      store.operationState(opId, 'attention');
      throw new Error('conversion-concurrent-change');
    }
    store.operationState(opId, 'applying');
    if (c.kind === 'note') await target.note(c.id, c.desired);
    else await target.transactionNote(c.id, c.desired);
    const readback = target.current
      ? await target.current(c)
      : current(snapshotSchema.parse(await target.snapshot()), c);
    if (readback !== c.desired && !(c.reason === 'retire' && readback === null))
      throw new Error('conversion-readback-failed');
    store.operationState(opId, 'complete');
  }
  const after = snapshotSchema.parse(await target.snapshot());
  if (canonical(normalized(after)) !== canonical(normalized(expected)))
    throw new Error('conversion-preservation-failed');
  return { operations: plan.changes.length, verified: true };
}
