import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ensurePrivateActualApiDataDirectory } from '../integrations/actual/actual-api-data-directory.js';
import { collapseActualBudgetRepresentations } from '../integrations/actual/actual-budget-representations.js';
import {
  captureActualTransactionObservation,
  type ActualTransactionObservationV1,
} from '../actual-update/domain.js';
import type { ActualUpdateTransactionRecord } from '../actual-update/port.js';
import {
  defaultReceiptMatchPolicy,
  plausibleForeignLedgerAmount,
  type ImportedTransactionCandidate,
  type ReceiptMatchIntent,
} from '../matching/receipt-transaction.js';
import {
  ACTUAL_RECEIPT_NOTE_PREFIX,
  MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
  parseHouseholdFinanceReceiptNote,
  receiptRecordItemDetailsComplete,
  type ActualReceiptNoteRecord,
} from '../receipt-record/domain.js';
import {
  FileActualReadFreshnessStore,
  type ActualReadFreshnessStore,
  type PersistedActualReadFreshness,
  publicActualReadFreshness,
} from './freshness-store.js';
import {
  ACTUAL_READ_AVAILABLE_FUNDS_METHOD,
  ACTUAL_READ_BUDGET_CAPACITY_METHOD,
  ACTUAL_READ_CURRENCY,
  ACTUAL_CATEGORIZATION_UPDATE_PREPARATION_SCHEMA_VERSION,
  ACTUAL_IMPORTED_TRANSACTION_OBSERVATION_SCHEMA_VERSION,
  ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION,
  ActualReadDataError,
  ActualReadNotFoundError,
  ActualPrepareCategorizationUpdateRefusedError,
  type AccountBalancesQuery,
  type AccountBalancesResult,
  type ActualReadCatalog,
  type ActualReadFreshness,
  type ActualImportedTransactionObservation,
  type ActualImportedTransactionScanQuery,
  type ActualImportedTransactionScanResult,
  type ActualImportedTransactionSpecialKind,
  type ActualPrepareCategorizationUpdateRequest,
  type ActualPrepareCategorizationUpdateResult,
  type ActualReadServicePort,
  type ActualReadSyncResult,
  type AvailableFundsQuery,
  type AvailableFundsResult,
  type BudgetCapacityQuery,
  type BudgetCapacityResult,
  type BudgetProgressCategory,
  type BudgetProgressQuery,
  type BudgetProgressResult,
  type CashFlowQuery,
  type CashFlowResult,
  type CategoryExplanationContribution,
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
  type NeedsCategorizationRow,
  type OverspendingQuery,
  type OverspendingResult,
  type ReceiptRecordListQuery,
  type ReceiptRecordListResult,
  type ReceiptSearchQuery,
  type ReceiptSearchResult,
  type ReceiptSearchRow,
  type TransactionExplanation,
  type TransactionExplanationQuery,
  type TransactionExplanationResult,
  type TransactionSearchQuery,
  type TransactionSearchResult,
  type TransactionSearchRow,
  type UpcomingBill,
  type UpcomingBillsQuery,
  type UpcomingBillsResult,
} from './port.js';
import {
  parseAccountBalancesQuery,
  parseAvailableFundsQuery,
  parseBudgetCapacityQuery,
  parseBudgetProgressQuery,
  parseCashFlowQuery,
  parseCategoryExplanationQuery,
  parseCategorySpendQuery,
  parseIncomeQuery,
  parseImportedTransactionScanQuery,
  parseMerchantSpendQuery,
  parseNeedsCategorizationQuery,
  parseOverspendingQuery,
  parseReceiptRecordListQuery,
  parseReceiptSearchQuery,
  parsePrepareCategorizationUpdateRequest,
  parseTransactionExplanationQuery,
  parseTransactionSearchQuery,
  parseUpcomingBillsQuery,
  parseReceiptMatchIntent,
  ActualReadProtocolError,
} from './protocol.js';
import {
  MAX_ACTUAL_RECEIPT_LINKS_PER_TRANSACTION,
  extractActualReceiptLink,
} from './receipt-link-token.js';
import type {
  ActualReadContract,
  ActualReadContractAccount,
} from './read-contract.js';

export interface ActualReadApiInitConfig {
  readonly dataDir: string;
  readonly serverURL: string;
  readonly password: string;
  readonly verbose?: boolean;
}
export interface ActualReadApiBudget {
  readonly id?: unknown;
  readonly cloudFileId?: unknown;
  readonly groupId?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
}
export interface ActualReadApiAccount {
  readonly id: string;
  readonly name: string;
  readonly offbudget?: boolean;
  readonly closed?: boolean;
}
export interface ActualReadApiCategory {
  readonly id: string;
  readonly name: string;
  readonly group_id: string;
  readonly is_income?: boolean;
  readonly hidden?: boolean;
}
export interface ActualReadApiCategoryGroup {
  readonly id: string;
  readonly name: string;
  readonly is_income?: boolean;
  readonly hidden?: boolean;
  readonly categories?: readonly ActualReadApiCategory[];
}
export interface ActualReadApiPayee {
  readonly id: string;
  readonly name: string;
  readonly transfer_acct?: string | null;
}
export interface ActualReadApiTransactionLine {
  readonly amount: number;
  readonly category?: string | null;
  readonly payee?: string | null;
  readonly notes?: string | null;
  readonly transfer_id?: string | null;
  readonly tombstone?: boolean;
  readonly cleared?: boolean;
}
export interface ActualReadApiTransaction extends ActualReadApiTransactionLine {
  readonly id: string;
  readonly imported_id?: string | null;
  readonly account: string;
  readonly date: string;
  readonly starting_balance_flag?: boolean;
  readonly is_child?: boolean;
  readonly subtransactions?: readonly ActualReadApiTransactionLine[];
  /**
   * Actual may add fields to the raw row. Preserve them for the writer's full
   * optimistic-lock fingerprint instead of projecting the row first.
   */
  readonly [field: string]: unknown;
}
export interface ActualReadApiSchedule {
  readonly id: string;
  readonly name?: string;
  readonly next_date?: string;
  readonly completed?: boolean;
  readonly payee?: string | null;
  readonly account?: string | null;
  readonly amount?: number | { readonly num1: number; readonly num2: number };
  readonly amountOp: 'is' | 'isapprox' | 'isbetween';
}
export interface ActualReadApiBudgetMonth {
  readonly month: string;
  readonly toBudget: number;
  readonly categoryGroups: readonly (Record<string, unknown> & {
    readonly categories?: readonly Record<string, unknown>[];
  })[];
}
export interface ActualReadApiAqlQuery {
  select(fields?: readonly string[]): ActualReadApiAqlQuery;
}
export interface ActualReadApiFacade {
  init(config: ActualReadApiInitConfig): Promise<unknown>;
  shutdown(): Promise<void>;
  downloadBudget(syncId: string): Promise<void>;
  sync(): Promise<void>;
  runBankSync(args: { readonly accountId: string }): Promise<void>;
  getBudgets(): Promise<readonly ActualReadApiBudget[]>;
  getAccounts(): Promise<readonly ActualReadApiAccount[]>;
  getAccountBalance(id: string, cutoff?: Date): Promise<number>;
  getCategoryGroups(options?: {
    readonly hidden?: boolean;
  }): Promise<readonly ActualReadApiCategoryGroup[]>;
  getPayees(): Promise<readonly ActualReadApiPayee[]>;
  getTransactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<readonly ActualReadApiTransaction[]>;
  getSchedules(): Promise<readonly ActualReadApiSchedule[]>;
  getBudgetMonth(month: string): Promise<ActualReadApiBudgetMonth>;
  q(table: string): ActualReadApiAqlQuery;
  aqlQuery(query: ActualReadApiAqlQuery): Promise<unknown>;
}
export type ActualReadApiFacadeLoader = () => Promise<ActualReadApiFacade>;

export interface ActualApiReadPortConfig {
  readonly dataDir: string;
  readonly serverURL: string;
  readonly serverPassword: string;
  readonly readContract: ActualReadContract;
}
export interface ActualApiReadPortOptions {
  readonly api?: ActualReadApiFacade;
  readonly apiLoader?: ActualReadApiFacadeLoader;
  readonly freshnessStore?: ActualReadFreshnessStore;
  readonly now?: () => Date;
  readonly startOperationWatchdog?: () => () => void;
}

type LifecycleState =
  'new' | 'initializing' | 'ready' | 'shutting-down' | 'closed' | 'failed';
interface BoundAccount extends ActualReadContractAccount {
  readonly alias: string;
}
interface Category {
  readonly id: string;
  readonly name: string;
  readonly isIncome: boolean;
  readonly visible: boolean;
  readonly alias: string | undefined;
}
interface Payee {
  readonly id: string;
  readonly name: string;
  readonly isTransfer: boolean;
  readonly transferAccountId: string | undefined;
}
interface LedgerContext {
  readonly accounts: readonly BoundAccount[];
  readonly accountById: ReadonlyMap<string, BoundAccount>;
  readonly categories: readonly Category[];
  readonly categoryById: ReadonlyMap<string, Category>;
  readonly payees: readonly Payee[];
  readonly payeeById: ReadonlyMap<string, Payee>;
}
interface NormalizedLine {
  readonly sourceTransactionKey: string;
  readonly sourceLineKey: string;
  readonly date: string;
  readonly account: BoundAccount;
  readonly amount: number;
  readonly category: Category | undefined;
  readonly payee: Payee | undefined;
  readonly kind: 'ordinary' | 'transfer';
  readonly split: boolean;
  readonly cleared: boolean;
  readonly memo: string | null;
}
interface NormalizedImportedTransaction {
  /**
   * Untouched source object from the same API response used to derive every
   * normalized guard below. This never crosses either read interface.
   */
  readonly raw: ActualReadApiTransaction;
  readonly transactionId: string;
  readonly importedId: string;
  readonly account: BoundAccount;
  readonly date: string;
  readonly amount: number;
  readonly payee: Payee | undefined;
  readonly memo: string | null;
  readonly category: Category | undefined;
  readonly categoryStatus:
    'uncategorized' | 'contract-bound' | 'unbound' | 'split';
  readonly split: boolean;
  readonly cleared: boolean;
  readonly specialKind: ActualImportedTransactionSpecialKind;
  readonly alreadyLinkedReceipts: readonly {
    readonly receiptId: string;
    readonly sourceSha256: string;
  }[];
}

