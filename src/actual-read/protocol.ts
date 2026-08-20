import { z } from 'zod';

import {
  importedTransactionCandidateSchema,
  receiptMatchIntentSchema,
  type ImportedTransactionCandidate,
  type ReceiptMatchIntent,
} from '../matching/receipt-transaction.js';
import {
  assertActualTransactionObservation,
  type ActualTransactionObservationV1,
} from '../actual-update/domain.js';
import {
  ACTUAL_RECEIPT_NOTE_PREFIX,
  MAX_HOUSEHOLD_FINANCE_RECEIPT_ITEMS,
  MAX_HOUSEHOLD_FINANCE_RECEIPT_SOURCES,
  canonicalHouseholdFinanceReceiptJson,
  householdFinanceReceiptRecordSchema,
  parseHouseholdFinanceReceiptNote,
} from '../receipt-record/domain.js';
import {
  ACTUAL_CATEGORIZATION_UPDATE_PREPARATION_SCHEMA_VERSION,
  ACTUAL_READ_AVAILABLE_FUNDS_METHOD,
  ACTUAL_READ_BUDGET_CAPACITY_METHOD,
  ACTUAL_READ_CURRENCY,
  ACTUAL_IMPORTED_TRANSACTION_OBSERVATION_SCHEMA_VERSION,
  ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION,
  type AccountBalancesQuery,
  type AccountBalancesResult,
  type ActualReadCatalog,
  type ActualReadFreshness,
  type ActualReadSyncResult,
  type ActualImportedTransactionObservation,
  type ActualImportedTransactionScanQuery,
  type ActualImportedTransactionScanResult,
  type ActualPrepareCategorizationUpdateRequest,
  type ActualPrepareCategorizationUpdateResult,
  type AvailableFundsQuery,
  type AvailableFundsResult,
  type BudgetCapacityQuery,
  type BudgetCapacityResult,
  type BudgetProgressQuery,
  type BudgetProgressResult,
  type CashFlowQuery,
  type CashFlowResult,
  type CategoryExplanationQuery,
  type CategoryExplanationResult,
  type CategorySpendQuery,
  type CategorySpendResult,
  type IncomeQuery,
  type IncomeResult,
  type MerchantSpendQuery,
  type MerchantSpendResult,
  type NeedsCategorizationQuery,
  type NeedsCategorizationResult,
  type OverspendingQuery,
  type OverspendingResult,
  type ReceiptRecordListQuery,
  type ReceiptRecordListResult,
  type ReceiptSearchQuery,
  type ReceiptSearchResult,
  type TransactionExplanationQuery,
  type TransactionExplanationResult,
  type TransactionSearchQuery,
  type TransactionSearchResult,
  type UpcomingBillsQuery,
  type UpcomingBillsResult,
} from './port.js';

export const ACTUAL_READ_JSON_CONTENT_TYPE =
  'application/json; charset=utf-8' as const;
export const MAX_ACTUAL_READ_REQUEST_BYTES = 8 * 1024;
export const MAX_ACTUAL_READ_RESPONSE_BYTES = 1024 * 1024;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_PATTERN = /^\d{4}-\d{2}$/;
const name = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => value === value.normalize('NFC').trim());
const categoryName = name.max(120);
const isoDate = z.string().regex(ISO_DATE_PATTERN);
const isoMonth = z.string().regex(ISO_MONTH_PATTERN);
const safeMoney = z.number().int().safe();
const nonnegativeMoney = safeMoney.nonnegative();
const count = z.number().int().safe().nonnegative();
const accountRole = z.enum([
  'spending',
  'credit-card',
  'cashback-staging',
  'savings',
  'debt',
  'other',
]);
const categorizationEvidence = z.enum(['actual-ledger', 'uncategorized']);
const alias = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSearchText = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.normalize('NFC').trim());

export class ActualReadProtocolError extends Error {
  constructor() {
    super('Actual read protocol value is invalid');
    this.name = 'ActualReadProtocolError';
  }
}

function validIsoDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ActualReadProtocolError();
  return parsed.data;
}

function dateRange<T extends { startDate: string; endDate: string }>(
  value: T,
): T {
  if (
    !validIsoDate(value.startDate) ||
    !validIsoDate(value.endDate) ||
    value.startDate > value.endDate
  ) {
    throw new ActualReadProtocolError();
  }
  return value;
}

function month<T extends { month: string }>(value: T): T {
  if (!validIsoDate(`${value.month}-01`)) {
    throw new ActualReadProtocolError();
  }
  return value;
}

function dated<T extends { asOfDate: string }>(value: T): T {
  if (!validIsoDate(value.asOfDate)) throw new ActualReadProtocolError();
  return value;
}

const freshness = z.strictObject({
  actualBudgetAsOf: z.iso.datetime({ offset: true }),
  bankFeedAsOf: z.iso.datetime({ offset: true }).nullable(),
  lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
  lastOutcome: z.enum([
    'never',
    'succeeded',
    'partial',
    'failed',
    'skipped-recent',
  ]),
  isFresh: z.boolean(),
  expectedBankDelayHours: z.number().int().safe().min(0).max(168),
  lastAttemptSummary: z
    .strictObject({
      attemptedAccountCount: z.number().int().safe().positive(),
      succeededAccountCount: z.number().int().safe().nonnegative(),
      failedAccountCount: z.number().int().safe().nonnegative(),
      budgetRefreshSucceeded: z.boolean(),
    })
    .optional(),
});

const withFreshness = { freshness };

export const categorySpendQuerySchema = z.strictObject({
  categoryName,
  startDate: isoDate,
  endDate: isoDate,
});
export const merchantSpendQuerySchema = z.strictObject({
  merchantName: name,
  startDate: isoDate,
  endDate: isoDate,
});
export const incomeQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
});
export const cashFlowQuerySchema = incomeQuerySchema;
export const accountBalancesQuerySchema = z.strictObject({
  accountName: name.nullable(),
  asOfDate: isoDate,
});
export const availableFundsQuerySchema = z.strictObject({
  asOfDate: isoDate,
});
export const upcomingBillsQuerySchema = z.strictObject({
  fromDate: isoDate,
  throughDate: isoDate,
});
export const budgetCapacityQuerySchema = z.strictObject({
  month: isoMonth,
  targetCategoryName: categoryName,
});
export const budgetProgressQuerySchema = z.strictObject({
  month: isoMonth,
  categoryName: categoryName.nullable(),
});
export const overspendingQuerySchema = z.strictObject({ month: isoMonth });
export const transactionExplanationQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  merchantName: name,
  limit: z.number().int().safe().min(1).max(20),
});
export const transactionSearchQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  accountName: name.nullable(),
  merchantName: name.nullable(),
  categoryName: categoryName.nullable(),
  absoluteAmountMinorUnits: safeMoney.positive().nullable(),
  kind: z.enum(['any', 'ordinary', 'transfer']),
  direction: z.enum(['any', 'expense', 'income']),
  categorization: z.enum(['any', 'categorized', 'uncategorized']),
  sort: z.enum(['date-desc', 'amount-desc']),
  limit: z.number().int().safe().min(1).max(20),
});
export const needsCategorizationQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  sort: z.enum(['date-desc', 'amount-desc']),
  limit: z.number().int().safe().min(1).max(20),
});
export const categoryExplanationQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  categoryName,
  limit: z.number().int().safe().min(1).max(20),
});
export const receiptSearchQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  textQuery: receiptSearchText.nullable(),
  merchantQuery: receiptSearchText.nullable(),
  limit: z.number().int().safe().min(1).max(50),
});
export const receiptRecordListQuerySchema = z.strictObject({
  afterNoteId: z
    .string()
    .regex(
      /^household-finance:receipt:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    .nullable(),
  limit: z.number().int().safe().min(1).max(50),
});
export const importedTransactionScanQuerySchema = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  previousWatermark: hash.nullable(),
});
export const prepareCategorizationUpdateRequestSchema = z.strictObject({
  accountAlias: alias,
  transactionId: z.string().min(1).max(200),
  importedId: z.string().min(1).max(500),
  date: isoDate,
  amountMinorUnits: safeMoney.refine((value) => value !== 0),
  expectedObservationFingerprint: hash,
  categoryAliases: z
    .array(alias)
    .min(1)
    .max(100)
    .refine((aliases) => new Set(aliases).size === aliases.length),
});

