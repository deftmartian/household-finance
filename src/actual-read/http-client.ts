import type {
  ImportedTransactionCandidate,
  ReceiptMatchIntent,
} from '../matching/receipt-transaction.js';
import {
  ActualPrepareCategorizationUpdateRefusedError,
  ActualReadNotFoundError,
  type AccountBalancesQuery,
  type AccountBalancesResult,
  type ActualReadCatalog,
  type ActualDeterministicTransactionPort,
  type ActualImportedTransactionScanQuery,
  type ActualImportedTransactionScanResult,
  type ActualPrepareCategorizationUpdateRequest,
  type ActualPrepareCategorizationUpdateResult,
  type ActualReadPort,
  type ActualReceiptRecordReadPort,
  type ActualReadSyncResult,
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
import {
  ACTUAL_READ_JSON_CONTENT_TYPE,
  ActualReadProtocolError,
  MAX_ACTUAL_READ_RESPONSE_BYTES,
  parseAccountBalancesResult,
  parseActualReadCatalog,
  parseActualReadSyncResult,
  parseAvailableFundsResult,
  parseBudgetCapacityResult,
  parseBudgetProgressResult,
  parseCashFlowResult,
  parseCategoryExplanationResult,
  parseCategorySpendResult,
  parseIncomeResult,
  parseImportedTransactionCandidates,
  parseImportedTransactionScanResult,
  parseMerchantSpendResult,
  parseNeedsCategorizationResult,
  parseOverspendingResult,
  parseReceiptRecordListResult,
  parseReceiptSearchResult,
  parsePrepareCategorizationUpdateResult,
  parseTransactionExplanationResult,
  parseTransactionSearchResult,
  parseUpcomingBillsResult,
} from './protocol.js';

export type ActualReadClientErrorCode =
  | 'invalid-endpoint'
  | 'request-failed'
  | 'response-invalid'
  | 'remote-rejected';

export class ActualReadClientError extends Error {
  constructor(readonly code: ActualReadClientErrorCode) {
    super(`Actual read client failed: ${code}`);
    this.name = 'ActualReadClientError';
  }
}

export interface ActualReadHttpClientOptions {
  readonly endpoint: string;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

function origin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ActualReadClientError('invalid-endpoint');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ActualReadClientError('invalid-endpoint');
  }
  return parsed.origin;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and must not replace the fixed safe error.
  }
}

function declaredResponseLength(response: Response): number {
  const rawLength = response.headers.get('content-length');
  if (rawLength === null || !/^(?:0|[1-9]\d*)$/.test(rawLength)) {
    throw new ActualReadClientError('response-invalid');
  }
  const length = Number(rawLength);
  if (
    !Number.isSafeInteger(length) ||
    length > MAX_ACTUAL_READ_RESPONSE_BYTES
  ) {
    throw new ActualReadClientError('response-invalid');
  }
  return length;
}

async function readBoundedResponseBody(response: Response): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;

      const chunk = Buffer.from(next.value);
      if (size + chunk.byteLength > MAX_ACTUAL_READ_RESPONSE_BYTES) {
        chunk.fill(0);
        throw new ActualReadClientError('response-invalid');
      }
      size += chunk.byteLength;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

