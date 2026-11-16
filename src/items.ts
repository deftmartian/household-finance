import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Fault, id } from './domain.js';
import { merchantTokens } from './matching.js';

export const itemEntrySchema = z.strictObject({
  merchant: z.string().min(1).max(300),
  key: z.string().min(1).max(300),
  category: id,
  updatedAt: z.iso.datetime(),
});
export const itemMapSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(itemEntrySchema).max(100000),
});
export type ItemMap = z.infer<typeof itemMapSchema>;
export type ItemEntry = z.infer<typeof itemEntrySchema>;

export function normalizeMerchant(value: string | null | undefined): string {
  return merchantTokens(value).join(' ');
}
// A leading 5-7 digit number is a store item number; otherwise the words.
export function itemKey(description: string | null | undefined): string {
  const text = (description ?? '').trim();
  const number = /^(\d{5,7})(?!\d)/.exec(text);
  if (number) return number[1]!;
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(' ');
}
export function loadItems(path: string): ItemMap {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, entries: [] };
    throw new Fault('item-map-unreadable');
  }
  try {
    return itemMapSchema.parse(JSON.parse(raw));
  } catch {
    throw new Fault('item-map-invalid');
  }
}
export function saveItems(path: string, map: ItemMap): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify(itemMapSchema.parse(map), null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
export function lookup(
  map: ItemMap,
  merchant: string | null,
  description: string | null,
): ItemEntry | undefined {
  const m = normalizeMerchant(merchant),
    k = itemKey(description);
  return m && k
    ? map.entries.find((e) => e.merchant === m && e.key === k)
    : undefined;
}
export function upsert(
  map: ItemMap,
  merchant: string,
  key: string,
  category: string,
  at: string,
): ItemMap {
  const m = normalizeMerchant(merchant),
    k = itemKey(key);
  if (!m || !k) throw new Fault('invalid-item-key');
  const old = map.entries.find((e) => e.merchant === m && e.key === k);
  if (old?.category === category) return map;
  const entry = { merchant: m, key: k, category, updatedAt: at };
  const rest = map.entries.filter((e) => !(e.merchant === m && e.key === k));
  return {
    version: 1,
    entries: [...rest, entry].sort((a, b) =>
      (a.merchant + '\0' + a.key).localeCompare(b.merchant + '\0' + b.key),
    ),
  };
}
