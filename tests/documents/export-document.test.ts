import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  convertExportToUtf8Text,
  MAX_EXPORT_TEXT_BYTES,
  slicePreparedExportDocuments,
  sniffReceiptExportMediaType,
  splitExportOrderTexts,
} from '../../src/documents/export-document.js';
import { parsePreparedReceiptDocument } from '../../src/model/index.js';

function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    const localFile = Buffer.concat([local, nameBytes, data]);
    locals.push(localFile);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24);
    central.writeUInt16LE(nameBytes.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += localFile.byteLength;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralDir.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

function xlsxBytes(): Buffer {
  return storedZip({
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?>
<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>2026-07-01</t></is></c><c r="B2"><v>12.34</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>2026-07-02</t></is></c><c r="B3"><v>5</v></c></row>
</sheetData></worksheet>`,
  });
}

describe('export document conversion', () => {
  it('sniffs JSON, CSV, TSV, XLSX, and OLE Excel bytes', () => {
    expect(
      sniffReceiptExportMediaType(
        Buffer.from('[{"orderDate":"2026-07-01","totalAmount":1}]\n', 'utf8'),
      ),
    ).toBe('application/json');
    expect(
      sniffReceiptExportMediaType(
        Buffer.from('Date,Total\n2026-07-01,12.34\n2026-07-02,5\n', 'utf8'),
      ),
    ).toBe('text/csv');
    expect(
      sniffReceiptExportMediaType(
        Buffer.from('Date\tTotal\n2026-07-01\t12.34\n2026-07-02\t5\n', 'utf8'),
      ),
    ).toBe('text/tab-separated-values');
    expect(sniffReceiptExportMediaType(xlsxBytes())).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(
      sniffReceiptExportMediaType(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]),
      ),
    ).toBe('application/vnd.ms-excel');
  });

  it('pretty-prints JSON and splits order-like arrays', () => {
    const text = convertExportToUtf8Text(
      Buffer.from(
        '[{"orderDate":"2026-07-01","totalAmount":12.34},{"orderDate":"2026-07-02","totalAmount":5}]',
        'utf8',
      ),
      'application/json',
    );
    expect(text).toContain('"orderDate": "2026-07-01"');
    const slices = splitExportOrderTexts(text);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toContain('2026-07-01');
    expect(slices[1]).toContain('2026-07-02');
  });

  it('splits CSV rows that have date and total columns', () => {
    const csv = 'Date,Total\n2026-07-01,12.34\n2026-07-02,5.00\n';
    const slices = splitExportOrderTexts(csv);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toBe('Date,Total\n2026-07-01,12.34\n');
    expect(slices[1]).toBe('Date,Total\n2026-07-02,5.00\n');
  });

  it('converts an XLSX sheet to TSV without a spreadsheet library', () => {
    const text = convertExportToUtf8Text(
      xlsxBytes(),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(text).toBe('Date\tTotal\n2026-07-01\t12.34\n2026-07-02\t5');
  });

  it('rejects legacy OLE .xls bytes and oversized text', () => {
    expect(() =>
      convertExportToUtf8Text(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        'application/vnd.ms-excel',
      ),
    ).toThrow('export-invalid');
    expect(() =>
      convertExportToUtf8Text(
        Buffer.from('x'.repeat(MAX_EXPORT_TEXT_BYTES + 1), 'utf8'),
        'text/plain',
      ),
    ).toThrow('export-limits-exceeded');
  });

  it('accepts a CSV mislabeled as Excel', () => {
    const csv = Buffer.from('Date,Total\n2026-07-01,1\n', 'utf8');
    expect(convertExportToUtf8Text(csv, 'application/vnd.ms-excel')).toContain(
      'Date,Total',
    );
  });

  it('slices a prepared export into one document per order', () => {
    const text = convertExportToUtf8Text(
      Buffer.from(
        '[{"orderDate":"2026-07-01","totalAmount":1},{"orderDate":"2026-07-02","totalAmount":2}]',
        'utf8',
      ),
      'application/json',
    );
    const bytes = Buffer.from(text, 'utf8');
    const prepared = parsePreparedReceiptDocument({
      schemaVersion: 'prepared-receipt-document.v1',
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      pages: [
        {
          position: 0,
          mediaType: 'text/plain',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        },
      ],
    });
    const slices = slicePreparedExportDocuments(prepared);
    expect(slices).toHaveLength(2);
    expect(new TextDecoder().decode(slices[0]!.pages[0]!.bytes)).toContain(
      '2026-07-01',
    );
    expect(new TextDecoder().decode(slices[1]!.pages[0]!.bytes)).toContain(
      '2026-07-02',
    );
  });
});
