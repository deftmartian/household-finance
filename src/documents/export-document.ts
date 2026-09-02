import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import {
  parsePreparedReceiptDocument,
  type PreparedReceiptDocument,
} from '../model/document.js';
import {
  isReceiptExportMediaType,
  type ReceiptDocumentMediaType,
  type ReceiptExportMediaType,
} from './receipt-media-types.js';

export const MAX_EXPORT_TEXT_BYTES = 512 * 1024;
const MAX_XLSX_ENTRIES = 64;
const MAX_XLSX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_ORDERS = 40;

export function sniffReceiptExportMediaType(
  bytes: Uint8Array,
): ReceiptExportMediaType | undefined {
  if (looksLikeXlsx(bytes)) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (looksLikeOleCompound(bytes)) {
    return 'application/vnd.ms-excel';
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    return undefined;
  }
  if (looksLikeJson(text)) {
    return 'application/json';
  }
  if (looksLikeDelimitedText(text, '\t')) {
    return 'text/tab-separated-values';
  }
  if (looksLikeDelimitedText(text, ',')) {
    return 'text/csv';
  }
  if (text.trim().length > 0) {
    return 'text/plain';
  }
  return undefined;
}

export function exportSniffMatchesDeclared(
  declared: ReceiptDocumentMediaType,
  sniffed: ReceiptDocumentMediaType | undefined,
): boolean {
  if (declared === sniffed) {
    return true;
  }
  if (!isReceiptExportMediaType(declared)) {
    return false;
  }
  if (declared === 'text/plain') {
    return (
      sniffed === 'application/json' ||
      sniffed === 'text/csv' ||
      sniffed === 'text/tab-separated-values' ||
      sniffed === 'text/plain'
    );
  }
  if (declared === 'application/vnd.ms-excel') {
    return (
      sniffed === 'text/csv' ||
      sniffed === 'text/tab-separated-values' ||
      sniffed === 'text/plain' ||
      sniffed === 'application/vnd.ms-excel' ||
      sniffed ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  }
  if (declared === 'text/csv' || declared === 'text/tab-separated-values') {
    return (
      sniffed === 'text/csv' ||
      sniffed === 'text/tab-separated-values' ||
      sniffed === 'text/plain' ||
      sniffed === 'application/json'
    );
  }
  if (declared === 'application/json') {
    return sniffed === 'application/json' || sniffed === 'text/plain';
  }
  return sniffed === declared;
}

export function convertExportToUtf8Text(
  bytes: Uint8Array,
  mediaType: ReceiptExportMediaType,
): string {
  if (
    mediaType ===
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return convertXlsxToTsv(bytes);
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new Error('export-invalid');
  }
  if (mediaType === 'application/vnd.ms-excel') {
    if (looksLikeOleCompound(bytes)) {
      throw new Error('export-invalid');
    }
    return boundExportText(text);
  }
  if (mediaType === 'application/json' || looksLikeJson(text)) {
    return boundExportText(prettyJson(text));
  }
  return boundExportText(stripBom(text));
}

export function splitExportOrderTexts(text: string): readonly string[] {
  const jsonSlices = splitJsonOrders(text);
  if (jsonSlices !== undefined) {
    return jsonSlices.slice(0, MAX_EXPORT_ORDERS);
  }
  const csvSlices = splitDelimitedOrders(text);
  if (csvSlices !== undefined) {
    return csvSlices.slice(0, MAX_EXPORT_ORDERS);
  }
  return [text];
}

export function slicePreparedExportDocuments(
  prepared: PreparedReceiptDocument,
): readonly PreparedReceiptDocument[] {
  if (
    prepared.pages.length !== 1 ||
    prepared.pages[0]?.mediaType !== 'text/plain'
  ) {
    return [prepared];
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    prepared.pages[0].bytes,
  );
  const slices = splitExportOrderTexts(text);
  if (slices.length <= 1) {
    return [prepared];
  }
  return slices.map((slice) => {
    const bytes = Buffer.from(slice, 'utf8');
    return parsePreparedReceiptDocument({
      schemaVersion: 'prepared-receipt-document.v1',
      sourceSha256: prepared.sourceSha256,
      pages: [
        {
          position: 0,
          mediaType: 'text/plain',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        },
      ],
    });
  });
}

function boundExportText(text: string): string {
  const normalized = text.replaceAll('\u0000', '').trim();
  if (normalized.length === 0) {
    throw new Error('export-invalid');
  }
  const encoded = Buffer.from(normalized, 'utf8');
  if (encoded.byteLength > MAX_EXPORT_TEXT_BYTES) {
    throw new Error('export-limits-exceeded');
  }
  return normalized;
}

function prettyJson(text: string): string {
  try {
    return `${JSON.stringify(JSON.parse(stripBom(text)), null, 2)}\n`;
  } catch {
    throw new Error('export-invalid');
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = stripBom(text).trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksLikeDelimitedText(text: string, delimiter: string): boolean {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    return false;
  }
  const headerCount = lines[0]!.split(delimiter).length;
  if (headerCount < 2) {
    return false;
  }
  return lines
    .slice(1, 6)
    .every((line) => line.split(delimiter).length === headerCount);
}

function looksLikeXlsx(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return false;
  }
  try {
    const files = readZipStore(bytes);
    return (
      files.has('[Content_Types].xml') ||
      [...files.keys()].some((name) => name.startsWith('xl/'))
    );
  } catch {
    return (
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      bytes[2] === 0x03 &&
      bytes[3] === 0x04
    );
  }
}

function looksLikeOleCompound(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  );
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const text = decoder.decode(bytes);
    if (text.includes('\u0000')) {
      return undefined;
    }
    return text;
  } catch {
    return undefined;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitJsonOrders(text: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const orders = parsed.filter((entry) => isOrderLike(entry));
  if (orders.length < 2) {
    return undefined;
  }
  return orders.map((order) => `${JSON.stringify(order, null, 2)}\n`);
}

function isOrderLike(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).map((key) => key.toLowerCase());
  const hasDate = keys.some((key) => key.includes('date'));
  const hasTotal = keys.some(
    (key) =>
      key.includes('total') ||
      key === 'amount' ||
      key === 'grandtotal' ||
      key === 'price',
  );
  return hasDate && hasTotal;
}