export class ActualApiReadConfigurationError extends Error {
  constructor() {
    super('Actual read adapter configuration is invalid');
    this.name = 'ActualApiReadConfigurationError';
  }
}
export class ActualApiReadLifecycleError extends Error {
  constructor() {
    super('Actual read adapter lifecycle operation is invalid');
    this.name = 'ActualApiReadLifecycleError';
  }
}

const DAY_MS = 86_400_000;
const MAX_ACTUAL_NOTE_ROWS = 10_000;
const MAX_RECEIPT_SEARCH_ITEMS = 200;
const MAX_RECEIPT_SEARCH_HOUSEHOLD_NOTES = 3;
const MAX_RECEIPT_RECORD_PAGE_BYTES = 768 * 1024;
function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
}
function safeText(value: unknown, maximum = 500): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.normalize('NFC').trim() ||
    [...value].some(isControlCharacter)
  ) {
    throw new ActualReadDataError();
  }
  return value;
}
function safeMoney(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ActualReadDataError();
  }
  return value;
}
function add(left: number, right: number): number {
  return safeMoney(left + right);
}
function subtract(left: number, right: number): number {
  return safeMoney(left - right);
}
function magnitude(value: number): number {
  if (value >= 0) {
    throw new ActualReadDataError();
  }
  return safeMoney(-value);
}
function key(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase('en');
}
function receiptSearchKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function receiptSearchTokens(value: string | null): readonly string[] {
  if (value === null) return [];
  const normalized = receiptSearchKey(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}
function dateEpoch(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  ) {
    throw new ActualReadDataError();
  }
  return parsed;
}
function addCalendarDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new ActualReadDataError();
  return new Date(dateEpoch(value) + days * DAY_MS).toISOString().slice(0, 10);
}
function localCutoffDate(value: string): Date {
  dateEpoch(value);
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(year!, month! - 1, day!, 12, 0, 0, 0);
  if (
    result.getFullYear() !== year ||
    result.getMonth() !== month! - 1 ||
    result.getDate() !== day
  ) {
    throw new ActualReadDataError();
  }
  return result;
}
function assertRange(start: string, end: string, maximumDays: number): void {
  const days = (dateEpoch(end) - dateEpoch(start)) / DAY_MS + 1;
  if (!Number.isSafeInteger(days) || days < 1 || days > maximumDays) {
    throw new ActualReadProtocolError();
  }
}
function groupLines(
  lines: readonly NormalizedLine[],
): readonly (readonly NormalizedLine[])[] {
  const groups = new Map<string, NormalizedLine[]>();
  const lineKeys = new Set<string>();
  for (const line of lines) {
    if (lineKeys.has(line.sourceLineKey)) throw new ActualReadDataError();
    lineKeys.add(line.sourceLineKey);
    const group = groups.get(line.sourceTransactionKey) ?? [];
    group.push(line);
    groups.set(line.sourceTransactionKey, group);
  }
  return [...groups.values()];
}
function uniqueCategory(name: string, context: LedgerContext): Category {
  const matches = context.categories.filter(
    (candidate) => candidate.visible && key(candidate.name) === key(name),
  );
  if (matches.length === 0) {
    throw new ActualReadNotFoundError('category');
  }
  if (matches.length !== 1) {
    throw new ActualReadDataError();
  }
  return matches[0]!;
}
function matchingPayees(
  name: string,
  context: LedgerContext,
): readonly Payee[] {
  const matches = context.payees.filter(
    (candidate) => !candidate.isTransfer && key(candidate.name) === key(name),
  );
  if (matches.length === 0) {
    throw new ActualReadNotFoundError('merchant');
  }
  return matches;
}
function sanitizeMemo(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const withoutControlCharacters = [...value.normalize('NFKC')]
    .map((character) => (isControlCharacter(character) ? ' ' : character))
    .join('');
  const sanitized = withoutControlCharacters
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[redacted-email]')
    .replace(/(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/gu, '[redacted-number]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{15,}\b/giu, '[redacted-id]')
    .replace(/\b[0-9a-f]{24,}\b/giu, '[redacted-id]')
    .replace(/\b\d{6,}\b/gu, '[redacted-number]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
  return sanitized.length === 0 ? null : sanitized;
}
function scheduleExpense(
  schedule: ActualReadApiSchedule,
): { amountMinorUnits: number; amountCertain: boolean } | undefined {
  if (typeof schedule.amount === 'number') {
    const amount = safeMoney(schedule.amount);
    return amount < 0
      ? {
          amountMinorUnits: magnitude(amount),
          amountCertain: schedule.amountOp === 'is',
        }
      : undefined;
  }
  if (schedule.amount === undefined) {
    return undefined;
  }
  const candidates = [schedule.amount.num1, schedule.amount.num2]
    .map(safeMoney)
    .filter((amount) => amount < 0)
    .map(magnitude);
  return candidates.length === 0
    ? undefined
    : { amountMinorUnits: Math.max(...candidates), amountCertain: false };
}
function budgetMoney(row: Record<string, unknown>, field: string): number {
  return safeMoney(row[field]);
}
function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

async function defaultApiLoader(): Promise<ActualReadApiFacade> {
  const api = await import('@actual-app/api');
  return {
    init: (config) => api.init(config),
    shutdown: () => api.shutdown(),
    downloadBudget: (syncId) => api.downloadBudget(syncId),
    sync: () => api.sync(),
    runBankSync: (args) => api.runBankSync(args),
    getBudgets: () => api.getBudgets(),
    getAccounts: () => api.getAccounts(),
    getAccountBalance: (id, cutoff) => api.getAccountBalance(id, cutoff),
    getCategoryGroups: (options) => api.getCategoryGroups(options),
    getPayees: () => api.getPayees(),
    getTransactions: (accountId, startDate, endDate) =>
      api.getTransactions(accountId, startDate, endDate),
    getSchedules: () => api.getSchedules(),
    getBudgetMonth: (month) => api.getBudgetMonth(month),
    q: (table) => api.q(table),
    aqlQuery: (query) => api.aqlQuery(query as never),
  };
}

export class ActualApiReadPort implements ActualReadServicePort {
  readonly #config: ActualApiReadPortConfig;
  readonly #loader: ActualReadApiFacadeLoader;
  readonly #freshnessStore: ActualReadFreshnessStore;
  readonly #now: () => Date;
  readonly #startOperationWatchdog: (() => () => void) | undefined;
  #api: ActualReadApiFacade | undefined;
  #apiInitialized = false;
  #freshness: PersistedActualReadFreshness | undefined;
  #budgetAsOf: string | undefined;
  #state: LifecycleState = 'new';
  #tail: Promise<void> = Promise.resolve();

  constructor(
    config: ActualApiReadPortConfig,
    options: ActualApiReadPortOptions = {},
  ) {
    if (options.api !== undefined && options.apiLoader !== undefined) {
      throw new ActualApiReadConfigurationError();
    }
    this.#config = config;
    this.#api = options.api;
    this.#loader =
      options.apiLoader ??
      (options.api === undefined
        ? defaultApiLoader
        : async () => options.api as ActualReadApiFacade);
    this.#freshnessStore =
      options.freshnessStore ??
      new FileActualReadFreshnessStore(
        join(config.dataDir, 'freshness-state.json'),
      );
    this.#now = options.now ?? (() => new Date());
    this.#startOperationWatchdog = options.startOperationWatchdog;
  }

  get lifecycleState(): LifecycleState {
    return this.#state;
  }

  async initialize(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#state === 'ready') return;
      if (this.#state !== 'new') throw new ActualApiReadLifecycleError();
      this.#state = 'initializing';
      try {
        await ensurePrivateActualApiDataDirectory(this.#config.dataDir);
        this.#freshness = await this.#freshnessStore.load();
        if (this.#freshness.state === 'syncing') {
          this.#freshness = { ...this.#freshness, state: 'failed' };
          await this.#freshnessStore.save(this.#freshness);
        }
        const api = this.#api ?? (await this.#loader());
        this.#api = api;
        await api.init({
          dataDir: this.#config.dataDir,
          serverURL: this.#config.serverURL,
          password: this.#config.serverPassword,
          verbose: false,
        });
        this.#apiInitialized = true;
        await api.downloadBudget(this.#config.readContract.budget.syncId);
        await api.sync();
        this.#budgetAsOf = this.#validNow().toISOString();
        await this.#validateBoundary(api);
        this.#state = 'ready';
      } catch (error) {
        this.#state = 'failed';
        if (this.#apiInitialized) {
          await this.#api?.shutdown().catch(() => undefined);
        }
        this.#apiInitialized = false;
        throw error;
      }
    });
  }

  async shutdown(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#state === 'closed') return;
      if (this.#state === 'new') {
        this.#state = 'closed';
        return;
      }
      if (this.#state !== 'ready' && this.#state !== 'failed') {
        throw new ActualApiReadLifecycleError();
      }
      this.#state = 'shutting-down';
      try {
        if (this.#apiInitialized) await this.#api?.shutdown();
      } finally {
        this.#apiInitialized = false;
        this.#state = 'closed';
      }
    });
  }

  async syncNow(): Promise<ActualReadSyncResult> {
    return this.#exclusive(async () => {
      const api = this.#readyApi();
      const now = this.#validNow();
      const freshness = this.#requiredFreshness();
      if (
        freshness.lastAttemptAt !== null &&
        now.valueOf() - Date.parse(freshness.lastAttemptAt) <
          this.#config.readContract.bankSyncMinimumIntervalSeconds * 1_000
      ) {
        return {
          outcome: 'skipped-recent',
          freshness: this.#publicFreshness('skipped-recent'),
        };
      }
      const attemptedAt = now.toISOString();
      const syncing: PersistedActualReadFreshness = {
        ...freshness,
        generation: freshness.generation + 1,
        state: 'syncing',
        lastAttemptAt: attemptedAt,
      };
      await this.#freshnessStore.save(syncing);
      this.#freshness = syncing;

      let failed = false;
      for (const account of this.#boundAccounts().filter(
        (candidate) => candidate.bankSyncEnabled,
      )) {
        try {
          await api.runBankSync({ accountId: account.id });
        } catch {
          failed = true;
        }
      }
      try {
        await api.sync();
        this.#budgetAsOf = attemptedAt;
      } catch {
        failed = true;
      }
      const completed: PersistedActualReadFreshness = {
        ...syncing,
        state: failed ? 'failed' : 'succeeded',
        ...(failed ? {} : { lastSuccessfulSyncAt: attemptedAt }),
      };
      await this.#freshnessStore.save(completed);
      this.#freshness = completed;
      return {
        outcome: failed ? 'failed' : 'succeeded',
        freshness: this.#publicFreshness(),
      };
    });
  }

  async catalog(): Promise<ActualReadCatalog> {
    return this.#read(async (api, context) => ({
      currency: ACTUAL_READ_CURRENCY,
      accountNames: context.accounts
        .map((account) => account.name)
        .sort(compareText),
      categoryNames: context.categories
        .filter((category) => category.visible && !category.isIncome)
        .map((category) => category.name)
        .sort(compareText),
      merchantNames: [
        ...new Set(
          context.payees
            .filter((payee) => !payee.isTransfer)
            .map((payee) => payee.name),
        ),
      ].sort(compareText),
      freshness: this.#publicFreshness(),
    }));
  }

  async accountBalances(
    untrusted: AccountBalancesQuery,
  ): Promise<AccountBalancesResult> {
    const query = parseAccountBalancesQuery(untrusted);
    return this.#read(async (api, context) => {
      const accounts =
        query.accountName === null
          ? context.accounts
          : context.accounts.filter(
              (candidate) => key(candidate.name) === key(query.accountName!),
            );
      if (accounts.length === 0) {
        throw new ActualReadNotFoundError('account');
      }
      const cutoff = localCutoffDate(query.asOfDate);
      const rows = [];
      let total = 0;
      for (const account of accounts) {
        const balanceMinorUnits = safeMoney(
          await api.getAccountBalance(account.id, cutoff),
        );
        total = add(total, balanceMinorUnits);
        rows.push({
          name: account.name,
          role: account.role,
          onBudget: account.onBudget,
          balanceMinorUnits,
        });
      }
      rows.sort((left, right) => compareText(left.name, right.name));
      return {
        accountName: query.accountName === null ? null : accounts[0]!.name,
        asOfDate: query.asOfDate,
        accounts: rows,
        totalBalanceMinorUnits: total,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async availableFunds(
    untrusted: AvailableFundsQuery,
  ): Promise<AvailableFundsResult> {
    const query = parseAvailableFundsQuery(untrusted);
    return this.#read(async (api, context) => {
      const cutoff = localCutoffDate(query.asOfDate);
      let onBudgetCashMinorUnits = 0;
      for (const account of context.accounts.filter(
        (candidate) =>
          candidate.onBudget &&
          candidate.role !== 'credit-card' &&
          candidate.role !== 'debt',
      )) {
        onBudgetCashMinorUnits = add(
          onBudgetCashMinorUnits,
          safeMoney(await api.getAccountBalance(account.id, cutoff)),
        );
      }
      const budget = await this.#budgetMonth(api, query.asOfDate.slice(0, 7));
      let fundedCategoryBalanceMinorUnits = 0;
      for (const category of context.categories.filter(
        (candidate) => candidate.visible && !candidate.isIncome,
      )) {
        const row = this.#budgetCategoryRow(budget, category.id);
        if (row === undefined) throw new ActualReadDataError();
        fundedCategoryBalanceMinorUnits = add(
          fundedCategoryBalanceMinorUnits,
          Math.max(0, budgetMoney(row, 'balance')),
        );
      }
      const throughDate = addCalendarDays(query.asOfDate, 30);
      const schedules = await this.#upcomingBillRows(
        api,
        context,
        query.asOfDate,
        throughDate,
      );
      const upcomingObligationsMinorUnits = schedules.reduce(
        (total, bill) => add(total, bill.amountMinorUnits),
        0,
      );
      const availableToBudgetMinorUnits = safeMoney(budget.toBudget);
      return {
        asOfDate: query.asOfDate,
        onBudgetCashMinorUnits,
        availableToBudgetMinorUnits,
        fundedCategoryBalanceMinorUnits,
        upcomingObligationsMinorUnits,
        availableFundsMinorUnits: subtract(
          availableToBudgetMinorUnits,
          upcomingObligationsMinorUnits,
        ),
        method: ACTUAL_READ_AVAILABLE_FUNDS_METHOD,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async categorySpend(
    untrusted: CategorySpendQuery,
  ): Promise<CategorySpendResult> {
    const query = parseCategorySpendQuery(untrusted);
    this.#aggregateRange(query.startDate, query.endDate);
    return this.#read(async (api, context) => {
      const category = uniqueCategory(query.categoryName, context);
      const lines = await this.#lines(
        api,
        context,
        query.startDate,
        query.endDate,
      );
      let expense = 0;
      let refund = 0;
      let uncategorized = 0;
      const matched = new Set<string>();
      const uncategorizedTransactions = new Set<string>();
      for (const line of lines) {
        if (line.category === undefined && line.amount < 0) {
          uncategorized = add(uncategorized, magnitude(line.amount));
          uncategorizedTransactions.add(line.sourceTransactionKey);
        }
        if (line.category?.id !== category.id) continue;
        matched.add(line.sourceTransactionKey);
        if (line.amount < 0) expense = add(expense, magnitude(line.amount));
        else refund = add(refund, line.amount);
      }
      return {
        categoryName: category.name,
        startDate: query.startDate,
        endDate: query.endDate,
        expenseMinorUnits: expense,
        refundMinorUnits: refund,
        netSpentMinorUnits: subtract(expense, refund),
        transactionCount: matched.size,
        uncategorizedExpenseMinorUnits: uncategorized,
        uncategorizedTransactionCount: uncategorizedTransactions.size,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async merchantSpend(
    untrusted: MerchantSpendQuery,
  ): Promise<MerchantSpendResult> {
    const query = parseMerchantSpendQuery(untrusted);
    this.#aggregateRange(query.startDate, query.endDate);
    return this.#read(async (api, context) => {
      const payees = matchingPayees(query.merchantName, context);
      const ids = new Set(payees.map((payee) => payee.id));
      const lines = await this.#lines(
        api,
        context,
        query.startDate,
        query.endDate,
      );
      let expense = 0;
      let refund = 0;
      let uncategorized = 0;
      const transactions = new Set<string>();
      const uncategorizedTransactions = new Set<string>();
      for (const line of lines) {
        if (line.category === undefined && line.amount < 0) {
          uncategorized = add(uncategorized, magnitude(line.amount));
          uncategorizedTransactions.add(line.sourceTransactionKey);
        }
        if (line.payee === undefined || !ids.has(line.payee.id)) continue;
        transactions.add(line.sourceTransactionKey);
        if (line.amount < 0) expense = add(expense, magnitude(line.amount));
        else refund = add(refund, line.amount);
      }
      return {
        merchantName: payees[0]!.name,
        startDate: query.startDate,
        endDate: query.endDate,
        expenseMinorUnits: expense,
        refundMinorUnits: refund,
        netSpentMinorUnits: subtract(expense, refund),
        transactionCount: transactions.size,
        uncategorizedExpenseMinorUnits: uncategorized,
        uncategorizedTransactionCount: uncategorizedTransactions.size,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async income(untrusted: IncomeQuery): Promise<IncomeResult> {
    const query = parseIncomeQuery(untrusted);
    this.#aggregateRange(query.startDate, query.endDate);
    return this.#read(async (api, context) => {
      const lines = await this.#lines(
        api,
        context,
        query.startDate,
        query.endDate,
      );
      let incomeMinorUnits = 0;
      const transactions = new Set<string>();
      for (const line of lines) {
        if (
          line.amount <= 0 ||
          (line.category !== undefined && !line.category.isIncome)
        ) {
          continue;
        }
        incomeMinorUnits = add(incomeMinorUnits, line.amount);
        transactions.add(line.sourceTransactionKey);
      }
      return {
        ...query,
        incomeMinorUnits,
        transactionCount: transactions.size,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async cashFlow(untrusted: CashFlowQuery): Promise<CashFlowResult> {
    const query = parseCashFlowQuery(untrusted);
    this.#aggregateRange(query.startDate, query.endDate);
    return this.#read(async (api, context) => {
      const lines = await this.#lines(
        api,
        context,
        query.startDate,
        query.endDate,
      );
      let income = 0;
      let spending = 0;
      const incomeTransactions = new Set<string>();
      const spendingTransactions = new Set<string>();
      for (const line of lines) {
        if (line.amount < 0) {
          spending = add(spending, magnitude(line.amount));
          spendingTransactions.add(line.sourceTransactionKey);
        } else {
          income = add(income, line.amount);
          incomeTransactions.add(line.sourceTransactionKey);
        }
      }
      return {
        ...query,
        incomeMinorUnits: income,
        spendingMinorUnits: spending,
        netCashFlowMinorUnits: subtract(income, spending),
        incomeTransactionCount: incomeTransactions.size,
        spendingTransactionCount: spendingTransactions.size,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async upcomingBills(
    untrusted: UpcomingBillsQuery,
  ): Promise<UpcomingBillsResult> {
    const query = parseUpcomingBillsQuery(untrusted);
    this.#aggregateRange(query.fromDate, query.throughDate);
    return this.#read(async (api, context) => {
      const bills = await this.#upcomingBillRows(
        api,
        context,
        query.fromDate,
        query.throughDate,
      );
      return { ...query, bills, freshness: this.#publicFreshness() };
    });
  }

  async budgetCapacity(
    untrusted: BudgetCapacityQuery,
  ): Promise<BudgetCapacityResult> {
    const query = parseBudgetCapacityQuery(untrusted);
    return this.#read(async (api, context) => {
      const category = uniqueCategory(query.targetCategoryName, context);
      const budget = await this.#budgetMonth(api, query.month);
      const row = this.#budgetCategoryRow(budget, category.id);
      const targetCategory =
        row === undefined
          ? undefined
          : {
              name: category.name,
              budgetedMinorUnits: budgetMoney(row, 'budgeted'),
              spentMinorUnits: safeMoney(-budgetMoney(row, 'spent')),
              balanceMinorUnits: budgetMoney(row, 'balance'),
            };
      const toBudget = safeMoney(budget.toBudget);
      return {
        month: query.month,
        targetCategoryName: category.name,
        toBudgetMinorUnits: toBudget,
        ceilingMinorUnits: Math.max(0, toBudget),
        method: ACTUAL_READ_BUDGET_CAPACITY_METHOD,
        ...(targetCategory === undefined ? {} : { targetCategory }),
        freshness: this.#publicFreshness(),
      };
    });
  }

  async budgetProgress(
    untrusted: BudgetProgressQuery,
  ): Promise<BudgetProgressResult> {
    const query = parseBudgetProgressQuery(untrusted);
    return this.#read(async (api, context) => {
      const selected =
        query.categoryName === null
          ? context.categories.filter(
              (category) => category.visible && !category.isIncome,
            )
          : [uniqueCategory(query.categoryName, context)];
      const budget = await this.#budgetMonth(api, query.month);
      const categories: BudgetProgressCategory[] = [];
      let totalBudgetedMinorUnits = 0;
      let totalSpentMinorUnits = 0;
      let totalBalanceMinorUnits = 0;
      for (const category of selected) {
        const row = this.#budgetCategoryRow(budget, category.id);
        if (row === undefined) throw new ActualReadDataError();
        const budgetedMinorUnits = budgetMoney(row, 'budgeted');
        const spentMinorUnits = safeMoney(-budgetMoney(row, 'spent'));
        const balanceMinorUnits = budgetMoney(row, 'balance');
        totalBudgetedMinorUnits = add(
          totalBudgetedMinorUnits,
          budgetedMinorUnits,
        );
        totalSpentMinorUnits = add(totalSpentMinorUnits, spentMinorUnits);
        totalBalanceMinorUnits = add(totalBalanceMinorUnits, balanceMinorUnits);
        categories.push({
          name: category.name,
          budgetedMinorUnits,
          spentMinorUnits,
          balanceMinorUnits,
          overspentMinorUnits: Math.max(0, -balanceMinorUnits),
        });
      }
      categories.sort((left, right) => compareText(left.name, right.name));
      return {
        month: query.month,
        categoryName: query.categoryName === null ? null : selected[0]!.name,
        categories,
        totalBudgetedMinorUnits,
        totalSpentMinorUnits,
        totalBalanceMinorUnits,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async overspending(
    untrusted: OverspendingQuery,
  ): Promise<OverspendingResult> {
    const query = parseOverspendingQuery(untrusted);
    const progress = await this.budgetProgress({
      month: query.month,
      categoryName: null,
    });
    const categories = progress.categories
      .filter((category) => category.overspentMinorUnits > 0)
      .map((category) => ({
        name: category.name,
        overspentMinorUnits: category.overspentMinorUnits,
      }))
      .sort(
        (left, right) =>
          (left.overspentMinorUnits === right.overspentMinorUnits
            ? 0
            : left.overspentMinorUnits > right.overspentMinorUnits
              ? -1
              : 1) || compareText(left.name, right.name),
      );
    return {
      month: query.month,
      categories,
      totalOverspentMinorUnits: categories.reduce(
        (total, category) => add(total, category.overspentMinorUnits),
        0,
      ),
      freshness: progress.freshness,
    };
  }

  async transactionExplanation(
    untrusted: TransactionExplanationQuery,
  ): Promise<TransactionExplanationResult> {
    const query = parseTransactionExplanationQuery(untrusted);
    assertRange(
      query.startDate,
      query.endDate,
      this.#config.readContract.maximumExplanationRangeDays,
    );
    if (query.limit > this.#config.readContract.maximumExplanationRows) {
      throw new ActualReadDataError();
    }
    return this.#read(async (api, context) => {
      const payees = matchingPayees(query.merchantName, context);
      const payeeIds = new Set(payees.map((payee) => payee.id));
      const grouped = groupLines(
        await this.#lines(api, context, query.startDate, query.endDate),
      )
        .filter((lines) =>
          lines.some(
            (line) => line.payee !== undefined && payeeIds.has(line.payee.id),
          ),
        )
        .sort(
          (left, right) =>
            compareText(right[0]!.date, left[0]!.date) ||
            compareText(
              left[0]!.sourceTransactionKey,
              right[0]!.sourceTransactionKey,
            ),
        );
      const transactions: TransactionExplanation[] = grouped
        .slice(0, query.limit)
        .map((lines) => {
          const first = lines[0]!;
          const categoryNames = [
            ...new Set(
              lines
                .map((line) => line.category?.name)
                .filter((name): name is string => name !== undefined),
            ),
          ].sort(compareText);
          return {
            date: first.date,
            merchantName: payees[0]!.name,
            accountName: first.account.name,
            amountMinorUnits: lines.reduce(
              (total, line) => add(total, line.amount),
              0,
            ),
            categoryNames,
            split: first.split,
            cleared: first.cleared,
            categorizationEvidence:
              categoryNames.length === 0
                ? ('uncategorized' as const)
                : ('actual-ledger' as const),
          };
        });
      return {
        startDate: query.startDate,
        endDate: query.endDate,
        merchantName: payees[0]!.name,
        transactions,
        truncated: grouped.length > transactions.length,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async transactionSearch(
    untrusted: TransactionSearchQuery,
  ): Promise<TransactionSearchResult> {
    const query = parseTransactionSearchQuery(untrusted);
    assertRange(
      query.startDate,
      query.endDate,
      this.#config.readContract.maximumExplanationRangeDays,
    );
    if (query.limit > this.#config.readContract.maximumExplanationRows) {
      throw new ActualReadDataError();
    }
    return this.#read(async (api, context) => {
      const accounts =
        query.accountName === null
          ? context.accounts
          : context.accounts.filter(
              (candidate) => key(candidate.name) === key(query.accountName!),
            );
      if (accounts.length === 0) {
        throw new ActualReadNotFoundError('account');
      }
      if (query.accountName !== null && accounts.length !== 1) {
        throw new ActualReadDataError();
      }
      const accountIds = new Set(accounts.map((account) => account.id));
      const payees =
        query.merchantName === null
          ? undefined
          : matchingPayees(query.merchantName, context);
      const payeeIds =
        payees === undefined
          ? undefined
          : new Set(payees.map((payee) => payee.id));
      const category =
        query.categoryName === null
          ? undefined
          : uniqueCategory(query.categoryName, context);
      const matching: Array<{
        readonly key: string;
        readonly row: TransactionSearchRow;
      }> = [];
      for (const lines of groupLines(
        await this.#lines(api, context, query.startDate, query.endDate, {
          includeOffBudget: true,
          includeTransfers: true,
        }),
      )) {
        const first = lines[0]!;
        if (!accountIds.has(first.account.id)) continue;
        if (query.kind !== 'any' && first.kind !== query.kind) continue;
        if (
          payeeIds !== undefined &&
          !lines.some(
            (line) => line.payee !== undefined && payeeIds.has(line.payee.id),
          )
        ) {
          continue;
        }
        if (
          category !== undefined &&
          !lines.some((line) => line.category?.id === category.id)
        ) {
          continue;
        }
        const uncategorized = lines.some((line) => line.category === undefined);
        if (
          (query.categorization === 'uncategorized' && !uncategorized) ||
          (query.categorization === 'categorized' && uncategorized)
        ) {
          continue;
        }
        const amountMinorUnits = lines.reduce(
          (total, line) => add(total, line.amount),
          0,
        );
        if (
          query.absoluteAmountMinorUnits !== null &&
          amountMinorUnits !== query.absoluteAmountMinorUnits &&
          amountMinorUnits !== -query.absoluteAmountMinorUnits
        ) {
          continue;
        }
        if (
          (query.direction === 'expense' && amountMinorUnits >= 0) ||
          (query.direction === 'income' && amountMinorUnits <= 0)
        ) {
          continue;
        }
        const categoryNames = [
          ...new Set(
            lines
              .map((line) => line.category?.name)
              .filter((name): name is string => name !== undefined),
          ),
        ].sort(compareText);
        const merchantNames = [
          ...new Set(
            lines
              .map((line) => line.payee?.name)
              .filter((name): name is string => name !== undefined),
          ),
        ].sort(compareText);
        const memos = [
          ...new Set(
            lines
              .map((line) => line.memo)
              .filter((memo): memo is string => memo !== null),
          ),
        ];
        matching.push({
          key: first.sourceTransactionKey,
          row: {
            date: first.date,
            merchantName:
              merchantNames.length === 0
                ? null
                : merchantNames.join(' / ').slice(0, 240),
            accountName: first.account.name,
            amountMinorUnits,
            categoryNames,
            split: first.split,
            cleared: first.cleared,
            categorizationEvidence: uncategorized
              ? 'uncategorized'
              : 'actual-ledger',
            kind: first.kind,
            memo: memos.length === 0 ? null : memos.join(' | ').slice(0, 240),
          },
        });
      }
      matching.sort((left, right) => {
        const primary =
          query.sort === 'amount-desc'
            ? Math.abs(right.row.amountMinorUnits) -
              Math.abs(left.row.amountMinorUnits)
            : compareText(right.row.date, left.row.date);
        return (
          primary ||
          compareText(right.row.date, left.row.date) ||
          compareText(left.key, right.key)
        );
      });
      let expenseMinorUnits = 0;
      let incomeMinorUnits = 0;
      for (const entry of matching) {
        if (entry.row.amountMinorUnits < 0) {
          expenseMinorUnits = add(
            expenseMinorUnits,
            magnitude(entry.row.amountMinorUnits),
          );
        } else {
          incomeMinorUnits = add(incomeMinorUnits, entry.row.amountMinorUnits);
        }
      }
      const transactions = matching
        .slice(0, query.limit)
        .map((entry) => entry.row);
      return {
        ...query,
        accountName: query.accountName === null ? null : accounts[0]!.name,
        merchantName:
          query.merchantName === null ? null : (payees?.[0]?.name ?? null),
        categoryName:
          query.categoryName === null ? null : (category?.name ?? null),
        transactions,
        matchedTransactionCount: matching.length,
        expenseMinorUnits,
        incomeMinorUnits,
        netCashFlowMinorUnits: subtract(incomeMinorUnits, expenseMinorUnits),
        truncated: matching.length > transactions.length,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async needsCategorization(
    untrusted: NeedsCategorizationQuery,
  ): Promise<NeedsCategorizationResult> {
    const query = parseNeedsCategorizationQuery(untrusted);
    assertRange(
      query.startDate,
      query.endDate,
      this.#config.readContract.maximumExplanationRangeDays,
    );
    if (query.limit > this.#config.readContract.maximumExplanationRows) {
      throw new ActualReadDataError();
    }
    return this.#read(async (api, context) => {
      const matching: Array<{
        readonly key: string;
        readonly row: NeedsCategorizationRow;
      }> = [];
      for (const transaction of await this.#importedTransactions(
        api,
        context,
        query.startDate,
        query.endDate,
      )) {
        if (
          !transaction.account.onBudget ||
          transaction.split ||
          transaction.categoryStatus !== 'uncategorized' ||
          transaction.alreadyLinkedReceipts.length > 0 ||
          (transaction.specialKind !== 'ordinary' &&
            transaction.specialKind !== 'cashback')
        ) {
          continue;
        }
        matching.push({
          key: `${transaction.account.alias}\u0000${transaction.transactionId}\u0000${transaction.importedId}`,
          row: {
            date: transaction.date,
            merchantName: transaction.payee?.name ?? null,
            accountName: transaction.account.name,
            amountMinorUnits: transaction.amount,
            cleared: transaction.cleared,
            kind: transaction.specialKind,
            memo: transaction.memo,
          },
        });
      }
      matching.sort((left, right) => {
        const primary =
          query.sort === 'amount-desc'
            ? Math.abs(right.row.amountMinorUnits) -
              Math.abs(left.row.amountMinorUnits)
            : compareText(right.row.date, left.row.date);
        return (
          primary ||
          compareText(right.row.date, left.row.date) ||
          compareText(left.key, right.key)
        );
      });
      const transactions = matching
        .slice(0, query.limit)
        .map((entry) => entry.row);
      return {
        ...query,
        transactions,
        matchedTransactionCount: matching.length,
        truncated: matching.length > transactions.length,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async categoryExplanation(
    untrusted: CategoryExplanationQuery,
  ): Promise<CategoryExplanationResult> {
    const query = parseCategoryExplanationQuery(untrusted);
    assertRange(
      query.startDate,
      query.endDate,
      this.#config.readContract.maximumExplanationRangeDays,
    );
    if (query.limit > this.#config.readContract.maximumExplanationRows) {
      throw new ActualReadDataError();
    }
    return this.#read(async (api, context) => {
      const category = uniqueCategory(query.categoryName, context);
      const lines = (
        await this.#lines(api, context, query.startDate, query.endDate)
      ).filter((line) => line.category?.id === category.id);
      let expense = 0;
      let refund = 0;
      const transactions = new Set<string>();
      const contributionMap = new Map<
        string,
        {
          expense: number;
          refund: number;
          transactions: Set<string>;
        }
      >();
      for (const line of lines) {
        transactions.add(line.sourceTransactionKey);
        if (line.amount < 0) expense = add(expense, magnitude(line.amount));
        else refund = add(refund, line.amount);
        const merchantName = line.payee?.name ?? 'Unknown merchant';
        const contribution = contributionMap.get(merchantName) ?? {
          expense: 0,
          refund: 0,
          transactions: new Set<string>(),
        };
        if (line.amount < 0) {
          contribution.expense = add(
            contribution.expense,
            magnitude(line.amount),
          );
        } else {
          contribution.refund = add(contribution.refund, line.amount);
        }
        contribution.transactions.add(line.sourceTransactionKey);
        contributionMap.set(merchantName, contribution);
      }
      const contributions: CategoryExplanationContribution[] = [
        ...contributionMap.entries(),
      ]
        .map(([merchantName, contribution]) => ({
          merchantName,
          netSpentMinorUnits: subtract(
            contribution.expense,
            contribution.refund,
          ),
          transactionCount: contribution.transactions.size,
        }))
        .sort(
          (left, right) =>
            (left.netSpentMinorUnits === right.netSpentMinorUnits
              ? 0
              : left.netSpentMinorUnits > right.netSpentMinorUnits
                ? -1
                : 1) || compareText(left.merchantName, right.merchantName),
        );
      const topContributions = contributions.slice(0, query.limit);
      return {
        startDate: query.startDate,
        endDate: query.endDate,
        categoryName: category.name,
        netSpentMinorUnits: subtract(expense, refund),
        transactionCount: transactions.size,
        topContributions,
        categorizationEvidence:
          transactions.size === 0
            ? []
            : [
                {
                  evidence: 'actual-ledger',
                  transactionCount: transactions.size,
                },
              ],
        truncated: contributions.length > topContributions.length,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async searchReceipts(
    untrusted: ReceiptSearchQuery,
  ): Promise<ReceiptSearchResult> {
    const query = parseReceiptSearchQuery(untrusted);
    assertRange(
      query.startDate,
      query.endDate,
      this.#config.readContract.maximumAggregateRangeDays,
    );
    const textTokens = receiptSearchTokens(query.textQuery);
    const merchantNeedle =
      query.merchantQuery === null
        ? null
        : receiptSearchKey(query.merchantQuery);
    return this.#read(async (api) => {
      const matching: Array<{
        readonly noteId: string;
        readonly date: string;
        readonly row: ReceiptSearchRow;
      }> = [];
      for (const receipt of await this.#allReceiptRecords(api)) {
        const record = receipt.record;
        if (record.status !== 'active') continue;
        const date = record.purchaseDate ?? record.createdAt.slice(0, 10);
        if (date < query.startDate || date > query.endDate) continue;
        const merchantKey =
          record.merchant === null ? '' : receiptSearchKey(record.merchant);
        if (merchantNeedle !== null && !merchantKey.includes(merchantNeedle)) {
          continue;
        }
        const searchable = receiptSearchKey(
          [
            record.merchant,
            record.receiptReference,
            ...(record.householdNotes?.map((note) => note.text) ?? []),
            ...record.items.map((item) => item.description),
          ]
            .filter((value): value is string => value !== null)
            .join(' '),
        );
        if (!textTokens.every((token) => searchable.includes(token))) {
          continue;
        }
        matching.push({
          noteId: receipt.noteId,
          date,
          row: {
            merchant: record.merchant,
            purchaseDate: record.purchaseDate,
            purchaseTime: record.purchaseTime,
            timezoneOffset: record.timezoneOffset,
            currency: record.currency,
            amounts: {
              subtotalMinorUnits: record.amounts.subtotalMinor,
              taxMinorUnits: record.amounts.taxMinor,
              discountMinorUnits: record.amounts.discountMinor,
              tipMinorUnits: record.amounts.tipMinor,
              totalMinorUnits: record.amounts.totalMinor,
            },
            paymentEvidence:
              record.paymentEvidence.kind === 'masked-card'
                ? {
                    kind: 'masked-card',
                    lastFour: record.paymentEvidence.lastFour!,
                  }
                : {
                    kind: record.paymentEvidence.kind,
                    lastFour: null,
                  },
            receiptReference: record.receiptReference,
            householdNotes: (record.householdNotes ?? [])
              .slice(-MAX_RECEIPT_SEARCH_HOUSEHOLD_NOTES)
              .map((note) => note.text),
            items: record.items.map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unitPriceMinorUnits: item.unitPriceMinor,
              totalMinorUnits: item.totalMinor,
            })),
            automaticProcessingBlocked:
              record.extraction.automaticProcessingBlocked === true,
            itemDetailsComplete: receiptRecordItemDetailsComplete(record),
            sourceCount: record.sources.length,
            extractedAt: record.extraction.extractedAt,
          },
        });
      }
      matching.sort(
        (left, right) =>
          compareText(right.date, left.date) ||
          compareText(right.row.extractedAt, left.row.extractedAt) ||
          compareText(left.noteId, right.noteId),
      );
      const receipts: ReceiptSearchRow[] = [];
      let itemCount = 0;
      for (const match of matching) {
        if (
          receipts.length >= query.limit ||
          (receipts.length > 0 &&
            itemCount + match.row.items.length > MAX_RECEIPT_SEARCH_ITEMS)
        ) {
          break;
        }
        receipts.push(match.row);
        itemCount += match.row.items.length;
      }
      return {
        ...query,
        receipts,
        matchedReceiptCount: matching.length,
        truncated: receipts.length < matching.length,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async receiptRecords(
    untrusted: ReceiptRecordListQuery,
  ): Promise<ReceiptRecordListResult> {
    const query = parseReceiptRecordListQuery(untrusted);
    return this.#read(async (api) => {
      const matching = (await this.#allReceiptRecords(api)).filter(
        (receipt) =>
          query.afterNoteId === null || receipt.noteId > query.afterNoteId,
      );
      const records: ActualReceiptNoteRecord[] = [];
      let payloadBytes = 0;
      for (const receipt of matching) {
        const nextBytes =
          Buffer.byteLength(receipt.canonicalJson, 'utf8') +
          Buffer.byteLength(receipt.noteId, 'utf8') +
          256;
        if (
          records.length >= query.limit ||
          (records.length > 0 &&
            payloadBytes + nextBytes > MAX_RECEIPT_RECORD_PAGE_BYTES)
        ) {
          break;
        }
        records.push(receipt);
        payloadBytes += nextBytes;
      }
      const truncated = records.length < matching.length;
      return {
        records,
        nextAfterNoteId:
          truncated && records.length > 0 ? records.at(-1)!.noteId : null,
        truncated,
      };
    });
  }

  async scanImportedTransactions(
    untrusted: ActualImportedTransactionScanQuery,
  ): Promise<ActualImportedTransactionScanResult> {
    const query = parseImportedTransactionScanQuery(untrusted);
    assertRange(
      query.startDate,
      query.endDate,
      this.#config.readContract.maximumObservationRangeDays,
    );
    return this.#read(async (api, context) => {
      const transactions = await this.#importedTransactions(
        api,
        context,
        query.startDate,
        query.endDate,
      );
      if (
        transactions.length > this.#config.readContract.maximumObservationRows
      ) {
        throw new ActualReadDataError();
      }
      const observations = transactions.map((transaction) =>
        this.#observation(transaction),
      );
      const watermark = digest({
        schemaVersion: ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION,
        contractFingerprint: this.#config.readContract.fingerprint,
        startDate: query.startDate,
        endDate: query.endDate,
        observations,
      });
      const stored = this.#requiredFreshness();
      const importFreshnessToken = digest({
        schemaVersion: 'actual-import-freshness.v1',
        contractFingerprint: this.#config.readContract.fingerprint,
        watermark,
        generation: stored.generation,
        state: stored.state,
        lastAttemptAt: stored.lastAttemptAt,
        lastSuccessfulSyncAt: stored.lastSuccessfulSyncAt,
      });
      const unchanged = query.previousWatermark === watermark;
      return {
        schemaVersion: ACTUAL_IMPORTED_TRANSACTION_SCAN_SCHEMA_VERSION,
        startDate: query.startDate,
        endDate: query.endDate,
        observations: unchanged ? [] : observations,
        watermark,
        importFreshnessToken,
        unchanged,
        freshness: this.#publicFreshness(),
      };
    });
  }

  async candidatesForReceipt(
    untrusted: ReceiptMatchIntent,
  ): Promise<readonly ImportedTransactionCandidate[]> {
    const intent = parseReceiptMatchIntent(untrusted);
    if (intent.paymentEvidence.kind === 'cash') {
      return [];
    }
    const startDate = addCalendarDays(
      intent.purchaseDate,
      -defaultReceiptMatchPolicy.earliestPostingDaysBeforePurchase,
    );
    const endDate = addCalendarDays(
      intent.purchaseDate,
      defaultReceiptMatchPolicy.latestPostingDaysAfterPurchase,
    );
    return this.#read(async (api, context) => {
      const candidates = (
        await this.#importedTransactions(api, context, startDate, endDate)
      )
        .filter((transaction) => {
          const alreadyLinked = transaction.alreadyLinkedReceipts.some(
            (link) => link.receiptId === intent.receiptId,
          );
          return (
            transaction.amount < 0 &&
            (alreadyLinked ||
              (transaction.account.onBudget &&
                (transaction.account.role === 'spending' ||
                  transaction.account.role === 'credit-card') &&
                (intent.currency === ACTUAL_READ_CURRENCY
                  ? transaction.amount >= -intent.totalMinorUnits
                  : plausibleForeignLedgerAmount(
                      intent.totalMinorUnits,
                      -transaction.amount,
                    )) &&
                transaction.specialKind === 'ordinary' &&
                (intent.paymentEvidence.kind !== 'masked-card' ||
                  transaction.account.lastFour === undefined ||
                  transaction.account.lastFour ===
                    intent.paymentEvidence.lastFour)))
          );
        })
        .map((transaction): ImportedTransactionCandidate => ({
          transactionId: transaction.transactionId,
          importedId: transaction.importedId,
          accountAlias: transaction.account.alias,
          accountLastFour: transaction.account.lastFour ?? null,
          postingDate: transaction.date,
          payeeName: transaction.payee?.name ?? null,
          statementDescription: transaction.memo,
          currency: ACTUAL_READ_CURRENCY,
          amountMinorUnits: transaction.amount,
          alreadyLinkedReceipts: [...transaction.alreadyLinkedReceipts],
        }));
      if (candidates.length > 200) {
        throw new ActualReadDataError();
      }
      return candidates;
    });
  }

  async prepareCategorizationUpdate(
    untrusted: ActualPrepareCategorizationUpdateRequest,
  ): Promise<ActualPrepareCategorizationUpdateResult> {
    const request = parsePrepareCategorizationUpdateRequest(untrusted);
    return this.#read(async (api, context) => {
      const account = context.accounts.find(
        (candidate) => candidate.alias === request.accountAlias,
      );
      if (account === undefined) {
        throw new ActualPrepareCategorizationUpdateRefusedError(
          'target-not-found',
        );
      }
      const normalized = (
        await this.#importedTransactions(
          api,
          context,
          request.date,
          request.date,
          [account],
        )
      ).filter(
        (candidate) =>
          candidate.account.alias === request.accountAlias &&
          candidate.transactionId === request.transactionId &&
          candidate.importedId === request.importedId,
      );
      if (normalized.length === 0) {
        throw new ActualPrepareCategorizationUpdateRefusedError(
          'target-not-found',
        );
      }
      if (normalized.length !== 1) {
        throw new ActualReadDataError();
      }
      const target = normalized[0]!;
      const scanObservation = this.#observation(target);
      if (
        target.amount !== request.amountMinorUnits ||
        scanObservation.observationFingerprint !==
          request.expectedObservationFingerprint
      ) {
        throw new ActualPrepareCategorizationUpdateRefusedError(
          'target-changed',
        );
      }
      if (
        !account.onBudget ||
        (account.role !== 'spending' &&
          account.role !== 'credit-card' &&
          account.role !== 'cashback-staging') ||
        target.split ||
        target.specialKind === 'transfer' ||
        target.specialKind === 'card-payment' ||
        target.specialKind === 'debt-payment'
      ) {
        throw new ActualPrepareCategorizationUpdateRefusedError(
          'target-unsupported',
        );
      }

      let observed: ActualTransactionObservationV1;
      try {
        observed = captureActualTransactionObservation(
          target.raw as ActualUpdateTransactionRecord,
        );
      } catch {
        throw new ActualReadDataError();
      }
      if (
        observed.transactionId !== request.transactionId ||
        observed.accountId !== account.id ||
        observed.date !== request.date ||
        observed.amountMinorUnits !== request.amountMinorUnits ||
        observed.importedId !== request.importedId ||
        observed.cleared !== target.cleared ||
        observed.isParent ||
        observed.isChild ||
        observed.parentId !== null ||
        observed.tombstone ||
        observed.transferId !== null
      ) {
        throw new ActualPrepareCategorizationUpdateRefusedError(
          'target-changed',
        );
      }

      const categories = request.categoryAliases
        .map((alias) => {
          const matches = context.categories.filter(
            (category) => category.alias === alias,
          );
          if (matches.length !== 1) {
            throw new ActualPrepareCategorizationUpdateRefusedError(
              'category-not-allowed',
            );
          }
          return { alias, categoryId: matches[0]!.id };
        })
        .sort((left, right) => compareText(left.alias, right.alias));
      return {
        schemaVersion: ACTUAL_CATEGORIZATION_UPDATE_PREPARATION_SCHEMA_VERSION,
        observed,
        categories,
        freshness: this.#publicFreshness(),
      };
    });
  }

  #aggregateRange(start: string, end: string): void {
    assertRange(
      start,
      end,
      this.#config.readContract.maximumAggregateRangeDays,
    );
  }
  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.valueOf())) throw new ActualReadDataError();
    return now;
  }
  #requiredFreshness(): PersistedActualReadFreshness {
    if (this.#freshness === undefined) throw new ActualApiReadLifecycleError();
    return this.#freshness;
  }
  #publicFreshness(override?: 'skipped-recent'): ActualReadFreshness {
    if (this.#budgetAsOf === undefined) {
      throw new ActualApiReadLifecycleError();
    }
    const stored = this.#requiredFreshness();
    return {
      ...publicActualReadFreshness(
        stored,
        this.#validNow(),
        this.#config.readContract.freshnessMaximumAgeSeconds,
        override,
      ),
      actualBudgetAsOf: this.#budgetAsOf,
      bankFeedAsOf: stored.lastSuccessfulSyncAt,
      expectedBankDelayHours: this.#config.readContract.expectedBankDelayHours,
    };
  }
  #readyApi(): ActualReadApiFacade {
    if (this.#state !== 'ready' || this.#api === undefined) {
      throw new ActualApiReadLifecycleError();
    }
    return this.#api;
  }
  #boundAccounts(): readonly BoundAccount[] {
    return Object.entries(this.#config.readContract.accounts)
      .map(([alias, account]) => ({ alias, ...account }))
      .sort((left, right) => compareText(left.alias, right.alias));
  }
  async #read<T>(
    operation: (api: ActualReadApiFacade, context: LedgerContext) => Promise<T>,
  ): Promise<T> {
    return this.#exclusive(async () => {
      const api = this.#readyApi();
      await api.sync();
      this.#budgetAsOf = this.#validNow().toISOString();
      const context = await this.#context(api);
      return operation(api, context);
    });
  }
  async #context(api: ActualReadApiFacade): Promise<LedgerContext> {
    const bound = this.#boundAccounts();
    const accounts = await api.getAccounts();
    const active = accounts.filter((account) => account.closed === false);
    if (
      active.length !== bound.length ||
      bound.some(
        (expected) =>
          active.filter(
            (actual) =>
              actual.id === expected.id &&
              actual.name === expected.name &&
              actual.offbudget === !expected.onBudget,
          ).length !== 1,
      )
    ) {
      throw new ActualApiReadConfigurationError();
    }
    const accountById = new Map(bound.map((account) => [account.id, account]));

    const groups = await api.getCategoryGroups();
    const rawCategories = groups
      .flatMap((group) =>
        (group.categories ?? []).map((category) => ({
          id: safeText(category.id),
          name: safeText(category.name, 120),
          isIncome: group.is_income === true || category.is_income === true,
          visible: group.hidden !== true && category.hidden !== true,
        })),
      )
      .sort((left, right) => compareText(left.name, right.name));
    const visibleCategories = rawCategories.filter(
      (category) => category.visible,
    );
    if (
      rawCategories.length > 1_000 ||
      visibleCategories.length > 200 ||
      new Set(rawCategories.map((category) => category.id)).size !==
        rawCategories.length ||
      new Set(visibleCategories.map((category) => key(category.name))).size !==
        visibleCategories.length
    ) {
      throw new ActualReadDataError();
    }
    const aliasByCategoryName = new Map<string, string>();
    for (const [alias, expected] of Object.entries(
      this.#config.readContract.categories,
    )) {
      const matches = visibleCategories.filter(
        (category) => category.name === expected.name,
      );
      if (matches.length !== 1) {
        throw new ActualApiReadConfigurationError();
      }
      aliasByCategoryName.set(expected.name, alias);
    }
    const categories: Category[] = rawCategories.map((category) => ({
      ...category,
      alias: aliasByCategoryName.get(category.name),
    }));
    const categoryById = new Map(
      categories.map((category) => [category.id, category]),
    );

    const payees = (await api.getPayees())
      .map((payee) => {
        const transferAccountId =
          typeof payee.transfer_acct === 'string' &&
          payee.transfer_acct.length > 0
            ? safeText(payee.transfer_acct)
            : undefined;
        return {
          id: safeText(payee.id),
          name: safeText(payee.name, 240),
          isTransfer: transferAccountId !== undefined,
          transferAccountId,
        };
      })
      .sort((left, right) => compareText(left.name, right.name));
    if (
      payees.length > 2_000 ||
      new Set(payees.map((payee) => payee.id)).size !== payees.length ||
      new Set(
        payees
          .filter((payee) => !payee.isTransfer)
          .map((payee) => key(payee.name)),
      ).size > 300
    ) {
      throw new ActualReadDataError();
    }
    return {
      accounts: bound,
      accountById,
      categories,
      categoryById,
      payees,
      payeeById: new Map(payees.map((payee) => [payee.id, payee])),
    };
  }
  async #allReceiptRecords(
    api: ActualReadApiFacade,
  ): Promise<readonly ActualReceiptNoteRecord[]> {
    const raw = await api.aqlQuery(api.q('notes').select(['id', 'note']));
    if (
      raw === null ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      !Array.isArray((raw as { readonly data?: unknown }).data)
    ) {
      throw new ActualReadDataError();
    }
    const rows = (raw as { readonly data: readonly unknown[] }).data;
    if (rows.length > MAX_ACTUAL_NOTE_ROWS) {
      throw new ActualReadDataError();
    }
    const records: ActualReceiptNoteRecord[] = [];
    const noteIds = new Set<string>();
    for (const untrustedRow of rows) {
      if (
        untrustedRow === null ||
        typeof untrustedRow !== 'object' ||
        Array.isArray(untrustedRow)
      ) {
        throw new ActualReadDataError();
      }
      const row = untrustedRow as {
        readonly id?: unknown;
        readonly note?: unknown;
      };
      if (typeof row.id !== 'string') {
        throw new ActualReadDataError();
      }
      if (!row.id.startsWith(ACTUAL_RECEIPT_NOTE_PREFIX)) continue;
      if (noteIds.has(row.id) || typeof row.note !== 'string') {
        throw new ActualReadDataError();
      }
      noteIds.add(row.id);
      try {
        records.push(parseHouseholdFinanceReceiptNote(row.id, row.note));
      } catch {
        throw new ActualReadDataError();
      }
    }
    if (records.length > MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS) {
      throw new ActualReadDataError();
    }
    return records.sort((left, right) =>
      compareText(left.noteId, right.noteId),
    );
  }
  #observation(
    transaction: NormalizedImportedTransaction,
  ): ActualImportedTransactionObservation {
    const boundCategory =
      transaction.categoryStatus === 'contract-bound'
        ? transaction.category
        : undefined;
    if (
      transaction.categoryStatus === 'contract-bound' &&
      (boundCategory === undefined || boundCategory.alias === undefined)
    ) {
      throw new ActualReadDataError();
    }
    const observation: Omit<
      ActualImportedTransactionObservation,
      'observationFingerprint'
    > = {
      schemaVersion: ACTUAL_IMPORTED_TRANSACTION_OBSERVATION_SCHEMA_VERSION,
      transactionId: transaction.transactionId,
      importedId: transaction.importedId,
      accountAlias: transaction.account.alias,
      accountRole: transaction.account.role,
      accountOnBudget: transaction.account.onBudget,
      accountLastFour: transaction.account.lastFour ?? null,
      date: transaction.date,
      amountMinorUnits: transaction.amount,
      direction:
        transaction.specialKind === 'refund'
          ? 'refund'
          : transaction.amount < 0
            ? 'expense'
            : 'income',
      payeeName: transaction.payee?.name ?? null,
      memo: transaction.memo,
      currentCategoryAlias: boundCategory?.alias ?? null,
      currentCategoryName: boundCategory?.name ?? null,
      currentCategoryStatus: transaction.categoryStatus,
      split: transaction.split,
      cleared: transaction.cleared,
      specialKind: transaction.specialKind,
      alreadyLinkedReceipts: transaction.alreadyLinkedReceipts,
    };
    return {
      ...observation,
      observationFingerprint: digest({
        schemaVersion: 'actual-imported-transaction-fingerprint.v1',
        contractFingerprint: this.#config.readContract.fingerprint,
        observation,
      }),
    };
  }
  #specialKind(
    account: BoundAccount,
    amount: number,
    isTransfer: boolean,
    transferTargets: readonly BoundAccount[],
    containsNonIncomeCategory: boolean,
  ): ActualImportedTransactionSpecialKind {
    if (isTransfer) {
      if (
        (account.role === 'debt' && amount > 0) ||
        (amount < 0 &&
          transferTargets.some((candidate) => candidate.role === 'debt'))
      ) {
        return 'debt-payment';
      }
      if (
        (account.role === 'credit-card' && amount > 0) ||
        (amount < 0 &&
          transferTargets.some((candidate) => candidate.role === 'credit-card'))
      ) {
        return 'card-payment';
      }
      return 'transfer';
    }
    if (account.role === 'cashback-staging' && amount > 0) {
      return 'cashback';
    }
    if (amount > 0 && containsNonIncomeCategory) {
      return 'refund';
    }
    return 'ordinary';
  }
  async #importedTransactions(
    api: ActualReadApiFacade,
    context: LedgerContext,
    start: string,
    end: string,
    accounts: readonly BoundAccount[] = context.accounts,
  ): Promise<readonly NormalizedImportedTransaction[]> {
    const result: NormalizedImportedTransaction[] = [];
    const transactionKeys = new Set<string>();
    const importKeys = new Set<string>();
    for (const account of accounts) {
      const transactions = await api.getTransactions(account.id, start, end);
      for (const transaction of transactions) {
        if (
          transaction.account !== account.id ||
          transaction.date < start ||
          transaction.date > end
        ) {
          throw new ActualReadDataError();
        }
        if (
          transaction.tombstone === true ||
          transaction.is_child === true ||
          transaction.starting_balance_flag === true ||
          transaction.imported_id === undefined ||
          transaction.imported_id === null ||
          transaction.imported_id.length === 0
        ) {
          continue;
        }
        const transactionId = safeText(transaction.id, 200);
        const importedId = safeText(transaction.imported_id, 500);
        const transactionKey = `${account.alias}\u0000${transactionId}`;
        const importKey = `${account.alias}\u0000${importedId}`;
        if (transactionKeys.has(transactionKey) || importKeys.has(importKey)) {
          throw new ActualReadDataError();
        }
        transactionKeys.add(transactionKey);
        importKeys.add(importKey);
        dateEpoch(transaction.date);
        const amount = safeMoney(transaction.amount);
        if (amount === 0) {
          continue;
        }
        if (
          transaction.transfer_id !== undefined &&
          transaction.transfer_id !== null
        ) {
          safeText(transaction.transfer_id, 200);
        }
        const split =
          transaction.is_parent === true ||
          (transaction.subtransactions !== undefined &&
            transaction.subtransactions.length > 0);
        const lines = split ? transaction.subtransactions! : [transaction];
        const payees = new Map<string, Payee>();
        const categories = new Map<string, Category>();
        const receiptLinks: Array<{
          receiptId: string;
          sourceSha256: string;
        }> = [];
        const seenReceiptLinks = new Set<string>();
        let primaryPayee: Payee | undefined;
        if (transaction.payee !== undefined && transaction.payee !== null) {
          primaryPayee = context.payeeById.get(transaction.payee);
          if (primaryPayee === undefined) {
            throw new ActualReadDataError();
          }
          payees.set(primaryPayee.id, primaryPayee);
        }
        let parentNotesWithoutToken: string | null = null;
        const notesSources: Array<{
          readonly value: string | null | undefined;
          readonly parent: boolean;
        }> = [
          { value: transaction.notes, parent: true },
          ...(split
            ? lines.map((line) => ({ value: line.notes, parent: false }))
            : []),
        ];
        for (const source of notesSources) {
          if (source.value === undefined || source.value === null) {
            continue;
          }
          const extracted = extractActualReceiptLink(source.value);
          if (extracted.hasMalformedTokens) {
            throw new ActualReadDataError();
          }
          for (const link of extracted.links) {
            const key = `${link.receiptId}\0${link.sourceSha256}`;
            if (!seenReceiptLinks.has(key)) {
              seenReceiptLinks.add(key);
              receiptLinks.push(link);
            }
          }
          if (source.parent) {
            parentNotesWithoutToken = extracted.notesWithoutTokens;
          }
        }
        if (receiptLinks.length > MAX_ACTUAL_RECEIPT_LINKS_PER_TRANSACTION) {
          throw new ActualReadDataError();
        }
        for (const line of lines) {
          if (line.tombstone === true) {
            continue;
          }
          safeMoney(line.amount);
          if (line.transfer_id !== undefined && line.transfer_id !== null) {
            safeText(line.transfer_id, 200);
          }
          const payeeId = line.payee ?? transaction.payee ?? undefined;
          if (payeeId !== undefined && payeeId !== null) {
            const payee = context.payeeById.get(payeeId);
            if (payee === undefined) {
              throw new ActualReadDataError();
            }
            payees.set(payee.id, payee);
          }
          const categoryId = line.category ?? transaction.category ?? undefined;
          if (categoryId !== undefined) {
            const category = context.categoryById.get(categoryId);
            if (category === undefined) {
              throw new ActualReadDataError();
            }
            categories.set(category.id, category);
          }
        }
        const category = split ? undefined : categories.values().next().value;
        const categoryStatus = split
          ? ('split' as const)
          : category === undefined
            ? ('uncategorized' as const)
            : category.alias === undefined
              ? ('unbound' as const)
              : ('contract-bound' as const);
        const transferPayees = [...payees.values()].filter(
          (payee) => payee.isTransfer,
        );
        const transferTargets = transferPayees
          .map((payee) =>
            payee.transferAccountId === undefined
              ? undefined
              : context.accountById.get(payee.transferAccountId),
          )
          .filter(
            (candidate): candidate is BoundAccount => candidate !== undefined,
          );
        const isTransfer =
          (transaction.transfer_id !== undefined &&
            transaction.transfer_id !== null) ||
          lines.some(
            (line) =>
              line.transfer_id !== undefined && line.transfer_id !== null,
          ) ||
          transferPayees.length > 0;
        result.push({
          raw: transaction,
          transactionId,
          importedId,
          account,
          date: transaction.date,
          amount,
          payee:
            primaryPayee ??
            (payees.size === 1 ? payees.values().next().value : undefined),
          memo: sanitizeMemo(parentNotesWithoutToken),
          category,
          categoryStatus,
          split,
          cleared: transaction.cleared === true,
          specialKind: this.#specialKind(
            account,
            amount,
            isTransfer,
            transferTargets,
            [...categories.values()].some((candidate) => !candidate.isIncome),
          ),
          alreadyLinkedReceipts: receiptLinks,
        });
      }
    }
    return result.sort(
      (left, right) =>
        compareText(left.date, right.date) ||
        compareText(left.account.alias, right.account.alias) ||
        compareText(left.transactionId, right.transactionId) ||
        compareText(left.importedId, right.importedId),
    );
  }
  async #lines(
    api: ActualReadApiFacade,
    context: LedgerContext,
    start: string,
    end: string,
    options: {
      readonly includeOffBudget?: boolean;
      readonly includeTransfers?: boolean;
    } = {},
  ): Promise<readonly NormalizedLine[]> {
    const result: NormalizedLine[] = [];
    for (const account of context.accounts.filter(
      (candidate) => options.includeOffBudget === true || candidate.onBudget,
    )) {
      const transactions = await api.getTransactions(account.id, start, end);
      for (const transaction of transactions) {
        if (
          transaction.account !== account.id ||
          transaction.date < start ||
          transaction.date > end
        ) {
          throw new ActualReadDataError();
        }
        if (
          transaction.tombstone === true ||
          transaction.is_child === true ||
          transaction.starting_balance_flag === true ||
          (options.includeTransfers !== true &&
            transaction.transfer_id !== undefined &&
            transaction.transfer_id !== null)
        ) {
          continue;
        }
        safeText(transaction.id);
        dateEpoch(transaction.date);
        const lines =
          transaction.subtransactions !== undefined &&
          transaction.subtransactions.length > 0
            ? transaction.subtransactions
            : [transaction];
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          const payeeId = line.payee ?? transaction.payee ?? undefined;
          const payee =
            payeeId === undefined || payeeId === null
              ? undefined
              : context.payeeById.get(payeeId);
          if (
            payeeId !== undefined &&
            payeeId !== null &&
            payee === undefined
          ) {
            throw new ActualReadDataError();
          }
          const categoryId = line.category ?? undefined;
          const category =
            categoryId === undefined
              ? undefined
              : context.categoryById.get(categoryId);
          if (categoryId !== undefined && category === undefined) {
            throw new ActualReadDataError();
          }
          if (
            line.tombstone === true ||
            (options.includeTransfers !== true &&
              ((line.transfer_id !== undefined && line.transfer_id !== null) ||
                payee?.isTransfer === true))
          ) {
            continue;
          }
          const amount = safeMoney(line.amount);
          if (amount === 0) continue;
          result.push({
            sourceTransactionKey: `${account.id}:${transaction.id}`,
            sourceLineKey: `${account.id}:${transaction.id}:${String(index)}`,
            date: transaction.date,
            account,
            amount,
            category,
            payee,
            kind:
              (transaction.transfer_id !== undefined &&
                transaction.transfer_id !== null) ||
              (line.transfer_id !== undefined && line.transfer_id !== null) ||
              payee?.isTransfer === true
                ? 'transfer'
                : 'ordinary',
            split: lines.length > 1,
            cleared: transaction.cleared === true,
            memo: sanitizeMemo(line.notes ?? transaction.notes),
          });
        }
      }
    }
    return result;
  }
  async #upcomingBillRows(
    api: ActualReadApiFacade,
    context: LedgerContext,
    fromDate: string,
    throughDate: string,
  ): Promise<readonly UpcomingBill[]> {
    const schedules = await api.getSchedules();
    const bills: UpcomingBill[] = [];
    for (const schedule of schedules) {
      const account =
        typeof schedule.account === 'string'
          ? context.accountById.get(schedule.account)
          : undefined;
      const payee =
        typeof schedule.payee === 'string'
          ? context.payeeById.get(schedule.payee)
          : undefined;
      if (
        schedule.completed === true ||
        account === undefined ||
        !account.onBudget ||
        payee?.isTransfer === true ||
        typeof schedule.next_date !== 'string' ||
        schedule.next_date < fromDate ||
        schedule.next_date > throughDate
      ) {
        continue;
      }
      dateEpoch(schedule.next_date);
      const amount = scheduleExpense(schedule);
      if (amount === undefined) continue;
      const name =
        typeof schedule.name === 'string' && schedule.name.trim().length > 0
          ? safeText(schedule.name, 240)
          : (payee?.name ?? 'Scheduled bill');
      bills.push({ name, dueDate: schedule.next_date, ...amount });
    }
    if (bills.length > 100) throw new ActualReadDataError();
    bills.sort(
      (left, right) =>
        compareText(left.dueDate, right.dueDate) ||
        compareText(left.name, right.name),
    );
    return bills;
  }
  async #budgetMonth(
    api: ActualReadApiFacade,
    month: string,
  ): Promise<ActualReadApiBudgetMonth> {
    const budget = await api.getBudgetMonth(month);
    if (budget.month !== month || !Array.isArray(budget.categoryGroups)) {
      throw new ActualReadDataError();
    }
    safeMoney(budget.toBudget);
    return budget;
  }
  #budgetCategoryRow(
    budget: ActualReadApiBudgetMonth,
    categoryId: string,
  ): Record<string, unknown> | undefined {
    const rows = budget.categoryGroups.flatMap((group) =>
      Array.isArray(group.categories) ? group.categories : [],
    );
    const matches = rows.filter((row) => row.id === categoryId);
    if (matches.length > 1) throw new ActualReadDataError();
    return matches[0];
  }
  async #validateBoundary(api: ActualReadApiFacade): Promise<void> {
    let budgets;
    try {
      budgets = collapseActualBudgetRepresentations(
        (await api.getBudgets()).map((budget) => ({
          source:
            budget.state === undefined
              ? ('local' as const)
              : budget.state === 'remote'
                ? ('remote' as const)
                : (() => {
                    throw new ActualApiReadConfigurationError();
                  })(),
          id: budget.id,
          cloudFileId: budget.cloudFileId,
          groupId: budget.groupId,
          name: budget.name,
        })),
      );
    } catch {
      throw new ActualApiReadConfigurationError();
    }
    const contract = this.#config.readContract;
    const matching = budgets.filter(
      (budget) => budget.groupId === contract.budget.syncId,
    );
    if (
      matching.length !== 1 ||
      matching[0]?.name !== contract.budget.name ||
      !matching[0].localRepresentationPresent ||
      !matching[0].remoteRepresentationPresent
    ) {
      throw new ActualApiReadConfigurationError();
    }
    await this.#context(api);
  }
  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    const clearWatchdog = this.#startOperationWatchdog?.();
    try {
      return await operation();
    } finally {
      clearWatchdog?.();
      release?.();
    }
  }
}
