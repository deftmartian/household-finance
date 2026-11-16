import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  itemKey,
  loadItems,
  lookup,
  normalizeMerchant,
  saveItems,
  upsert,
} from '../src/items.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const empty = { version: 1 as const, entries: [] };
const AT = '2026-09-06T12:00:00.000Z';

it('normalizes merchants and item keys', () => {
  expect(normalizeMerchant('Example Wholesale #123 INC')).toBe(
    'example wholesale',
  );
  expect(itemKey('1234567 SYNTHETIC WATER 40PK')).toBe('1234567');
  expect(itemKey('123456789 not an item number')).toBe(
    '123456789 not an item number',
  );
  expect(itemKey('Synthetic  Water, 40-pk!')).toBe('synthetic water 40 pk');
  expect(itemKey(null)).toBe('');
});
it('upserts by merchant and key, and looks up through normalization', () => {
  let map = upsert(empty, 'Example Wholesale #9', '1234567', 'food', AT);
  map = upsert(map, 'example wholesale', 'Garden Hose', 'home', AT);
  expect(
    lookup(map, 'EXAMPLE WHOLESALE INC', '1234567 SYNTHETIC WATER')?.category,
  ).toBe('food');
  expect(lookup(map, 'Example Wholesale', 'garden  hose')?.category).toBe(
    'home',
  );
  expect(lookup(map, 'Other Store', '1234567')).toBeUndefined();
  expect(upsert(map, 'example wholesale', '1234567', 'food', 'later')).toBe(
    map,
  );
  expect(
    upsert(map, 'example wholesale', '1234567', 'home', AT).entries,
  ).toHaveLength(2);
  expect(() => upsert(map, '#1', 'x', 'food', AT)).toThrow('invalid-item-key');
});
it('writes atomically with private permissions and rejects invalid files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'items-'));
  dirs.push(dir);
  const path = join(dir, 'item-map.json');
  expect(loadItems(path)).toEqual(empty);
  saveItems(path, upsert(empty, 'Example', '1234567', 'food', AT));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readdirSync(dir)).toEqual(['item-map.json']);
  expect(loadItems(path).entries[0]).toMatchObject({
    merchant: 'example',
    key: '1234567',
  });
  saveItems(path, { version: 1, entries: [] });
  expect(loadItems(path)).toEqual(empty);
  writeFileSync(path, '{"version":2}');
  expect(() => loadItems(path)).toThrow('item-map-invalid');
});
