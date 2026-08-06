export type ReceiptDocumentPreparationErrorCode =
  | 'image-invalid'
  | 'image-limits-exceeded'
  | 'pdf-invalid'
  | 'pdf-encrypted'
  | 'pdf-limits-exceeded'
  | 'pdf-rasterization-failed'
  | 'prepared-document-invalid';

export class ReceiptDocumentPreparationError extends Error {
  constructor(readonly code: ReceiptDocumentPreparationErrorCode) {
    super(`Receipt document preparation failed: ${code}`);
    this.name = 'ReceiptDocumentPreparationError';
  }
}