function splitDelimitedOrders(text: string): readonly string[] | undefined {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 3) {
    return undefined;
  }
  const delimiter = lines[0]!.includes('\t') ? '\t' : ',';
  const header = splitDelimitedLine(lines[0]!, delimiter);
  const dateIndex = header.findIndex((column) => /date/i.test(column));
  const totalIndex = header.findIndex((column) =>
    /total|amount|price/i.test(column),
  );
  if (dateIndex < 0 || totalIndex < 0) {
    return undefined;
  }
  const rows = lines.slice(1);
  if (rows.length < 2) {
    return undefined;
  }
  return rows.map((row) => `${header.join(delimiter)}\n${row}\n`);
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

function convertXlsxToTsv(bytes: Uint8Array): string {
  const files = readZipStore(bytes);
  const sharedStrings = files.get('xl/sharedStrings.xml');
  const shared =
    sharedStrings === undefined
      ? []
      : parseSharedStrings(decodeXml(sharedStrings));
  const sheetName =
    [...files.keys()].find((name) =>
      /^xl\/worksheets\/sheet1\.xml$/i.test(name),
    ) ??
    [...files.keys()].find((name) =>
      /^xl\/worksheets\/sheet\d+\.xml$/i.test(name),
    );
  if (sheetName === undefined) {
    throw new Error('export-invalid');
  }
  const rows = parseSheetRows(decodeXml(files.get(sheetName)), shared);
  if (rows.length === 0) {
    throw new Error('export-invalid');
  }
  return boundExportText(rows.map((row) => row.join('\t')).join('\n') + '\n');
}

function decodeXml(bytes: Uint8Array | undefined): string {
  if (bytes === undefined) {
    throw new Error('export-invalid');
  }
  const text = decodeUtf8(bytes);
  if (text === undefined) {
    throw new Error('export-invalid');
  }
  return text;
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  const blocks = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi);
  for (const block of blocks) {
    const texts = [...block[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(
      (match) => decodeXmlEntities(match[1] ?? ''),
    );
    values.push(texts.join(''));
  }
  return values;
}

function parseSheetRows(xml: string, shared: readonly string[]): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const cells = new Map<number, string>();
    let maxColumn = -1;
    for (const cellMatch of rowMatch[1]!.matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/gi,
    )) {
      const attributes = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const reference = /(?:^|\s)r="([A-Z]+)\d+"/i.exec(attributes)?.[1];
      const column =
        reference === undefined ? maxColumn + 1 : columnIndex(reference);
      const type = /(?:^|\s)t="([^"]+)"/i.exec(attributes)?.[1];
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? '';
      const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/i.exec(body)?.[1];
      let value = decodeXmlEntities(raw);
      if (type === 's') {
        const index = Number(value);
        value = Number.isInteger(index) ? (shared[index] ?? '') : '';
      } else if (inline !== undefined) {
        value = [...inline.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
          .map((match) => decodeXmlEntities(match[1] ?? ''))
          .join('');
      }
      cells.set(column, value);
      if (column > maxColumn) {
        maxColumn = column;
      }
    }
    if (maxColumn < 0) {
      continue;
    }
    const row = Array.from(
      { length: maxColumn + 1 },
      (_, index) => cells.get(index) ?? '',
    );
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }
  return rows;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const character of letters.toUpperCase()) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) {
      return 0;
    }
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function readZipStore(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let uncompressedTotal = 0;
  while (offset + 30 <= bytes.byteLength && files.size < MAX_XLSX_ENTRIES) {
    if (
      bytes[offset] !== 0x50 ||
      bytes[offset + 1] !== 0x4b ||
      bytes[offset + 2] !== 0x03 ||
      bytes[offset + 3] !== 0x04
    ) {
      break;
    }
    const compression = readU16(bytes, offset + 8);
    const compressedSize = readU32(bytes, offset + 18);
    const uncompressedSize = readU32(bytes, offset + 22);
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (dataStart + compressedSize > bytes.byteLength) {
      throw new Error('export-invalid');
    }
    const name = Buffer.from(
      bytes.subarray(nameStart, nameStart + nameLength),
    ).toString('utf8');
    if (uncompressedSize > MAX_XLSX_ENTRY_BYTES) {
      throw new Error('export-limits-exceeded');
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let uncompressed: Uint8Array;
    if (compression === 0) {
      uncompressed = Uint8Array.from(compressed);
    } else if (compression === 8) {
      try {
        uncompressed = inflateRawSync(compressed, {
          maxOutputLength: MAX_XLSX_ENTRY_BYTES,
        });
      } catch {
        throw new Error('export-invalid');
      }
    } else {
      offset = dataStart + compressedSize;
      continue;
    }
    uncompressedTotal += uncompressed.byteLength;
    if (uncompressedTotal > MAX_XLSX_ENTRY_BYTES * 4) {
      throw new Error('export-limits-exceeded');
    }
    files.set(name, uncompressed);
    offset = dataStart + compressedSize;
  }
  if (files.size === 0) {
    throw new Error('export-invalid');
  }
  return files;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
