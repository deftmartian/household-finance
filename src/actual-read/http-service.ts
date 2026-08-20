import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  ActualApiReadConfigurationError,
  ActualApiReadLifecycleError,
} from './actual-api-reader.js';
import {
  ActualPrepareCategorizationUpdateRefusedError,
  ActualReadDataError,
  ActualReadNotFoundError,
  type ActualReadServicePort,
} from './port.js';
import {
  ACTUAL_READ_JSON_CONTENT_TYPE,
  ActualReadProtocolError,
  MAX_ACTUAL_READ_REQUEST_BYTES,
  MAX_ACTUAL_READ_RESPONSE_BYTES,
  parseAccountBalancesQuery,
  parseAccountBalancesResult,
  parseActualReadCatalog,
  parseActualReadSyncResult,
  parseAvailableFundsQuery,
  parseAvailableFundsResult,
  parseBudgetCapacityQuery,
  parseBudgetCapacityResult,
  parseBudgetProgressQuery,
  parseBudgetProgressResult,
  parseCashFlowQuery,
  parseCashFlowResult,
  parseCategoryExplanationQuery,
  parseCategoryExplanationResult,
  parseCategorySpendQuery,
  parseCategorySpendResult,
  parseIncomeQuery,
  parseIncomeResult,
  parseImportedTransactionCandidates,
  parseImportedTransactionScanQuery,
  parseImportedTransactionScanResult,
  parseMerchantSpendQuery,
  parseMerchantSpendResult,
  parseNeedsCategorizationQuery,
  parseNeedsCategorizationResult,
  parseOverspendingQuery,
  parseOverspendingResult,
  parseReceiptRecordListQuery,
  parseReceiptRecordListResult,
  parseReceiptSearchQuery,
  parseReceiptSearchResult,
  parsePrepareCategorizationUpdateRequest,
  parsePrepareCategorizationUpdateResult,
  parseTransactionExplanationQuery,
  parseTransactionExplanationResult,
  parseTransactionSearchQuery,
  parseTransactionSearchResult,
  parseUpcomingBillsQuery,
  parseUpcomingBillsResult,
  parseReceiptMatchIntent,
} from './protocol.js';

const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;

export type ActualReadServiceReportCode =
  | 'invalid_request'
  | 'not_found'
  | 'preparation_refused'
  | 'reader_unavailable'
  | 'data_contract_failed'
  | 'internal_error';

export interface ActualReadHttpServiceOptions {
  readonly reportError?: (code: ActualReadServiceReportCode) => void;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ActualReadServiceReportCode,
  ) {
    super(`Actual read request failed: ${code}`);
    this.name = 'RequestError';
  }
}

function payload(value: unknown): Buffer {
  const result = Buffer.from(JSON.stringify(value), 'utf8');
  if (result.byteLength > MAX_ACTUAL_READ_RESPONSE_BYTES) {
    result.fill(0);
    throw new ActualReadDataError();
  }
  return result;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = payload(value);
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': String(body.byteLength),
    'content-type': ACTUAL_READ_JSON_CONTENT_TYPE,
    'x-content-type-options': 'nosniff',
  });
  const wipe = (): void => {
    body.fill(0);
  };
  response.once('close', wipe);
  response.end(body, wipe);
}

