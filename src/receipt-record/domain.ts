import { createHash } from 'node:crypto';

import { z } from 'zod';

export const ACTUAL_RECEIPT_NOTE_PREFIX = 'household-finance:receipt:' as const;
export const HOUSEHOLD_FINANCE_RECEIPT_SCHEMA_VERSION =
  'household-finance.receipt.v1' as const;
export const MAX_HOUSEHOLD_FINANCE_RECEIPT_NOTE_BYTES = 128 * 1024;
export const MAX_HOUSEHOLD_FINANCE_RECEIPT_SOURCES = 16;
export const MAX_HOUSEHOLD_FINANCE_RECEIPT_ITEMS = 200;
export const MAX_HOUSEHOLD_FINANCE_RECEIPT_HOUSEHOLD_NOTES = 16;
export const MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS = 5_000;

const MAX_RECEIPT_AMOUNT_MINOR = 100_000_000;

function boundedText(maximum: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.normalize('NFC').trim())
    .refine((value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint === undefined || (codePoint >= 0x20 && codePoint !== 0x7f)
        );
      }),
    );
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const minorUnits = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(MAX_RECEIPT_AMOUNT_MINOR)
  .refine((value) => !Object.is(value, -0));
const nullableMinorUnits = minorUnits.nullable();
const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const providerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const archivePath = boundedText(1_000).refine((value) => {
  const parts = value.split('/');
  return (
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
});

export const householdFinanceReceiptSourceSchema = z.strictObject({
  nextcloudFileId: boundedText(500),
  archivePath,
  sha256: hash,
  mediaType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  receivedAt: instant,
  talk: z.strictObject({
    roomToken: boundedText(500),
    actorId: boundedText(500),
    messageId: boundedText(500),
  }),
});

export const householdFinanceReceiptAmountsSchema = z.strictObject({
  subtotalMinor: nullableMinorUnits,
  taxMinor: nullableMinorUnits,
  discountMinor: nullableMinorUnits,
  tipMinor: nullableMinorUnits,
  totalMinor: nullableMinorUnits,
});

export const householdFinanceReceiptPaymentEvidenceSchema = z
  .strictObject({
    kind: z.enum(['masked-card', 'cash', 'unknown']),
    lastFour: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
  })
  .superRefine((payment, context) => {
    if ((payment.kind === 'masked-card') !== (payment.lastFour !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only masked-card evidence may contain a last four',
        path: ['lastFour'],
      });
    }
  });

export const householdFinanceReceiptItemSchema = z
  .strictObject({
    description: boundedText(500).nullable(),
    quantity: z.number().finite().positive().max(100_000).nullable(),
    unitPriceMinor: nullableMinorUnits,
    totalMinor: nullableMinorUnits,
  })
  .refine(
    (item) =>
      item.description !== null ||
      item.quantity !== null ||
      item.unitPriceMinor !== null ||
      item.totalMinor !== null,
    { message: 'Empty receipt items must be omitted' },
  );

export const householdFinanceReceiptExtractionSchema = z.strictObject({
  provider: providerName,
  requestedModel: modelName,
  resolvedModel: modelName,
  zeroDataRetention: z.literal(true),
  extractedAt: instant,
  automaticProcessingBlocked: z.literal(true).optional(),
  itemSplitBlocked: z.literal(true).optional(),
  sourceSha256s: z
    .array(hash)
    .min(1)
    .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_SOURCES)
    .refine((values) => new Set(values).size === values.length),
});

export const householdFinanceReceiptHouseholdNoteTextSchema =
  boundedText(2_000);
export const householdFinanceReceiptHouseholdNoteTextsSchema = z
  .array(householdFinanceReceiptHouseholdNoteTextSchema)
  .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_HOUSEHOLD_NOTES);
export const householdFinanceReceiptHouseholdNoteSchema = z.strictObject({
  text: householdFinanceReceiptHouseholdNoteTextSchema,
  receivedAt: instant,
  talk: z.strictObject({
    roomToken: boundedText(500),
    actorId: boundedText(500),
    messageId: boundedText(500),
  }),
});

function compareHouseholdNotes(
  left: z.infer<typeof householdFinanceReceiptHouseholdNoteSchema>,
  right: z.infer<typeof householdFinanceReceiptHouseholdNoteSchema>,
): number {
  const compareText = (leftText: string, rightText: string): number =>
    leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
  return (
    compareText(left.receivedAt, right.receivedAt) ||
    compareText(left.talk.roomToken, right.talk.roomToken) ||
    compareText(left.talk.messageId, right.talk.messageId) ||
    compareText(left.talk.actorId, right.talk.actorId)
  );
}

export const householdFinanceReceiptHouseholdNotesSchema = z
  .array(householdFinanceReceiptHouseholdNoteSchema)
  .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_HOUSEHOLD_NOTES)
  .superRefine((values, context) => {
    const identities = new Set<string>();
    for (const [index, value] of values.entries()) {
      const identity = [
        value.talk.roomToken,
        value.talk.messageId,
        value.talk.actorId,
      ].join('\u0000');
      if (identities.has(identity)) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt household note Talk identities must be unique',
          path: [index],
        });
      }
      identities.add(identity);
      if (index > 0 && compareHouseholdNotes(values[index - 1]!, value) >= 0) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt household notes must use canonical authored order',
          path: [index],
        });
      }
    }
  });