export const actualReadCatalogSchema = z.strictObject({
  currency: z.literal(ACTUAL_READ_CURRENCY),
  accountNames: z.array(name).max(50),
  categoryNames: z.array(categoryName).max(200),
  merchantNames: z.array(name).max(300),
  ...withFreshness,
});

const spendFields = {
  expenseMinorUnits: nonnegativeMoney,
  refundMinorUnits: nonnegativeMoney,
  netSpentMinorUnits: safeMoney,
  transactionCount: count,
  uncategorizedExpenseMinorUnits: nonnegativeMoney,
  uncategorizedTransactionCount: count,
};

export const categorySpendResultSchema = categorySpendQuerySchema.extend({
  ...spendFields,
  ...withFreshness,
});
export const merchantSpendResultSchema = merchantSpendQuerySchema.extend({
  ...spendFields,
  ...withFreshness,
});
export const incomeResultSchema = incomeQuerySchema.extend({
  incomeMinorUnits: nonnegativeMoney,
  transactionCount: count,
  ...withFreshness,
});
export const cashFlowResultSchema = cashFlowQuerySchema.extend({
  incomeMinorUnits: nonnegativeMoney,
  spendingMinorUnits: nonnegativeMoney,
  netCashFlowMinorUnits: safeMoney,
  incomeTransactionCount: count,
  spendingTransactionCount: count,
  ...withFreshness,
});

const accountBalanceRow = z.strictObject({
  name,
  role: accountRole,
  onBudget: z.boolean(),
  balanceMinorUnits: safeMoney,
});
export const accountBalancesResultSchema = accountBalancesQuerySchema.extend({
  accounts: z.array(accountBalanceRow).max(50),
  totalBalanceMinorUnits: safeMoney,
  ...withFreshness,
});
export const availableFundsResultSchema = availableFundsQuerySchema.extend({
  onBudgetCashMinorUnits: safeMoney,
  availableToBudgetMinorUnits: safeMoney,
  fundedCategoryBalanceMinorUnits: safeMoney,
  upcomingObligationsMinorUnits: nonnegativeMoney,
  availableFundsMinorUnits: safeMoney,
  method: z.literal(ACTUAL_READ_AVAILABLE_FUNDS_METHOD),
  ...withFreshness,
});

const upcomingBill = z.strictObject({
  name,
  dueDate: isoDate,
  amountMinorUnits: nonnegativeMoney,
  amountCertain: z.boolean(),
});
export const upcomingBillsResultSchema = upcomingBillsQuerySchema.extend({
  bills: z.array(upcomingBill).max(100),
  ...withFreshness,
});

const budgetCategory = z.strictObject({
  name: categoryName,
  budgetedMinorUnits: safeMoney,
  spentMinorUnits: safeMoney,
  balanceMinorUnits: safeMoney,
});
export const budgetCapacityResultSchema = budgetCapacityQuerySchema.extend({
  toBudgetMinorUnits: safeMoney,
  ceilingMinorUnits: nonnegativeMoney,
  method: z.literal(ACTUAL_READ_BUDGET_CAPACITY_METHOD),
  targetCategory: budgetCategory.optional(),
  ...withFreshness,
});
const budgetProgressCategory = budgetCategory.extend({
  overspentMinorUnits: nonnegativeMoney,
});
export const budgetProgressResultSchema = budgetProgressQuerySchema.extend({
  categories: z.array(budgetProgressCategory).max(200),
  totalBudgetedMinorUnits: safeMoney,
  totalSpentMinorUnits: safeMoney,
  totalBalanceMinorUnits: safeMoney,
  ...withFreshness,
});
const overspentCategory = z.strictObject({
  name: categoryName,
  overspentMinorUnits: nonnegativeMoney,
});
export const overspendingResultSchema = overspendingQuerySchema.extend({
  categories: z.array(overspentCategory).max(200),
  totalOverspentMinorUnits: nonnegativeMoney,
  ...withFreshness,
});

