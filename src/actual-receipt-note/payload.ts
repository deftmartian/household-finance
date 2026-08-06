import { z } from 'zod';

import {
  actualReceiptNoteId,
  canonicalHouseholdFinanceReceiptJson,
  householdFinanceReceiptSha256,
  parseHouseholdFinanceReceiptNote,
  parseHouseholdFinanceReceiptRecord,
  type HouseholdFinanceReceiptRecordV1,
} from '../receipt-record/index.js';

const receiptIdSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value === value.trim() &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }),
    { message: 'Identifier contains whitespace or control characters' },
  );
const canonicalInstantSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, 'Timestamp must be a canonical ISO-8601 UTC instant');

export const receiptNoteUpsertPayloadSchema = z.strictObject({
  schemaVersion: z.literal('actual-receipt-note-upsert.v1'),
  receiptId: receiptIdSchema,
  revision: z.number().int().safe().min(1),
  expectedPreviousSha256: sha256Schema.nullable(),
  desiredCanonicalJson: z
    .string()
    .min(2)
    .max(512_000)
    .refine((value) => !value.includes('\0')),
  desiredSha256: sha256Schema,
  idempotencyKey: identifierSchema,
  createdAt: canonicalInstantSchema,
});

export type ReceiptNoteUpsertPayloadV1 = z.infer<
  typeof receiptNoteUpsertPayloadSchema
>;

export interface CreateReceiptNoteUpsertPayloadInput {
  readonly record: HouseholdFinanceReceiptRecordV1;
  readonly expectedPreviousSha256: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Stable JSON is part of the signed receipt-note contract. It deliberately
 * accepts only plain JSON values and rejects lossy values such as undefined,
 * non-finite numbers, class instances, and cycles.
 */
export function canonicalReceiptNoteOperationJson(
  value: unknown,
  ancestors = new Set<object>(),
): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Receipt note contains a non-finite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError('Receipt note is not JSON-compatible');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Receipt note contains a cycle');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => canonicalReceiptNoteOperationJson(item, ancestors))
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Receipt note contains a non-plain object');
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalReceiptNoteOperationJson(
            item,
            ancestors,
          )}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function parseReceiptNoteUpsertPayload(
  value: unknown,
): ReceiptNoteUpsertPayloadV1 {
  const parsed = receiptNoteUpsertPayloadSchema.parse(value);
  const note = parseHouseholdFinanceReceiptNote(
    actualReceiptNoteId(parsed.receiptId),
    parsed.desiredCanonicalJson,
  );
  if (
    note.record.receiptId !== parsed.receiptId ||
    note.record.revision !== parsed.revision
  ) {
    throw new TypeError(
      'Receipt-note operation identity does not match its canonical record',
    );
  }
  if (note.sha256 !== parsed.desiredSha256) {
    throw new TypeError('Receipt note SHA-256 does not match its content');
  }
  return structuredClone(parsed);
}

export function createReceiptNoteUpsertPayload(
  input: CreateReceiptNoteUpsertPayloadInput,
): ReceiptNoteUpsertPayloadV1 {
  const record = parseHouseholdFinanceReceiptRecord(input.record);
  return parseReceiptNoteUpsertPayload({
    schemaVersion: 'actual-receipt-note-upsert.v1',
    receiptId: record.receiptId,
    revision: record.revision,
    expectedPreviousSha256: input.expectedPreviousSha256,
    desiredCanonicalJson: canonicalHouseholdFinanceReceiptJson(record),
    desiredSha256: householdFinanceReceiptSha256(record),
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
  });
}
