import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { factsSchema, Fault } from './domain.js';
import type { Facts } from './domain.js';

export const MAX_FILE = 12 * 1024 * 1024;
export function cents(value: unknown): number {
  const s = String(value).trim().replace(/,/g, '');
  const m = /^(-?)(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Fault('invalid-money');
  return (
    (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0')))
  );
}
export function sniff(bytes: Buffer): string {
  if (bytes.length > MAX_FILE) throw new Fault('file-too-large');
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WAVE'
  )
    return 'audio/wav';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'audio/mp4';
  if (
    bytes.subarray(0, 3).toString() === 'ID3' ||
    (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
  )
    return 'audio/mpeg';
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Fault('unsupported-file');
  }
  if (value.includes('\0') || bytes.length > 512 * 1024)
    throw new Fault('unsupported-file');
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{'))
    return 'application/json';
  return trimmed.includes('\t')
    ? 'text/tab-separated-values'
    : trimmed.includes(',')
      ? 'text/csv'
      : 'text/plain';
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Fault('export-schema');
  return v as Record<string, unknown>;
}
function nullableMoney(v: unknown): number | null {
  return v === undefined || v === null || v === '' ? null : cents(v);
}
export function amazon(bytes: Buffer): Facts[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Fault('invalid-json');
  }
  if (
    !Array.isArray(json) ||
    !json.length ||
    !json.every(
      (v) =>
        v &&
        typeof v === 'object' &&
        'orderId' in v &&
        'orderDate' in v &&
        'totalAmount' in v &&
        'items' in v,
    )
  )
    return undefined;
  if (json.length > 100) throw new Fault('export-order-limit');
  return json.map((v) => {
    const r = object(v);
    if (!Array.isArray(r.items)) throw new Fault('export-schema');
    return factsSchema.parse({
      merchant: 'Amazon',
      date: r.orderDate,
      currency: r.currency,
      total: cents(r.totalAmount),
      subtotal: null,
      tax: null,
      shipping: null,
      discount: nullableMoney(r.totalSavings),
      reference: r.orderId,
      payment: 'unknown',
      items: r.items.map((v) => {
        const i = object(v);
        // The export's price is retained as reported unit-price evidence. Do not
        // infer item totals when quantity/discount semantics are undocumented.
        return {
          description: i.title,
          quantity: typeof i.quantity === 'number' ? i.quantity : null,
          unitPrice: nullableMoney(i.price),
          amount: null,
        };
      }),
    });
  });
}
export function csv(value: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted) {
      if (c === '"') {
        if (value[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field || closed) throw new Fault('invalid-csv');
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      closed = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && value[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
      closed = false;
    } else {
      if (closed) throw new Fault('invalid-csv');
      field += c;
    }
    if (rows.length > 5000 || field.length > 100000)
      throw new Fault('export-size-limit');
  }
  if (quoted) throw new Fault('invalid-csv');
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function list(v: unknown): unknown[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
function xml(value: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Fault('unsafe-xml');
  return object(
    new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
    }).parse(value),
  );
}
export function xlsx(bytes: Buffer): string[][] {
  let size = 0,
    count = 0;
  const files = unzipSync(bytes, {
    filter: (file) => {
      size += file.originalSize;
      count++;
      if (
        count > 200 ||
        file.originalSize > 4 * 1024 * 1024 ||
        size > 16 * 1024 * 1024
      )
        throw new Fault('spreadsheet-size-limit');
      return /^(?:xl\/sharedStrings.xml|xl\/worksheets\/sheet\d+.xml)$/.test(
        file.name,
      );
    },
  });
  const strings: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    const sst = object(xml(strFromU8(files['xl/sharedStrings.xml'])).sst);
    for (const value of list(sst.si)) {
      const si = object(value);
      strings.push(
        si.t !== undefined
          ? String(si.t)
          : list(si.r)
              .map((r) => String(object(r).t ?? ''))
              .join(''),
      );
    }
  }
  const rows: string[][] = [];
  for (const name of Object.keys(files)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort()) {
    const sheet = object(xml(strFromU8(files[name]!)).worksheet);
    const data = object(sheet.sheetData ?? {});
    for (const r of list(data.row)) {
      const row: string[] = [];
      for (const c of list(object(r).c)) {
        const cell = object(c);
        if (cell.f !== undefined)
          throw new Fault('spreadsheet-formula-not-supported');
        const ref = /^([A-Z]{1,3})\d+$/.exec(String(cell['@_r'] ?? ''));
        if (!ref) throw new Fault('spreadsheet-cell-reference');
        let column = 0;
        for (const ch of ref[1]!) column = column * 26 + ch.charCodeAt(0) - 64;
        if (column > 100) throw new Fault('spreadsheet-column-limit');
        while (row.length < column) row.push('');
        row[column - 1] =
          cell['@_t'] === 's'
            ? (strings[Number(cell.v)] ?? '')
            : cell['@_t'] === 'inlineStr'
              ? String(object(cell.is).t ?? '')
              : String(cell.v ?? '');
      }
      rows.push(row);
      if (rows.length > 5000) throw new Fault('spreadsheet-row-limit');
    }
  }
  if (!rows.length) throw new Fault('invalid-spreadsheet');
  return rows;
}
export function tabular(rows: string[][]): Facts[] | undefined {
  const header = rows[0]?.map((s) => s.trim().toLowerCase());
  if (
    !header ||
    !['merchant', 'date', 'currency', 'total'].every((k) => header.includes(k))
  )
    return undefined;
  if (rows.length > 101) throw new Fault('export-order-limit');
  return rows.slice(1).map((row) => {
    const r = Object.fromEntries(header.map((k, i) => [k, row[i] ?? '']));
    return factsSchema.parse({
      merchant: r.merchant,
      date: r.date,
      currency: r.currency,
      total: cents(r.total),
      subtotal: nullableMoney(r.subtotal),
      tax: nullableMoney(r.tax),
      shipping: nullableMoney(r.shipping),
      discount: nullableMoney(r.discount),
      reference: r.reference || null,
      payment: 'unknown',
      items: r.description
        ? [
            {
              description: r.description,
              quantity: null,
              unitPrice: null,
              amount: null,
            },
          ]
        : [],
    });
  });
}
export interface Prepared {
  type: 'facts' | 'text' | 'images';
  facts?: Facts[];
  text?: string;
  images?: string[];
  mediaType: string;
}
export function prepareExport(
  bytes: Buffer,
  type: string,
): Prepared | undefined {
  if (type === 'application/json') {
    const facts = amazon(bytes);
    return facts
      ? { type: 'facts', facts, mediaType: type }
      : { type: 'text', text: bytes.toString('utf8'), mediaType: type };
  }
  if (type.includes('spreadsheetml')) {
    const rows = xlsx(bytes);
    const facts = tabular(rows);
    return facts
      ? { type: 'facts', facts, mediaType: type }
      : { type: 'text', text: JSON.stringify(rows), mediaType: type };
  }
  if (type.startsWith('text/')) {
    const value = bytes.toString('utf8');
    const rows = csv(value, type === 'text/tab-separated-values' ? '\t' : ',');
    const facts = tabular(rows);
    return facts
      ? { type: 'facts', facts, mediaType: type }
      : { type: 'text', text: value, mediaType: type };
  }
  return undefined;
}