export function canonicalizeHouseholdFinanceReceiptHouseholdNotes(
  inputs: readonly z.input<typeof householdFinanceReceiptHouseholdNoteSchema>[],
): z.output<typeof householdFinanceReceiptHouseholdNotesSchema> {
  const byTalkIdentity = new Map<
    string,
    z.output<typeof householdFinanceReceiptHouseholdNoteSchema>
  >();
  for (const input of inputs) {
    const note = householdFinanceReceiptHouseholdNoteSchema.parse(input);
    // Nextcloud Talk emits this transport placeholder for an attachment with
    // no authored caption. It is never household evidence.
    if (note.text.toLocaleLowerCase('en') === '{file}') continue;
    const identity = [
      note.talk.roomToken,
      note.talk.messageId,
      note.talk.actorId,
    ].join('\u0000');
    const existing = byTalkIdentity.get(identity);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(note)) {
        throw new TypeError(
          'Receipt household note Talk identity has conflicting content',
        );
      }
      continue;
    }
    byTalkIdentity.set(identity, note);
  }
  return householdFinanceReceiptHouseholdNotesSchema.parse(
    [...byTalkIdentity.values()]
      .sort(compareHouseholdNotes)
      .slice(-MAX_HOUSEHOLD_FINANCE_RECEIPT_HOUSEHOLD_NOTES),
  );
}

const receiptCommon = {
  schemaVersion: z.literal(HOUSEHOLD_FINANCE_RECEIPT_SCHEMA_VERSION),
  receiptId: z.uuid(),
  revision: z.number().int().safe().min(1).max(1_000_000_000),
  createdAt: instant,
  updatedAt: instant,
  sources: z
    .array(householdFinanceReceiptSourceSchema)
    .min(1)
    .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_SOURCES)
    .refine(
      (sources) =>
        new Set(sources.map((source) => source.sha256)).size === sources.length,
    ),
};

export const householdFinanceActiveReceiptRecordSchema = z.strictObject({
  ...receiptCommon,
  status: z.literal('active'),
  merchant: boundedText(500).nullable(),
  purchaseDate: z.iso.date().nullable(),
  purchaseTime: z.iso.time().nullable(),
  timezoneOffset: z
    .string()
    .regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/)
    .nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  amounts: householdFinanceReceiptAmountsSchema,
  paymentEvidence: householdFinanceReceiptPaymentEvidenceSchema,
  receiptReference: boundedText(500).nullable(),
  householdNotes: householdFinanceReceiptHouseholdNotesSchema.optional(),
  items: z
    .array(householdFinanceReceiptItemSchema)
    .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_ITEMS),
  extraction: householdFinanceReceiptExtractionSchema,
});

export const householdFinanceDiscardedReceiptRecordSchema = z.strictObject({
  ...receiptCommon,
  status: z.literal('discarded'),
  discardedAt: instant,
});

export const householdFinanceReceiptRecordSchema = z
  .discriminatedUnion('status', [
    householdFinanceActiveReceiptRecordSchema,
    householdFinanceDiscardedReceiptRecordSchema,
  ])
  .superRefine((record, context) => {
    if (
      Date.parse(record.createdAt) > Date.parse(record.updatedAt) ||
      record.sources.some(
        (source) =>
          Date.parse(source.receivedAt) > Date.parse(record.updatedAt),
      ) ||
      (record.status === 'discarded' &&
        (record.discardedAt !== record.updatedAt ||
          Date.parse(record.discardedAt) < Date.parse(record.createdAt)))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Receipt record timestamps are inconsistent',
      });
    }
    if (record.status === 'active') {
      if (
        Date.parse(record.extraction.extractedAt) >
          Date.parse(record.updatedAt) ||
        record.extraction.sourceSha256s.length !== record.sources.length ||
        record.extraction.sourceSha256s.some(
          (sourceHash, index) => sourceHash !== record.sources[index]!.sha256,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt extraction provenance is inconsistent',
          path: ['extraction'],
        });
      }
      if (
        record.householdNotes?.some(
          (note) =>
            Date.parse(note.receivedAt) < Date.parse(record.createdAt) ||
            Date.parse(note.receivedAt) > Date.parse(record.updatedAt),
        ) === true
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt household note timestamps are inconsistent',
          path: ['householdNotes'],
        });
      }
    }
  });

export type HouseholdFinanceReceiptSource = z.infer<
  typeof householdFinanceReceiptSourceSchema
>;
export type HouseholdFinanceReceiptAmounts = z.infer<
  typeof householdFinanceReceiptAmountsSchema
>;
export type HouseholdFinanceReceiptItem = z.infer<
  typeof householdFinanceReceiptItemSchema
>;
export type HouseholdFinanceReceiptHouseholdNote = z.infer<
  typeof householdFinanceReceiptHouseholdNoteSchema
