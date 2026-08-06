import type { ActualTransactionObservationV1 } from '../actual-update/domain.js';
import type {
  ImportedTransactionCandidate,
  ReceiptMatchIntent,
} from '../matching/receipt-transaction.js';
import type { ActualReceiptNoteRecord } from '../receipt-record/domain.js';

export const ACTUAL_READ_CURRENCY = 'CAD' as const;
export const ACTUAL_READ_BUDGET_CAPACITY_METHOD =
  'actual-to-budget-ceiling-only' as const;
export const ACTUAL_READ_AVAILABLE_FUNDS_METHOD =
  'actual-envelope-summary' as const;
export const ACTUAL_IMPORTED_TRANSACTION_OBSERVATION_SCHEMA_VERSION =
  'actual-imported-transaction-observation.v1' as const;
export const ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION =
  'actual-imported-transaction-scan.v1' as const;
export const ACTUAL_CATEGORIZATION_UPDATE_PREPARATION_SCHEMA_VERSION =
  'actual-categorization-update-preparation.v1' as const;

export type ActualReadSyncOutcome =
  'never' | 'succeeded' | 'failed' | 'skipped-recent';

export interface ActualReadFreshness {
  readonly actualBudgetAsOf: string;
  readonly bankFeedAsOf: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastOutcome: ActualReadSyncOutcome;
  readonly isFresh: boolean;
  readonly expectedBankDelayHours: number;
}

export interface ActualReadResult {
  readonly freshness: ActualReadFreshness;
}

export interface ActualReadCatalog extends ActualReadResult {
  readonly currency: typeof ACTUAL_READ_CURRENCY;
  readonly accountNames: readonly string[];
  readonly categoryNames: readonly string[];
  readonly merchantNames: readonly string[];
}