const explainedTransaction = z.strictObject({
  date: isoDate,
  merchantName: name,
  accountName: name,
  amountMinorUnits: safeMoney,
  categoryNames: z.array(categoryName).max(20),
  split: z.boolean(),
  cleared: z.boolean(),
  categorizationEvidence,
});
export const transactionExplanationResultSchema =
  transactionExplanationQuerySchema.omit({ limit: true }).extend({
    transactions: z.array(explainedTransaction).max(20),
    truncated: z.boolean(),
    ...withFreshness,
  });
const searchedTransaction = explainedTransaction.extend({
  merchantName: name.nullable(),
  kind: z.enum(['ordinary', 'transfer']),
  memo: z
    .string()
    .max(240)
    .refine((value) => value === value.normalize('NFC').trim())
    .nullable(),
});
export const transactionSearchResultSchema =
  transactionSearchQuerySchema.extend({
    transactions: z.array(searchedTransaction).max(20),
    matchedTransactionCount: count,
    expenseMinorUnits: nonnegativeMoney,
    incomeMinorUnits: nonnegativeMoney,
    netCashFlowMinorUnits: safeMoney,
    truncated: z.boolean(),
    ...withFreshness,
  });
const needsCategorizationTransaction = z.strictObject({
  date: isoDate,
  merchantName: name.nullable(),
  accountName: name,
  amountMinorUnits: safeMoney,
  cleared: z.boolean(),
  kind: z.enum(['ordinary', 'cashback']),
  memo: z
    .string()
    .max(240)
    .refine((value) => value === value.normalize('NFC').trim())
    .nullable(),
});
export const needsCategorizationResultSchema =
  needsCategorizationQuerySchema.extend({
    transactions: z.array(needsCategorizationTransaction).max(20),
    matchedTransactionCount: count,
    truncated: z.boolean(),
    ...withFreshness,
  });
const categoryContribution = z.strictObject({
  merchantName: name,
  netSpentMinorUnits: safeMoney,
  transactionCount: count,
});
const evidenceCount = z.strictObject({
  evidence: categorizationEvidence,
  transactionCount: count,
});
export const categoryExplanationResultSchema = categoryExplanationQuerySchema
  .omit({ limit: true })
  .extend({
    netSpentMinorUnits: safeMoney,
    transactionCount: count,
    topContributions: z.array(categoryContribution).max(20),
    categorizationEvidence: z.array(evidenceCount).max(2),
    truncated: z.boolean(),
    ...withFreshness,
  });
