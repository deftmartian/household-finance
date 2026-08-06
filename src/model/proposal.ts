import { z } from 'zod';

import { MAX_PREPARED_RECEIPT_PAGES } from './document.js';

const confidenceSchema = z.number().min(0).max(1);
const sourcePageSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_PREPARED_RECEIPT_PAGES)
  .nullable();
const evidenceSchema = z.enum([
  'explicit',
  'derived',
  'inferred',
  'absent',
  'unreadable',
]);
const MAX_RECEIPT_AMOUNT_MINOR = 100_000_000;
const minorUnitsSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(MAX_RECEIPT_AMOUNT_MINOR);

const textFieldSchema = z.strictObject({
  value: z.string().trim().min(1).max(500).nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const dateFieldSchema = z.strictObject({
  value: z.iso.date().nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const timeFieldSchema = z.strictObject({
  value: z.iso.time().nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const timezoneOffsetFieldSchema = z.strictObject({
  value: z
    .string()
    .regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/)
    .nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const currencyFieldSchema = z.strictObject({
  value: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const amountFieldSchema = z.strictObject({
  valueMinor: minorUnitsSchema.nullable(),
  evidence: evidenceSchema,
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const receiptLineItemProposalSchema = z.strictObject({
  description: z.string().trim().min(1).max(500).nullable(),
  quantity: z.number().finite().positive().max(100_000).nullable(),
  unitPriceMinor: minorUnitsSchema.nullable(),
  totalMinor: minorUnitsSchema.nullable(),
  confidence: confidenceSchema,
  sourcePage: sourcePageSchema,
});

const uncertaintySchema = z.strictObject({
  code: z.enum([
    'document-kind-unclear',
    'multiple-receipts',
    'merchant-unclear',
    'date-unclear',
    'currency-unclear',
    'amounts-unclear',
    'line-items-unclear',
    'payment-unclear',
    'split-tender',
    'combined-charge',
    'reimbursement',
    'other',
  ]),
  message: z.string().trim().min(1).max(500),
  material: z.boolean(),
  sourcePage: sourcePageSchema,
});

interface NullableObservedField {
  value: unknown | null;
  evidence: z.infer<typeof evidenceSchema>;
  sourcePage: number | null;
}

function validateNullableObservedField(
  field: NullableObservedField,
  context: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  if (field.value === null) {
    if (field.evidence !== 'absent' && field.evidence !== 'unreadable') {
      context.addIssue({
        code: 'custom',
        message: 'A null value must be absent or unreadable',
        path: [...path, 'evidence'],
      });
    }
    if (field.evidence === 'absent' && field.sourcePage !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Absent evidence cannot claim a source page',
        path: [...path, 'sourcePage'],
      });
    }
    return;
  }

  if (field.evidence === 'absent' || field.evidence === 'unreadable') {
    context.addIssue({
      code: 'custom',
      message: 'An observed value requires visible or derived evidence',
      path: [...path, 'evidence'],
    });
  }
  if (field.sourcePage === null) {
    context.addIssue({
      code: 'custom',
      message: 'An observed value requires a source page',
      path: [...path, 'sourcePage'],
    });
  }
}

function passesLuhn(candidate: string): boolean {
  let sum = 0;
  let doubleDigit = false;
  for (let index = candidate.length - 1; index >= 0; index -= 1) {
    const digit = Number(candidate[index]);
    if (!Number.isInteger(digit)) {
      return false;
    }
    let contribution = digit;
    if (doubleDigit) {
      contribution *= 2;
      if (contribution > 9) {
        contribution -= 9;
      }
    }
    sum += contribution;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function containsPaymentCardNumber(value: string): boolean {
  const normalized = value.normalize('NFKC');
  const contexts =
    normalized.match(
      /\b(?:card|visa|mastercard|master\s+card|amex|pan|account|acct)\b.{0,80}/gi,
    ) ?? [];
  return contexts.some((context) => {
    const candidates = context.match(/(?:\d[\s.:/_•xX-]*){12,18}\d/g) ?? [];
    return candidates.some((candidate) => {
      const digits = candidate.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    });
  });
}

/**
 * This is a model proposal, not a ledger-ready receipt. Every observed value
 * may be null so the model never has to invent data merely to satisfy shape.
 * Deterministic code owns identifiers, provenance, categorization, validation,
 * and every eventual write decision.
 */
const receiptModelProposalV1BaseSchema = z.strictObject({
  schemaVersion: z.literal('receipt-model-proposal.v1'),
  documentDisposition: z.enum([
    'single-receipt',
    'multiple-receipts',
    'not-receipt',
    'uncertain',
  ]),
  merchant: textFieldSchema,
  purchaseDate: dateFieldSchema,
  purchaseTime: timeFieldSchema,
  timezoneOffset: timezoneOffsetFieldSchema,
  currency: currencyFieldSchema,
  amounts: z.strictObject({
    subtotal: amountFieldSchema,
    tax: amountFieldSchema,
    discount: amountFieldSchema,
    tip: amountFieldSchema,
    total: amountFieldSchema,
  }),
  paymentEvidence: z.strictObject({
    kind: z.enum(['masked-card', 'cash', 'unknown']),
    lastFour: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
    confidence: confidenceSchema,
    sourcePage: sourcePageSchema,
  }),
  receiptReference: textFieldSchema,
  lineItems: z.array(receiptLineItemProposalSchema).max(200),
  uncertainties: z.array(uncertaintySchema).max(100),
});

export const receiptModelProposalV1Schema =
  receiptModelProposalV1BaseSchema.superRefine((proposal, context) => {
    const fields = [
      ['merchant', proposal.merchant],
      ['purchaseDate', proposal.purchaseDate],
      ['purchaseTime', proposal.purchaseTime],
      ['timezoneOffset', proposal.timezoneOffset],
      ['currency', proposal.currency],
      ['amounts', 'subtotal', proposal.amounts.subtotal],
      ['amounts', 'tax', proposal.amounts.tax],
      ['amounts', 'discount', proposal.amounts.discount],
      ['amounts', 'tip', proposal.amounts.tip],
      ['amounts', 'total', proposal.amounts.total],
      ['receiptReference', proposal.receiptReference],
    ] as const;
    for (const parts of fields) {
      const field = parts.at(-1);
      if (typeof field !== 'object' || field === null) {
        continue;
      }
      const path = parts.slice(0, -1) as readonly (string | number)[];
      validateNullableObservedField(
        {
          value: 'valueMinor' in field ? field.valueMinor : field.value,
          evidence: field.evidence,
          sourcePage: field.sourcePage,
        },
        context,
        path,
      );
    }

    if (
      proposal.paymentEvidence.kind === 'masked-card' &&
      (proposal.paymentEvidence.lastFour === null ||
        proposal.paymentEvidence.sourcePage === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Masked-card evidence requires last four and source page',
        path: ['paymentEvidence'],
      });
    }
    if (
      proposal.paymentEvidence.kind !== 'masked-card' &&
      proposal.paymentEvidence.lastFour !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only masked-card evidence may include last four',
        path: ['paymentEvidence', 'lastFour'],
      });
    }

    proposal.lineItems.forEach((lineItem, index) => {
      if (
        lineItem.description === null &&
        lineItem.quantity === null &&
        lineItem.unitPriceMinor === null &&
        lineItem.totalMinor === null
      ) {
        context.addIssue({
          code: 'custom',
          message: 'An empty line item must be omitted',
          path: ['lineItems', index],
        });
      }
      if (
        lineItem.sourcePage === null &&
        (lineItem.description !== null ||
          lineItem.quantity !== null ||
          lineItem.unitPriceMinor !== null ||
          lineItem.totalMinor !== null)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'An observed line item requires a source page',
          path: ['lineItems', index, 'sourcePage'],
        });
      }
    });

    const freeTextValues: Array<{
      path: readonly (string | number)[];
      value: string | null;
    }> = [
      { path: ['merchant', 'value'], value: proposal.merchant.value },
      {
        path: ['receiptReference', 'value'],
        value: proposal.receiptReference.value,
      },
      ...proposal.lineItems.map((lineItem, index) => ({
        path: ['lineItems', index, 'description'] as const,
        value: lineItem.description,
      })),
      ...proposal.uncertainties.map((uncertainty, index) => ({
        path: ['uncertainties', index, 'message'] as const,
        value: uncertainty.message,
      })),
    ];
    for (const field of freeTextValues) {
      if (field.value !== null && containsPaymentCardNumber(field.value)) {
        context.addIssue({
          code: 'custom',
          message: 'Free text cannot contain a complete payment-card number',
          path: [...field.path],
        });
      }
    }
  });

export type ReceiptModelProposalV1 = z.infer<
  typeof receiptModelProposalV1Schema
>;

/**
 * Converts structurally valid but internally inconsistent payment evidence
 * into an explicit review state. Structured-output JSON Schema cannot express
 * these cross-field rules, so the provider is not expected to enforce them.
 */
export function normalizeReceiptModelProposalV1(
  untrustedProposal: unknown,
): unknown {
  const parsed = receiptModelProposalV1BaseSchema.safeParse(untrustedProposal);
  if (!parsed.success) {
    return untrustedProposal;
  }

  const proposal = structuredClone(parsed.data);
  let evidenceInconsistent = false;
  let evidenceSourcePage: number | null = null;
  const observedFields: Array<{
    value?: unknown | null;
    valueMinor?: number | null;
    evidence: z.infer<typeof evidenceSchema>;
    confidence: number;
    sourcePage: number | null;
  }> = [
    proposal.merchant,
    proposal.purchaseDate,
    proposal.purchaseTime,
    proposal.timezoneOffset,
    proposal.currency,
    proposal.amounts.subtotal,
    proposal.amounts.tax,
    proposal.amounts.discount,
    proposal.amounts.tip,
    proposal.amounts.total,
    proposal.receiptReference,
  ];
  for (const field of observedFields) {
    const isAmount = Object.hasOwn(field, 'valueMinor');
    const value = isAmount ? field.valueMinor : field.value;
    if (value === null) {
      const expectedEvidence =
        field.sourcePage === null ? 'absent' : 'unreadable';
      if (field.evidence !== 'absent' && field.evidence !== 'unreadable') {
        evidenceInconsistent = true;
        evidenceSourcePage ??= field.sourcePage;
        field.evidence = expectedEvidence;
      } else if (field.evidence === 'absent' && field.sourcePage !== null) {
        evidenceInconsistent = true;
        evidenceSourcePage ??= field.sourcePage;
        field.evidence = 'unreadable';
      }
      continue;
    }

    if (
      field.evidence === 'absent' ||
      field.evidence === 'unreadable' ||
      field.sourcePage === null
    ) {
      evidenceInconsistent = true;
      evidenceSourcePage ??= field.sourcePage;
      if (isAmount) {
        field.valueMinor = null;
      } else {
        field.value = null;
      }
      field.evidence = field.sourcePage === null ? 'absent' : 'unreadable';
      field.confidence = 0;
    }
  }

  if (
    evidenceInconsistent &&
    proposal.uncertainties.length < 100 &&
    !proposal.uncertainties.some(
      (uncertainty) =>
        uncertainty.code === 'other' &&
        uncertainty.message ===
          'Observed field evidence was internally inconsistent',
    )
  ) {
    proposal.uncertainties.push({
      code: 'other',
      message: 'Observed field evidence was internally inconsistent',
      material: true,
      sourcePage: evidenceSourcePage,
    });
  }

  const payment = proposal.paymentEvidence;
  const inconsistent =
    (payment.kind === 'masked-card' &&
      (payment.lastFour === null || payment.sourcePage === null)) ||
    (payment.kind !== 'masked-card' && payment.lastFour !== null);
  if (!inconsistent) {
    return proposal;
  }

  const uncertaintySourcePage = payment.sourcePage;
  proposal.paymentEvidence = {
    kind: 'unknown',
    lastFour: null,
    confidence: 0,
    sourcePage: null,
  };
  if (
    proposal.uncertainties.length < 100 &&
    !proposal.uncertainties.some(
      (uncertainty) => uncertainty.code === 'payment-unclear',
    )
  ) {
    proposal.uncertainties.push({
      code: 'payment-unclear',
      message: 'Payment evidence fields were inconsistent',
      material: false,
      sourcePage: uncertaintySourcePage,
    });
  }
  return proposal;
}

/**
 * Applies the household's CAD currency policy to a validated copy while the
 * immutable extraction proposal remains available as the raw audit record.
 */
export function canonicalizeHouseholdReceiptCurrency(
  untrustedProposal: unknown,
): ReceiptModelProposalV1 {
  const proposal = receiptModelProposalV1Schema.parse(untrustedProposal);
  if (
    proposal.currency.value === null ||
    proposal.currency.value === 'CAD' ||
    proposal.currency.evidence === 'explicit'
  ) {
    return proposal;
  }
  return receiptModelProposalV1Schema.parse({
    ...proposal,
    currency: {
      ...proposal.currency,
      value: 'CAD',
      evidence: 'inferred',
    },
  });
}

export const receiptModelProposalV1JsonSchema = z.toJSONSchema(
  receiptModelProposalV1Schema,
  {
    target: 'draft-2020-12',
    reused: 'inline',
  },
);