function validatedOutput<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof ActualReadProtocolError) {
      throw new ActualReadDataError();
    }
    throw error;
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers['transfer-encoding'] !== undefined ||
    request.headers['content-encoding'] !== undefined ||
    request.headers['content-type'] !== 'application/json'
  ) {
    throw new RequestError(400, 'invalid_request');
  }
  const rawLength = request.headers['content-length'];
  if (
    typeof rawLength !== 'string' ||
    !/^[1-9]\d*$/.test(rawLength) ||
    Number(rawLength) > MAX_ACTUAL_READ_REQUEST_BYTES
  ) {
    throw new RequestError(400, 'invalid_request');
  }
  const expected = Number(rawLength);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (length > expected || length > MAX_ACTUAL_READ_REQUEST_BYTES) {
        bytes.fill(0);
        throw new RequestError(400, 'invalid_request');
      }
      chunks.push(bytes);
    }
    if (length !== expected) throw new RequestError(400, 'invalid_request');
    const body = Buffer.concat(chunks, length);
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw new RequestError(400, 'invalid_request');
    } finally {
      body.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function createActualReadHttpServer(
  reader: ActualReadServicePort,
  options: ActualReadHttpServiceOptions = {},
): Server {
  const report = (code: ActualReadServiceReportCode): void => {
    try {
      options.reportError?.(code);
    } catch {
      // Reporting receives only fixed codes and is best-effort.
    }
  };
  const compatibleOutput = (
    request: IncomingMessage,
    value: unknown,
  ): unknown => {
    if (
      request.headers['x-household-finance-read-version'] === '2' ||
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return value;
    }
    const record = value as Readonly<Record<string, unknown>>;
    const freshnessValue = record.freshness;
    if (
      freshnessValue === null ||
      typeof freshnessValue !== 'object' ||
      Array.isArray(freshnessValue)
    ) {
      return value;
    }
    const legacyFreshness: Record<string, unknown> = {
      ...(freshnessValue as Readonly<Record<string, unknown>>),
    };
    delete legacyFreshness.lastAttemptSummary;
    return {
      ...record,
      ...(record.outcome === 'partial' ? { outcome: 'failed' } : {}),
      freshness: {
        ...legacyFreshness,
        ...(legacyFreshness.lastOutcome === 'partial'
          ? { lastOutcome: 'failed' }
          : {}),
      },
    };
  };
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === 'GET' && request.url === '/health/live') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health/ready') {
      sendJson(response, 200, { status: 'ready' });
      return;
    }
    if (request.method === 'GET' && request.url === '/v1/catalog') {
      sendJson(
        response,
        200,
        compatibleOutput(
          request,
          validatedOutput(parseActualReadCatalog, await reader.catalog()),
        ),
      );
      return;
    }
    if (request.method !== 'POST' || request.url === undefined) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    const body = await readJson(request);
    let result: unknown;
    switch (request.url) {
      case '/v1/account-balances':
        result = validatedOutput(
          parseAccountBalancesResult,
          await reader.accountBalances(parseAccountBalancesQuery(body)),
        );
        break;
      case '/v1/available-funds':
        result = validatedOutput(
          parseAvailableFundsResult,
          await reader.availableFunds(parseAvailableFundsQuery(body)),
        );
        break;
      case '/v1/category-spend':
        result = validatedOutput(
          parseCategorySpendResult,
          await reader.categorySpend(parseCategorySpendQuery(body)),
        );
        break;
      case '/v1/merchant-spend':
        result = validatedOutput(
          parseMerchantSpendResult,
          await reader.merchantSpend(parseMerchantSpendQuery(body)),
        );
        break;
      case '/v1/income':
        result = validatedOutput(
          parseIncomeResult,
          await reader.income(parseIncomeQuery(body)),
        );
        break;
      case '/v1/cash-flow':
        result = validatedOutput(
          parseCashFlowResult,
          await reader.cashFlow(parseCashFlowQuery(body)),
        );
        break;
      case '/v1/upcoming-bills':
        result = validatedOutput(
          parseUpcomingBillsResult,
          await reader.upcomingBills(parseUpcomingBillsQuery(body)),
        );
        break;
      case '/v1/budget-capacity':
        result = validatedOutput(
          parseBudgetCapacityResult,
          await reader.budgetCapacity(parseBudgetCapacityQuery(body)),
        );
        break;
      case '/v1/budget-progress':
        result = validatedOutput(
          parseBudgetProgressResult,
          await reader.budgetProgress(parseBudgetProgressQuery(body)),
        );
        break;
      case '/v1/overspending':
        result = validatedOutput(
          parseOverspendingResult,
          await reader.overspending(parseOverspendingQuery(body)),
        );
        break;
      case '/v1/transaction-explanation':
        result = validatedOutput(
          parseTransactionExplanationResult,
          await reader.transactionExplanation(
            parseTransactionExplanationQuery(body),
          ),
        );
        break;
      case '/v1/transaction-search':
        result = validatedOutput(
          parseTransactionSearchResult,
          await reader.transactionSearch(parseTransactionSearchQuery(body)),
        );
        break;
      case '/v1/needs-categorization':
        result = validatedOutput(
          parseNeedsCategorizationResult,
          await reader.needsCategorization(parseNeedsCategorizationQuery(body)),
        );
        break;
      case '/v1/category-explanation':
        result = validatedOutput(
          parseCategoryExplanationResult,
          await reader.categoryExplanation(parseCategoryExplanationQuery(body)),
        );
        break;
      case '/v1/receipt-search':
        result = validatedOutput(
          parseReceiptSearchResult,
          await reader.searchReceipts(parseReceiptSearchQuery(body)),
        );
        break;
      case '/v1/internal/imported-transactions':
        result = validatedOutput(
          parseImportedTransactionScanResult,
          await reader.scanImportedTransactions(
            parseImportedTransactionScanQuery(body),
          ),
        );
        break;
      case '/v1/internal/receipt-candidates':
        result = validatedOutput(
          parseImportedTransactionCandidates,
          await reader.candidatesForReceipt(parseReceiptMatchIntent(body)),
        );
        break;
      case '/v1/internal/prepare-categorization-update':
        result = validatedOutput(
          parsePrepareCategorizationUpdateResult,
          await reader.prepareCategorizationUpdate(
            parsePrepareCategorizationUpdateRequest(body),
          ),
        );
        break;
      case '/v1/internal/receipt-records':
        result = validatedOutput(
          parseReceiptRecordListResult,
          await reader.receiptRecords(parseReceiptRecordListQuery(body)),
        );
        break;
      case '/v1/sync':
        if (
          typeof body !== 'object' ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0
        ) {
          throw new ActualReadProtocolError();
        }
        result = validatedOutput(
          parseActualReadSyncResult,
          await reader.syncNow(),
        );
        break;
      default:
        sendJson(response, 404, { error: 'not_found' });
        return;
    }
    sendJson(response, 200, compatibleOutput(request, result));
  };

  const server = createServer(
    {
      headersTimeout: HEADERS_TIMEOUT_MS,
      maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        if (
          error instanceof RequestError ||
          error instanceof ActualReadProtocolError
        ) {
          report('invalid_request');
          sendJson(response, 400, { error: 'invalid_request' });
        } else if (error instanceof ActualReadNotFoundError) {
          report('not_found');
          sendJson(response, 404, { error: 'not_found', kind: error.kind });
        } else if (
          error instanceof ActualPrepareCategorizationUpdateRefusedError
        ) {
          report('preparation_refused');
          sendJson(response, 409, {
            error: 'preparation_refused',
            code: error.code,
          });
        } else if (error instanceof ActualApiReadLifecycleError) {
          report('reader_unavailable');
          sendJson(response, 503, { error: 'reader_unavailable' });
        } else if (
          error instanceof ActualReadDataError ||
          error instanceof ActualApiReadConfigurationError
        ) {
          report('data_contract_failed');
          sendJson(response, 500, { error: 'data_contract_failed' });
        } else {
          report('internal_error');
          sendJson(response, 500, { error: 'internal_error' });
        }
      });
    },
  );
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1_000;
  return server;
}