const receiptSearchPaymentEvidence = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('masked-card'),
    lastFour: z.string().regex(/^\d{4}$/),
  }),
  z.strictObject({
    kind: z.enum(['cash', 'unknown']),
    lastFour: z.null(),
  }),
]);
const receiptSearchHouseholdNote = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value === value.normalize('NFC').trim());
const receiptSearchRow = z.strictObject({
  merchant: name.max(500).nullable(),
  purchaseDate: isoDate.nullable(),
  purchaseTime: z.iso.time().nullable(),
  timezoneOffset: z
    .string()
    .regex(/^[+-](?:0\d|1[0-4]):[0-5]\d$/)
    .nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  amounts: z.strictObject({
    subtotalMinorUnits: nonnegativeMoney.nullable(),
    taxMinorUnits: nonnegativeMoney.nullable(),
    discountMinorUnits: nonnegativeMoney.nullable(),
    tipMinorUnits: nonnegativeMoney.nullable(),
    totalMinorUnits: nonnegativeMoney.nullable(),
  }),
  paymentEvidence: receiptSearchPaymentEvidence,
  receiptReference: name.max(500).nullable(),
  householdNotes: z.array(receiptSearchHouseholdNote).max(3),
  items: z
    .array(
      z.strictObject({
        description: name.max(500).nullable(),
        quantity: z.number().finite().positive().max(100_000).nullable(),
        unitPriceMinorUnits: nonnegativeMoney.nullable(),
        totalMinorUnits: nonnegativeMoney.nullable(),
      }),
    )
    .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_ITEMS),
  automaticProcessingBlocked: z.boolean(),
  itemDetailsComplete: z.boolean(),
  sourceCount: z
    .number()
    .int()
    .safe()
    .min(1)
    .max(MAX_HOUSEHOLD_FINANCE_RECEIPT_SOURCES),
  extractedAt: z.iso.datetime({ offset: true }),
});
export const receiptSearchResultSchema = receiptSearchQuerySchema.extend({
  receipts: z.array(receiptSearchRow).max(50),
  matchedReceiptCount: count,
  truncated: z.boolean(),
  ...withFreshness,
});
const receiptNoteRecordSchema = z
  .strictObject({
    noteId: z.string().startsWith(ACTUAL_RECEIPT_NOTE_PREFIX).max(100),
    record: householdFinanceReceiptRecordSchema,
    canonicalJson: z
      .string()
      .min(1)
      .max(128 * 1024),
    sha256: hash,
  })
  .superRefine((value, context) => {
    try {
      const parsed = parseHouseholdFinanceReceiptNote(
        value.noteId,
        value.canonicalJson,
      );
      if (
        canonicalHouseholdFinanceReceiptJson(value.record) !==
          value.canonicalJson ||
        parsed.sha256 !== value.sha256
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Receipt note record does not match canonical content',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Receipt note record is invalid',
      });
    }
  });
export const receiptRecordListResultSchema = z.strictObject({
  records: z.array(receiptNoteRecordSchema).max(50),
  nextAfterNoteId: z
    .string()
    .startsWith(ACTUAL_RECEIPT_NOTE_PREFIX)
    .max(100)
    .nullable(),
  truncated: z.boolean(),
});

export const actualReadSyncResultSchema = z.strictObject({
  outcome: z.enum(['succeeded', 'partial', 'failed', 'skipped-recent']),
  freshness,
});

export const importedTransactionObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(
      ACTUAL_IMPORTED_TRANSACTION_OBSERVATION_SCHEMA_VERSION,
    ),
    transactionId: z.string().min(1).max(200),
    importedId: z.string().min(1).max(500),
    accountAlias: alias,
    accountRole,
    accountOnBudget: z.boolean(),
    accountLastFour: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
    date: isoDate,
    amountMinorUnits: safeMoney.refine((value) => value !== 0),
    direction: z.enum(['expense', 'refund', 'income']),
    payeeName: name.nullable(),
    memo: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => value === value.normalize('NFKC').trim())
      .nullable(),
    currentCategoryAlias: alias.nullable(),
    currentCategoryName: categoryName.nullable(),
    currentCategoryStatus: z.enum([
      'uncategorized',
      'contract-bound',
      'unbound',
      'split',
    ]),
    split: z.boolean(),
    cleared: z.boolean(),
    specialKind: z.enum([
      'transfer',
      'card-payment',
      'debt-payment',
      'cashback',
      'refund',
      'ordinary',
    ]),
    alreadyLinkedReceipts: z
      .array(
        z.strictObject({
          receiptId: z.uuid(),
          sourceSha256: hash,
        }),
      )
      .max(32)
      .refine(
        (values) =>
          new Set(
            values.map((value) => `${value.receiptId}\0${value.sourceSha256}`),
          ).size === values.length,
      ),
    observationFingerprint: hash,
  })
  .superRefine((value, context) => {
    const bound =
      value.currentCategoryAlias !== null && value.currentCategoryName !== null;
    if (
      bound !== (value.currentCategoryStatus === 'contract-bound') ||
      (value.currentCategoryAlias === null) !==
        (value.currentCategoryName === null) ||
      value.split !== (value.currentCategoryStatus === 'split') ||
      (value.specialKind === 'refund') !== (value.direction === 'refund')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Imported transaction observation is inconsistent',
      });
    }
  });