async function parseJsonResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    if (
      response.status !== 400 &&
      response.status !== 404 &&
      response.status !== 409
    ) {
      throw new ActualReadClientError('remote-rejected');
    }
    if (
      response.headers.get('content-type') !== ACTUAL_READ_JSON_CONTENT_TYPE
    ) {
      throw new ActualReadClientError('remote-rejected');
    }
    const expectedLength = declaredResponseLength(response);
    const bytes = await readBoundedResponseBody(response);
    try {
      signal.throwIfAborted();
      if (bytes.byteLength !== expectedLength) {
        throw new ActualReadClientError('remote-rejected');
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new ActualReadClientError('remote-rejected');
      }
      const record =
        typeof decoded === 'object' &&
        decoded !== null &&
        !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>)
          : undefined;
      if (
        response.status === 400 &&
        record !== undefined &&
        Object.keys(record).length === 1 &&
        record.error === 'invalid_request'
      ) {
        throw new ActualReadProtocolError();
      }
      if (
        response.status === 404 &&
        record !== undefined &&
        Object.keys(record).length === 2 &&
        record.error === 'not_found' &&
        (record.kind === 'account' ||
          record.kind === 'category' ||
          record.kind === 'merchant')
      ) {
        throw new ActualReadNotFoundError(record.kind);
      }
      if (
        response.status === 409 &&
        record !== undefined &&
        Object.keys(record).length === 2 &&
        record.error === 'preparation_refused' &&
        (record.code === 'target-not-found' ||
          record.code === 'target-changed' ||
          record.code === 'target-unsupported' ||
          record.code === 'category-not-allowed')
      ) {
        throw new ActualPrepareCategorizationUpdateRefusedError(record.code);
      }
      throw new ActualReadClientError('remote-rejected');
    } finally {
      bytes.fill(0);
    }
  }
  if (response.headers.get('content-type') !== ACTUAL_READ_JSON_CONTENT_TYPE) {
    throw new ActualReadClientError('response-invalid');
  }

  const expectedLength = declaredResponseLength(response);
  const bytes = await readBoundedResponseBody(response);
  try {
    signal.throwIfAborted();
    if (bytes.byteLength !== expectedLength) {
      throw new ActualReadClientError('response-invalid');
    }
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new ActualReadClientError('response-invalid');
    }
  } finally {
    bytes.fill(0);
  }
}