export interface CategorySpendQuery {
  readonly categoryName: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface CategorySpendResult
  extends CategorySpendQuery, ActualReadResult {
  readonly expenseMinorUnits: number;
  readonly refundMinorUnits: number;
  readonly netSpentMinorUnits: number;
  readonly transactionCount: number;
  readonly uncategorizedExpenseMinorUnits: number;
  readonly uncategorizedTransactionCount: number;
}

export interface MerchantSpendQuery {
  readonly merchantName: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface MerchantSpendResult
  extends MerchantSpendQuery, ActualReadResult {
  readonly expenseMinorUnits: number;
  readonly refundMinorUnits: number;
  readonly netSpentMinorUnits: number;
  readonly transactionCount: number;
  readonly uncategorizedExpenseMinorUnits: number;
  readonly uncategorizedTransactionCount: number;
}

export interface CashFlowQuery {
  readonly startDate: string;
  readonly endDate: string;
}

export interface CashFlowResult extends CashFlowQuery, ActualReadResult {
  readonly incomeMinorUnits: number;
  readonly spendingMinorUnits: number;
  readonly netCashFlowMinorUnits: number;
  readonly incomeTransactionCount: number;
  readonly spendingTransactionCount: number;
}

export type ActualReadAccountRole =
  | 'spending'
  | 'credit-card'
  | 'cashback-staging'
  | 'savings'
  | 'debt'
  | 'other';

export interface AccountBalancesQuery {
  readonly accountName: string | null;
  readonly asOfDate: string;
}

export interface AccountBalanceRow {
  readonly name: string;
  readonly role: ActualReadAccountRole;
  readonly onBudget: boolean;
  readonly balanceMinorUnits: number;
}

export interface AccountBalancesResult
  extends AccountBalancesQuery, ActualReadResult {
  readonly accounts: readonly AccountBalanceRow[];
  readonly totalBalanceMinorUnits: number;
}

export interface AvailableFundsQuery {
  readonly asOfDate: string;
}

export interface AvailableFundsResult
  extends AvailableFundsQuery, ActualReadResult {
  readonly onBudgetCashMinorUnits: number;
  readonly availableToBudgetMinorUnits: number;
  readonly fundedCategoryBalanceMinorUnits: number;
  readonly upcomingObligationsMinorUnits: number;
  readonly availableFundsMinorUnits: number;
  readonly method: typeof ACTUAL_READ_AVAILABLE_FUNDS_METHOD;
}

export interface IncomeQuery {
  readonly startDate: string;
  readonly endDate: string;
}

export interface IncomeResult extends IncomeQuery, ActualReadResult {
  readonly incomeMinorUnits: number;
  readonly transactionCount: number;
}

export interface UpcomingBillsQuery {
  readonly fromDate: string;
  readonly throughDate: string;
}

export interface UpcomingBill {
  readonly name: string;
  readonly dueDate: string;
  readonly amountMinorUnits: number;
  readonly amountCertain: boolean;
}

export interface UpcomingBillsResult
  extends UpcomingBillsQuery, ActualReadResult {
  /** Actual exposes only the next occurrence of each active schedule. */
  readonly bills: readonly UpcomingBill[];
}

export interface BudgetCapacityQuery {
  readonly month: string;
  readonly targetCategoryName: string;
}

export interface BudgetCapacityTargetCategory {
  readonly name: string;
  readonly budgetedMinorUnits: number;
  /** Positive means net expense; a refund-only month can make this negative. */
  readonly spentMinorUnits: number;
  readonly balanceMinorUnits: number;
}

export interface BudgetCapacityResult
  extends BudgetCapacityQuery, ActualReadResult {
  readonly toBudgetMinorUnits: number;
  readonly ceilingMinorUnits: number;
  readonly method: typeof ACTUAL_READ_BUDGET_CAPACITY_METHOD;
  readonly targetCategory?: BudgetCapacityTargetCategory | undefined;
}

export interface BudgetProgressQuery {
  readonly month: string;
  readonly categoryName: string | null;
}

export interface BudgetProgressCategory {
  readonly name: string;
  readonly budgetedMinorUnits: number;
  readonly spentMinorUnits: number;
  readonly balanceMinorUnits: number;
  readonly overspentMinorUnits: number;
}

export interface BudgetProgressResult
  extends BudgetProgressQuery, ActualReadResult {
  readonly categories: readonly BudgetProgressCategory[];
  readonly totalBudgetedMinorUnits: number;
  readonly totalSpentMinorUnits: number;
  readonly totalBalanceMinorUnits: number;
}

export interface OverspendingQuery {
  readonly month: string;
}

export interface OverspentCategory {
  readonly name: string;
  readonly overspentMinorUnits: number;
}

export interface OverspendingResult
  extends OverspendingQuery, ActualReadResult {
  readonly categories: readonly OverspentCategory[];
  readonly totalOverspentMinorUnits: number;
}

export interface TransactionExplanationQuery {
  readonly startDate: string;
  readonly endDate: string;
  readonly merchantName: string;
  readonly limit: number;
}

export type ActualReadCategorizationEvidence =
  'actual-ledger' | 'uncategorized';

export interface TransactionExplanation {
  readonly date: string;
  readonly merchantName: string;
  readonly accountName: string;
  readonly amountMinorUnits: number;
  readonly categoryNames: readonly string[];
  readonly split: boolean;
  readonly cleared: boolean;
  readonly categorizationEvidence: ActualReadCategorizationEvidence;
}

export interface TransactionExplanationResult extends ActualReadResult {
  readonly startDate: string;
  readonly endDate: string;
  readonly merchantName: string;
  readonly transactions: readonly TransactionExplanation[];
  readonly truncated: boolean;
}

export type TransactionSearchDirection = 'any' | 'expense' | 'income';
export type TransactionSearchKind = 'any' | 'ordinary' | 'transfer';
export type TransactionSearchCategorization =
  'any' | 'categorized' | 'uncategorized';
export type TransactionSearchSort = 'date-desc' | 'amount-desc';

/**
 * General-purpose public ledger read. Every nullable name is matched exactly
 * against the validated public catalog. The result contains useful household
 * details but no Actual IDs, imported IDs, or raw unsanitized notes.
 */
export interface TransactionSearchQuery {
  readonly startDate: string;
  readonly endDate: string;
  readonly accountName: string | null;
  readonly merchantName: string | null;
  readonly categoryName: string | null;
  /**
   * Exact magnitude in CAD cents, irrespective of expense/income sign.
   */
  readonly absoluteAmountMinorUnits: number | null;
  readonly kind: TransactionSearchKind;
  readonly direction: TransactionSearchDirection;
  readonly categorization: TransactionSearchCategorization;
  readonly sort: TransactionSearchSort;
  readonly limit: number;
}

export interface TransactionSearchRow {
  readonly date: string;
  readonly merchantName: string | null;
  readonly accountName: string;
  readonly amountMinorUnits: number;
  readonly categoryNames: readonly string[];
  readonly split: boolean;
  readonly cleared: boolean;
  readonly categorizationEvidence: ActualReadCategorizationEvidence;
  readonly kind: Exclude<TransactionSearchKind, 'any'>;
  readonly memo: string | null;
}

export interface TransactionSearchResult
  extends TransactionSearchQuery, ActualReadResult {
  readonly transactions: readonly TransactionSearchRow[];
  readonly matchedTransactionCount: number;
  readonly expenseMinorUnits: number;
  readonly incomeMinorUnits: number;
  readonly netCashFlowMinorUnits: number;
  readonly truncated: boolean;
}

export interface NeedsCategorizationQuery {
  readonly startDate: string;
  readonly endDate: string;
  readonly sort: TransactionSearchSort;
  readonly limit: number;
}

export interface NeedsCategorizationRow {
  readonly date: string;
  readonly merchantName: string | null;
  readonly accountName: string;
  readonly amountMinorUnits: number;
  readonly cleared: boolean;
  readonly kind: Extract<
    ActualImportedTransactionSpecialKind,
    'ordinary' | 'cashback'
  >;
  readonly memo: string | null;
}

/**
 * Bounded candidate view for categorization. It intentionally excludes
 * transfers, payments, splits, off-budget accounts, and transactions that are
 * already categorized. Receipt and in-flight write ownership are rechecked at
 * the write boundary.
 */
export interface NeedsCategorizationResult
  extends NeedsCategorizationQuery, ActualReadResult {
  readonly transactions: readonly NeedsCategorizationRow[];
  readonly matchedTransactionCount: number;
  readonly truncated: boolean;
}

export interface CategoryExplanationQuery {
  readonly startDate: string;
  readonly endDate: string;
  readonly categoryName: string;
  readonly limit: number;
}

export interface CategoryExplanationContribution {
  readonly merchantName: string;
  readonly netSpentMinorUnits: number;
  readonly transactionCount: number;
}

export interface CategoryExplanationEvidenceCount {
  readonly evidence: ActualReadCategorizationEvidence;
  readonly transactionCount: number;
}

export interface CategoryExplanationResult extends ActualReadResult {
  readonly startDate: string;
  readonly endDate: string;
  readonly categoryName: string;
  readonly netSpentMinorUnits: number;
  readonly transactionCount: number;
  readonly topContributions: readonly CategoryExplanationContribution[];
  readonly categorizationEvidence: readonly CategoryExplanationEvidenceCount[];
  readonly truncated: boolean;
}

export interface ReceiptSearchQuery {
  readonly startDate: string;
  readonly endDate: string;
  /**
   * Case-insensitive words matched against merchant, receipt reference,
   * household notes, and printed item descriptions. Every word must occur
   * somewhere in a receipt.
   */
  readonly textQuery: string | null;
  /** Case-insensitive merchant substring, or null for every merchant. */
  readonly merchantQuery: string | null;
  readonly limit: number;
}

export interface ReceiptSearchRow {
  readonly merchant: string | null;
  readonly purchaseDate: string | null;
  readonly purchaseTime: string | null;
  readonly timezoneOffset: string | null;
  readonly currency: string | null;
  readonly amounts: {
    readonly subtotalMinorUnits: number | null;
    readonly taxMinorUnits: number | null;
    readonly discountMinorUnits: number | null;
    readonly tipMinorUnits: number | null;
    readonly totalMinorUnits: number | null;
  };
  readonly paymentEvidence:
    | { readonly kind: 'masked-card'; readonly lastFour: string }
    | { readonly kind: 'cash' | 'unknown'; readonly lastFour: null };
  readonly receiptReference: string | null;
  /** Up to the latest three authenticated household purpose notes, oldest first. */
  readonly householdNotes: readonly string[];
  readonly items: readonly {
    readonly description: string | null;
    readonly quantity: number | null;
    readonly unitPriceMinorUnits: number | null;
    readonly totalMinorUnits: number | null;
  }[];
  readonly automaticProcessingBlocked: boolean;
  /** False when stored item rows are absent, partial, or not an exact split. */
  readonly itemDetailsComplete: boolean;
  readonly sourceCount: number;
  readonly extractedAt: string;
}

export interface ReceiptSearchResult
  extends ReceiptSearchQuery, ActualReadResult {
  readonly receipts: readonly ReceiptSearchRow[];
  readonly matchedReceiptCount: number;
  readonly truncated: boolean;
}

export interface ActualReadSyncResult {
  readonly outcome: Exclude<ActualReadSyncOutcome, 'never'>;
  readonly freshness: ActualReadFreshness;
}

export type ActualImportedTransactionSpecialKind =
  | 'transfer'
  | 'card-payment'
  | 'debt-payment'
  | 'cashback'
  | 'refund'
  | 'ordinary';

export type ActualImportedTransactionDirection =
  'expense' | 'refund' | 'income';

export type ActualImportedTransactionCategoryStatus =
  'uncategorized' | 'contract-bound' | 'unbound' | 'split';

/**
 * Internal deterministic observation. Identifiers in this type are required
 * for idempotent writes and must never be included in a model payload.
 */
export interface ActualImportedTransactionObservation {
  readonly schemaVersion: typeof ACTUAL_IMPORTED_TRANSACTION_OBSERVATION_SCHEMA_VERSION;
  readonly transactionId: string;
  readonly importedId: string;
  readonly accountAlias: string;
  readonly accountRole: ActualReadAccountRole;
  readonly accountOnBudget: boolean;
  readonly accountLastFour: string | null;
  readonly date: string;
  readonly amountMinorUnits: number;
  readonly direction: ActualImportedTransactionDirection;
  readonly payeeName: string | null;
  readonly memo: string | null;
  readonly currentCategoryAlias: string | null;
  readonly currentCategoryName: string | null;
  readonly currentCategoryStatus: ActualImportedTransactionCategoryStatus;
  readonly split: boolean;
  readonly cleared: boolean;
  readonly specialKind: ActualImportedTransactionSpecialKind;
  readonly alreadyLinkedReceipts: readonly {
    readonly receiptId: string;
    readonly sourceSha256: string;
  }[];
  readonly observationFingerprint: string;
}

export interface ActualImportedTransactionScanQuery {
  /**
   * Actual exposes posting dates but no imported-at timestamp or bank-import
   * cursor. Callers therefore rescan a bounded posting-date window and use the
   * snapshot watermark plus stable IDs for idempotency.
   */
  readonly startDate: string;
  readonly endDate: string;
  /**
   * The prior result watermark. An equal snapshot returns no observations and
   * `unchanged: true`; a changed snapshot returns the complete bounded window.
   */
  readonly previousWatermark: string | null;
}

export interface ActualImportedTransactionScanResult extends ActualReadResult {
  readonly schemaVersion: typeof ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION;
  readonly startDate: string;
  readonly endDate: string;
  readonly observations: readonly ActualImportedTransactionObservation[];
  readonly watermark: string;
  readonly importFreshnessToken: string;
  readonly unchanged: boolean;
}

export interface ActualPrepareCategorizationUpdateRequest {
  readonly accountAlias: string;
  readonly transactionId: string;
  readonly importedId: string;
  readonly date: string;
  readonly amountMinorUnits: number;
  readonly expectedObservationFingerprint: string;
  readonly categoryAliases: readonly string[];
}

export interface ActualPreparedCategory {
  readonly alias: string;
  readonly categoryId: string;
}

export interface ActualPrepareCategorizationUpdateResult extends ActualReadResult {
  readonly schemaVersion: typeof ACTUAL_CATEGORIZATION_UPDATE_PREPARATION_SCHEMA_VERSION;
  readonly observed: ActualTransactionObservationV1;
  readonly categories: readonly ActualPreparedCategory[];
}

/**
 * Complete data-bearing boundary exposed to finance-bot. There is no generic
 * query method and no result can contain Actual IDs or raw ledger rows.
 */
export interface ActualReadPort {
  catalog(): Promise<ActualReadCatalog>;
  accountBalances(query: AccountBalancesQuery): Promise<AccountBalancesResult>;
  availableFunds(query: AvailableFundsQuery): Promise<AvailableFundsResult>;
  categorySpend(query: CategorySpendQuery): Promise<CategorySpendResult>;
  merchantSpend(query: MerchantSpendQuery): Promise<MerchantSpendResult>;
  income(query: IncomeQuery): Promise<IncomeResult>;
  cashFlow(query: CashFlowQuery): Promise<CashFlowResult>;
  upcomingBills(query: UpcomingBillsQuery): Promise<UpcomingBillsResult>;
  budgetCapacity(query: BudgetCapacityQuery): Promise<BudgetCapacityResult>;
  budgetProgress(query: BudgetProgressQuery): Promise<BudgetProgressResult>;
  overspending(query: OverspendingQuery): Promise<OverspendingResult>;
  transactionExplanation(
    query: TransactionExplanationQuery,
  ): Promise<TransactionExplanationResult>;
  transactionSearch(
    query: TransactionSearchQuery,
  ): Promise<TransactionSearchResult>;
  needsCategorization(
    query: NeedsCategorizationQuery,
  ): Promise<NeedsCategorizationResult>;
  categoryExplanation(
    query: CategoryExplanationQuery,
  ): Promise<CategoryExplanationResult>;
  searchReceipts(query: ReceiptSearchQuery): Promise<ReceiptSearchResult>;
  syncNow(): Promise<ActualReadSyncResult>;
}

/**
 * Identifier-bearing internal plane for deterministic finance-bot code only.
 * Keep this interface out of model-facing question and categorization ports.
 */
export interface ActualDeterministicTransactionPort {
  scanImportedTransactions(
    query: ActualImportedTransactionScanQuery,
  ): Promise<ActualImportedTransactionScanResult>;
  candidatesForReceipt(
    intent: ReceiptMatchIntent,
  ): Promise<readonly ImportedTransactionCandidate[]>;
  prepareCategorizationUpdate(
    request: ActualPrepareCategorizationUpdateRequest,
  ): Promise<ActualPrepareCategorizationUpdateResult>;
}

/**
 * Full canonical receipt records for deterministic recovery and reconciliation
 * only. This interface must not be passed to a model-facing constructor.
 */
export interface ActualReceiptRecordReadPort {
  receiptRecords(
    query: ReceiptRecordListQuery,
  ): Promise<ReceiptRecordListResult>;
}

export interface ReceiptRecordListQuery {
  readonly afterNoteId: string | null;
  readonly limit: number;
}

export interface ReceiptRecordListResult {
  readonly records: readonly ActualReceiptNoteRecord[];
  readonly nextAfterNoteId: string | null;
  readonly truncated: boolean;
}

export interface ActualReadServicePort
  extends
    ActualReadPort,
    ActualDeterministicTransactionPort,
    ActualReceiptRecordReadPort {}

export type ActualReadNotFoundKind = 'account' | 'category' | 'merchant';

export class ActualReadNotFoundError extends Error {
  constructor(readonly kind: ActualReadNotFoundKind) {
    super(`Actual read value was not found: ${kind}`);
    this.name = 'ActualReadNotFoundError';
  }
}

export class ActualReadDataError extends Error {
  constructor() {
    super('Actual returned data outside the read-side contract');
    this.name = 'ActualReadDataError';
  }
}

export type ActualPrepareCategorizationUpdateRefusalCode =
  | 'target-not-found'
  | 'target-changed'
  | 'target-unsupported'
  | 'category-not-allowed';

export class ActualPrepareCategorizationUpdateRefusedError extends Error {
  constructor(readonly code: ActualPrepareCategorizationUpdateRefusalCode) {
    super(`Actual categorization update preparation refused: ${code}`);
    this.name = 'ActualPrepareCategorizationUpdateRefusedError';
  }
}