export const importedTransactionScanResultSchema = z.strictObject({
  schemaVersion: z.literal(ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION),
  startDate: isoDate,
  endDate: isoDate,
  observations: z.array(importedTransactionObservationSchema).max(500),
  watermark: hash,
  importFreshnessToken: hash,
  unchanged: z.boolean(),
  ...withFreshness,
});

export const importedTransactionCandidatesSchema = z
  .array(importedTransactionCandidateSchema)
  .max(200);

const actualTransactionObservation = z.custom<ActualTransactionObservationV1>(
  (value) => {
    try {
      assertActualTransactionObservation(
        value as ActualTransactionObservationV1,
      );
      return true;
    } catch {
      return false;
    }
  },
);

export const prepareCategorizationUpdateResultSchema = z.strictObject({
  schemaVersion: z.literal(
    ACTUAL_CATEGORIZATION_UPDATE_PREPARATION_SCHEMA_VERSION,
  ),
  observed: actualTransactionObservation,
  categories: z
    .array(
      z.strictObject({
        alias,
        categoryId: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(100)
    .superRefine((categories, context) => {
      if (
        new Set(categories.map((category) => category.alias)).size !==
          categories.length ||
        new Set(categories.map((category) => category.categoryId)).size !==
          categories.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Prepared categories must be unique',
        });
      }
    }),
  ...withFreshness,
});

export function parseCategorySpendQuery(value: unknown): CategorySpendQuery {
  return dateRange(parse(categorySpendQuerySchema, value));
}
export function parseMerchantSpendQuery(value: unknown): MerchantSpendQuery {
  return dateRange(parse(merchantSpendQuerySchema, value));
}
export function parseIncomeQuery(value: unknown): IncomeQuery {
  return dateRange(parse(incomeQuerySchema, value));
}
export function parseCashFlowQuery(value: unknown): CashFlowQuery {
  return dateRange(parse(cashFlowQuerySchema, value));
}
export function parseAccountBalancesQuery(
  value: unknown,
): AccountBalancesQuery {
  return dated(parse(accountBalancesQuerySchema, value));
}
export function parseAvailableFundsQuery(value: unknown): AvailableFundsQuery {
  return dated(parse(availableFundsQuerySchema, value));
}
export function parseUpcomingBillsQuery(value: unknown): UpcomingBillsQuery {
  const parsed = parse(upcomingBillsQuerySchema, value);
  dateRange({ startDate: parsed.fromDate, endDate: parsed.throughDate });
  return parsed;
}
export function parseBudgetCapacityQuery(value: unknown): BudgetCapacityQuery {
  return month(parse(budgetCapacityQuerySchema, value));
}
export function parseBudgetProgressQuery(value: unknown): BudgetProgressQuery {
  return month(parse(budgetProgressQuerySchema, value));
}
export function parseOverspendingQuery(value: unknown): OverspendingQuery {
  return month(parse(overspendingQuerySchema, value));
}
export function parseTransactionExplanationQuery(
  value: unknown,
): TransactionExplanationQuery {
  return dateRange(parse(transactionExplanationQuerySchema, value));
}
export function parseTransactionSearchQuery(
  value: unknown,
): TransactionSearchQuery {
  return dateRange(parse(transactionSearchQuerySchema, value));
}
export function parseNeedsCategorizationQuery(
  value: unknown,
): NeedsCategorizationQuery {
  return dateRange(parse(needsCategorizationQuerySchema, value));
}
export function parseCategoryExplanationQuery(
  value: unknown,
): CategoryExplanationQuery {
  return dateRange(parse(categoryExplanationQuerySchema, value));
}
export function parseReceiptSearchQuery(value: unknown): ReceiptSearchQuery {
  return dateRange(parse(receiptSearchQuerySchema, value));
}
export function parseReceiptRecordListQuery(
  value: unknown,
): ReceiptRecordListQuery {
  return parse(receiptRecordListQuerySchema, value);
}
export function parseImportedTransactionScanQuery(
  value: unknown,
): ActualImportedTransactionScanQuery {
  return dateRange(parse(importedTransactionScanQuerySchema, value));
}
export function parseReceiptMatchIntent(value: unknown): ReceiptMatchIntent {
  return parse(receiptMatchIntentSchema, value);
}
export function parsePrepareCategorizationUpdateRequest(
  value: unknown,
): ActualPrepareCategorizationUpdateRequest {
  const parsed = parse(prepareCategorizationUpdateRequestSchema, value);
  if (!validIsoDate(parsed.date)) {
    throw new ActualReadProtocolError();
  }
  return parsed;
}

export const parseActualReadCatalog = (value: unknown): ActualReadCatalog =>
  parse(actualReadCatalogSchema, value);
export const parseCategorySpendResult = (value: unknown): CategorySpendResult =>
  parse(categorySpendResultSchema, value);
export const parseMerchantSpendResult = (value: unknown): MerchantSpendResult =>
  parse(merchantSpendResultSchema, value);
export const parseIncomeResult = (value: unknown): IncomeResult =>
  parse(incomeResultSchema, value);
export const parseCashFlowResult = (value: unknown): CashFlowResult =>
  parse(cashFlowResultSchema, value);
export const parseAccountBalancesResult = (
  value: unknown,
): AccountBalancesResult => parse(accountBalancesResultSchema, value);
export const parseAvailableFundsResult = (
  value: unknown,
): AvailableFundsResult => parse(availableFundsResultSchema, value);
export const parseUpcomingBillsResult = (value: unknown): UpcomingBillsResult =>
  parse(upcomingBillsResultSchema, value);
export const parseBudgetCapacityResult = (
  value: unknown,
): BudgetCapacityResult => parse(budgetCapacityResultSchema, value);
export const parseBudgetProgressResult = (
  value: unknown,
): BudgetProgressResult => parse(budgetProgressResultSchema, value);
export const parseOverspendingResult = (value: unknown): OverspendingResult =>
  parse(overspendingResultSchema, value);
export const parseTransactionExplanationResult = (
  value: unknown,
): TransactionExplanationResult =>
  parse(transactionExplanationResultSchema, value);
export const parseTransactionSearchResult = (
  value: unknown,
): TransactionSearchResult => parse(transactionSearchResultSchema, value);
export const parseNeedsCategorizationResult = (
  value: unknown,
): NeedsCategorizationResult => parse(needsCategorizationResultSchema, value);
export const parseCategoryExplanationResult = (
  value: unknown,
): CategoryExplanationResult => parse(categoryExplanationResultSchema, value);
export const parseReceiptSearchResult = (value: unknown): ReceiptSearchResult =>
  dateRange(parse(receiptSearchResultSchema, value));
export const parseReceiptRecordListResult = (
  value: unknown,
): ReceiptRecordListResult => parse(receiptRecordListResultSchema, value);
export const parseActualReadFreshness = (value: unknown): ActualReadFreshness =>
  parse(freshness, value);
export const parseActualReadSyncResult = (
  value: unknown,
): ActualReadSyncResult => parse(actualReadSyncResultSchema, value);
export const parseImportedTransactionScanResult = (
  value: unknown,
): ActualImportedTransactionScanResult =>
  dateRange(parse(importedTransactionScanResultSchema, value));
export const parseImportedTransactionObservation = (
  value: unknown,
): ActualImportedTransactionObservation =>
  parse(importedTransactionObservationSchema, value);
export const parseImportedTransactionCandidates = (
  value: unknown,
): readonly ImportedTransactionCandidate[] =>
  parse(importedTransactionCandidatesSchema, value);
export const parsePrepareCategorizationUpdateResult = (
  value: unknown,
): ActualPrepareCategorizationUpdateResult =>
  parse(prepareCategorizationUpdateResultSchema, value);