export class ActualReadHttpClient implements ActualReadPort {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ActualReadHttpClientOptions) {
    this.#endpoint = origin(options.endpoint);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 100 ||
      this.#timeoutMs > 120_000
    ) {
      throw new ActualReadClientError('invalid-endpoint');
    }
  }

  async catalog(): Promise<ActualReadCatalog> {
    return parseActualReadCatalog(await this.#request('/v1/catalog'));
  }
  async accountBalances(
    query: AccountBalancesQuery,
  ): Promise<AccountBalancesResult> {
    return parseAccountBalancesResult(
      await this.#request('/v1/account-balances', query),
    );
  }
  async availableFunds(
    query: AvailableFundsQuery,
  ): Promise<AvailableFundsResult> {
    return parseAvailableFundsResult(
      await this.#request('/v1/available-funds', query),
    );
  }
  async categorySpend(query: CategorySpendQuery): Promise<CategorySpendResult> {
    return parseCategorySpendResult(
      await this.#request('/v1/category-spend', query),
    );
  }
  async merchantSpend(query: MerchantSpendQuery): Promise<MerchantSpendResult> {
    return parseMerchantSpendResult(
      await this.#request('/v1/merchant-spend', query),
    );
  }
  async income(query: IncomeQuery): Promise<IncomeResult> {
    return parseIncomeResult(await this.#request('/v1/income', query));
  }
  async cashFlow(query: CashFlowQuery): Promise<CashFlowResult> {
    return parseCashFlowResult(await this.#request('/v1/cash-flow', query));
  }
  async upcomingBills(query: UpcomingBillsQuery): Promise<UpcomingBillsResult> {
    return parseUpcomingBillsResult(
      await this.#request('/v1/upcoming-bills', query),
    );
  }
  async budgetCapacity(
    query: BudgetCapacityQuery,
  ): Promise<BudgetCapacityResult> {
    return parseBudgetCapacityResult(
      await this.#request('/v1/budget-capacity', query),
    );
  }
  async budgetProgress(
    query: BudgetProgressQuery,
  ): Promise<BudgetProgressResult> {
    return parseBudgetProgressResult(
      await this.#request('/v1/budget-progress', query),
    );
  }
  async overspending(query: OverspendingQuery): Promise<OverspendingResult> {
    return parseOverspendingResult(
      await this.#request('/v1/overspending', query),
    );
  }
  async transactionExplanation(
    query: TransactionExplanationQuery,
  ): Promise<TransactionExplanationResult> {
    return parseTransactionExplanationResult(
      await this.#request('/v1/transaction-explanation', query),
    );
  }
  async transactionSearch(
    query: TransactionSearchQuery,
  ): Promise<TransactionSearchResult> {
    return parseTransactionSearchResult(
      await this.#request('/v1/transaction-search', query),
    );
  }
  async needsCategorization(
    query: NeedsCategorizationQuery,
  ): Promise<NeedsCategorizationResult> {
    return parseNeedsCategorizationResult(
      await this.#request('/v1/needs-categorization', query),
    );
  }
  async categoryExplanation(
    query: CategoryExplanationQuery,
  ): Promise<CategoryExplanationResult> {
    return parseCategoryExplanationResult(
      await this.#request('/v1/category-explanation', query),
    );
  }
  async searchReceipts(
    query: ReceiptSearchQuery,
  ): Promise<ReceiptSearchResult> {
    return parseReceiptSearchResult(
      await this.#request('/v1/receipt-search', query),
    );
  }
  async syncNow(): Promise<ActualReadSyncResult> {
    return parseActualReadSyncResult(await this.#request('/v1/sync', {}));
  }

  async #request(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers:
          body === undefined
            ? {
                accept: 'application/json',
                'x-household-finance-read-version': '2',
              }
            : {
                accept: 'application/json',
                'content-type': 'application/json',
                'x-household-finance-read-version': '2',
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });
      return await parseJsonResponse(response, controller.signal);
    } catch (error) {
      if (response !== undefined) await cancelResponseBody(response);
      if (
        error instanceof ActualReadClientError ||
        error instanceof ActualReadProtocolError ||
        error instanceof ActualReadNotFoundError ||
        error instanceof ActualPrepareCategorizationUpdateRefusedError
      ) {
        throw error;
      }
      throw new ActualReadClientError('request-failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Internal-only client for identifier-bearing deterministic workflows. Keep
 * this dependency out of every model-facing constructor.
 */
export class ActualDeterministicTransactionHttpClient
  implements ActualDeterministicTransactionPort, ActualReceiptRecordReadPort
{
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ActualReadHttpClientOptions) {
    this.#endpoint = origin(options.endpoint);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 100 ||
      this.#timeoutMs > 120_000
    ) {
      throw new ActualReadClientError('invalid-endpoint');
    }
  }

  async scanImportedTransactions(
    query: ActualImportedTransactionScanQuery,
  ): Promise<ActualImportedTransactionScanResult> {
    return parseImportedTransactionScanResult(
      await this.#request('/v1/internal/imported-transactions', query),
    );
  }

  async candidatesForReceipt(
    intent: ReceiptMatchIntent,
  ): Promise<readonly ImportedTransactionCandidate[]> {
    return parseImportedTransactionCandidates(
      await this.#request('/v1/internal/receipt-candidates', intent),
    );
  }

  async prepareCategorizationUpdate(
    request: ActualPrepareCategorizationUpdateRequest,
  ): Promise<ActualPrepareCategorizationUpdateResult> {
    return parsePrepareCategorizationUpdateResult(
      await this.#request(
        '/v1/internal/prepare-categorization-update',
        request,
      ),
    );
  }

  async receiptRecords(
    query: ReceiptRecordListQuery,
  ): Promise<ReceiptRecordListResult> {
    return parseReceiptRecordListResult(
      await this.#request('/v1/internal/receipt-records', query),
    );
  }

  async #request(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-household-finance-read-version': '2',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      return await parseJsonResponse(response, controller.signal);
    } catch (error) {
      if (response !== undefined) await cancelResponseBody(response);
      if (
        error instanceof ActualReadClientError ||
        error instanceof ActualReadProtocolError ||
        error instanceof ActualReadNotFoundError ||
        error instanceof ActualPrepareCategorizationUpdateRefusedError
      ) {
        throw error;
      }
      throw new ActualReadClientError('request-failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
