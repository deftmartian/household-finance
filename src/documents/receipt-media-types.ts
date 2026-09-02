export const receiptImageMediaTypes = ['image/jpeg', 'image/png'] as const;
export const receiptPdfMediaType = 'application/pdf' as const;
export const receiptExportMediaTypes = [
  'application/json',
  'text/csv',
  'text/tab-separated-values',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
] as const;

export const receiptDocumentMediaTypes = [
  ...receiptImageMediaTypes,
  receiptPdfMediaType,
  ...receiptExportMediaTypes,
] as const;

export type ReceiptImageMediaType = (typeof receiptImageMediaTypes)[number];
export type ReceiptExportMediaType = (typeof receiptExportMediaTypes)[number];
export type ReceiptDocumentMediaType =
  (typeof receiptDocumentMediaTypes)[number];

const exportMediaTypeSet: ReadonlySet<string> = new Set(
  receiptExportMediaTypes,
);

export function normalizeMediaType(value: string): string {
  const [raw] = value.toLowerCase().split(';', 1);
  const normalized = raw?.trim() ?? '';
  if (normalized === 'text/json' || normalized === 'application/x-json') {
    return 'application/json';
  }
  if (normalized === 'application/csv' || normalized === 'application/x-csv') {
    return 'text/csv';
  }
  return normalized;
}

export function isReceiptExportMediaType(
  value: string,
): value is ReceiptExportMediaType {
  return exportMediaTypeSet.has(value);
}

export function isReceiptDocumentMediaType(
  value: unknown,
): value is ReceiptDocumentMediaType {
  return (
    typeof value === 'string' &&
    receiptDocumentMediaTypes.some((mediaType) => mediaType === value)
  );
}

export function exportArchiveExtension(
  mediaType: ReceiptExportMediaType,
): string {
  switch (mediaType) {
    case 'application/json':
      return 'json';
    case 'text/csv':
      return 'csv';
    case 'text/tab-separated-values':
      return 'tsv';
    case 'text/plain':
      return 'txt';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'application/vnd.ms-excel':
      return 'xls';
  }
}