>;
export type HouseholdFinanceReceiptRecordV1 = z.infer<
  typeof householdFinanceReceiptRecordSchema
>;
export type HouseholdFinanceActiveReceiptRecordV1 = Extract<
  HouseholdFinanceReceiptRecordV1,
  { readonly status: 'active' }
>;

/**
 * Whether the canonical receipt contains a complete, allocatable item breakdown.
 * Receipt-level merchant/date/total facts can still be usable when this is
 * false; callers must not present or apply the item rows as a complete split.
 */
export function receiptRecordItemDetailsComplete(
  receipt: HouseholdFinanceActiveReceiptRecordV1,
): boolean {
  if (
    receipt.extraction.itemSplitBlocked === true ||
    receipt.items.length === 0
  ) {
    return false;
  }
  let itemTotalMinor = 0;
  for (const item of receipt.items) {
    if (item.totalMinor === null) return false;
    itemTotalMinor += item.totalMinor;
  }
  const conventionalSubtotalReconciles =
    receipt.amounts.subtotalMinor !== null &&
    receipt.amounts.taxMinor !== null &&
    receipt.amounts.tipMinor !== null &&
    receipt.amounts.discountMinor !== null &&
    receipt.amounts.totalMinor !== null &&
    receipt.amounts.subtotalMinor +
      receipt.amounts.taxMinor +
      receipt.amounts.tipMinor -
      receipt.amounts.discountMinor ===
      receipt.amounts.totalMinor;
  const netSubtotalReconciles =
    receipt.amounts.subtotalMinor !== null &&
    receipt.amounts.taxMinor !== null &&
    receipt.amounts.tipMinor !== null &&
    receipt.amounts.totalMinor !== null &&
    receipt.amounts.subtotalMinor +
      receipt.amounts.taxMinor +
      receipt.amounts.tipMinor ===
      receipt.amounts.totalMinor;
  return (
    itemTotalMinor === receipt.amounts.subtotalMinor ||
    itemTotalMinor === receipt.amounts.totalMinor ||
    (receipt.amounts.subtotalMinor !== null &&
      receipt.amounts.discountMinor !== null &&
      receipt.amounts.discountMinor > 0 &&
      netSubtotalReconciles &&
      !conventionalSubtotalReconciles &&
      itemTotalMinor ===
        receipt.amounts.subtotalMinor + receipt.amounts.discountMinor)
  );
}

export interface ActualReceiptNoteRecord {
  readonly noteId: string;
  readonly record: HouseholdFinanceReceiptRecordV1;
  readonly canonicalJson: string;
  readonly sha256: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

export function parseHouseholdFinanceReceiptRecord(
  value: unknown,
): HouseholdFinanceReceiptRecordV1 {
  return householdFinanceReceiptRecordSchema.parse(value);
}

export function canonicalHouseholdFinanceReceiptJson(value: unknown): string {
  return JSON.stringify(
    canonicalValue(parseHouseholdFinanceReceiptRecord(value)),
  );
}

export function householdFinanceReceiptSha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalHouseholdFinanceReceiptJson(value), 'utf8')
    .digest('hex');
}

export function actualReceiptNoteId(receiptId: string): string {
  return `${ACTUAL_RECEIPT_NOTE_PREFIX}${z
    .uuid()
    .parse(receiptId)
    .toLocaleLowerCase('en')}`;
}

export function receiptIdFromActualNoteId(noteId: string): string {
  if (!noteId.startsWith(ACTUAL_RECEIPT_NOTE_PREFIX)) {
    throw new TypeError('Actual note is not a household receipt record');
  }
  const receiptId = z
    .uuid()
    .parse(noteId.slice(ACTUAL_RECEIPT_NOTE_PREFIX.length))
    .toLocaleLowerCase('en');
  if (actualReceiptNoteId(receiptId) !== noteId) {
    throw new TypeError('Actual receipt note ID is not canonical');
  }
  return receiptId;
}

export function parseHouseholdFinanceReceiptNote(
  noteId: string,
  note: string,
): ActualReceiptNoteRecord {
  const receiptId = receiptIdFromActualNoteId(noteId);
  if (
    Buffer.byteLength(note, 'utf8') >
      MAX_HOUSEHOLD_FINANCE_RECEIPT_NOTE_BYTES ||
    note.length === 0
  ) {
    throw new TypeError('Actual receipt note exceeds its bounded contract');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(note) as unknown;
  } catch {
    throw new TypeError('Actual receipt note is not JSON');
  }
  const record = parseHouseholdFinanceReceiptRecord(decoded);
  if (
    record.receiptId !== receiptId ||
    record.receiptId !== record.receiptId.toLocaleLowerCase('en')
  ) {
    throw new TypeError('Actual receipt note ID does not match its record');
  }
  const canonicalJson = canonicalHouseholdFinanceReceiptJson(record);
  if (note !== canonicalJson) {
    throw new TypeError('Actual receipt note JSON is not canonical');
  }
  return {
    noteId,
    record,
    canonicalJson,
    sha256: createHash('sha256').update(canonicalJson, 'utf8').digest('hex'),
  };
}
