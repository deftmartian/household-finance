import { z } from 'zod';

import type { XaiFunctionTool } from '../model/xai-structured-client.js';
import {
  ActualReadNotFoundError,
  type ActualReadPort,
} from '../actual-read/port.js';
import {
  ActualReadProtocolError,
  accountBalancesQuerySchema,
  availableFundsQuerySchema,
  budgetCapacityQuerySchema,
  budgetProgressQuerySchema,
  cashFlowQuerySchema,
  categoryExplanationQuerySchema,
  categorySpendQuerySchema,
  incomeQuerySchema,
  merchantSpendQuerySchema,
  needsCategorizationQuerySchema,
  overspendingQuerySchema,
  receiptSearchQuerySchema,
  parseAccountBalancesQuery,
  parseAvailableFundsQuery,
  parseBudgetCapacityQuery,
  parseBudgetProgressQuery,
  parseCashFlowQuery,
  parseCategoryExplanationQuery,
  parseCategorySpendQuery,
  parseIncomeQuery,
  parseMerchantSpendQuery,
  parseNeedsCategorizationQuery,
  parseOverspendingQuery,
  parseReceiptSearchQuery,
  parseTransactionSearchQuery,
  parseUpcomingBillsQuery,
  transactionSearchQuerySchema,
  upcomingBillsQuerySchema,
} from '../actual-read/protocol.js';
import {
  transformExactFacts,
  transformReceiptExactFacts,
} from './model-safe-facts.js';

function parameters(schema: z.ZodType): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    reused: 'inline',
  }) as Readonly<Record<string, unknown>>;
}

function readTool<T>(
  name: string,
  description: string,
  schema: z.ZodType,
  parse: (value: unknown) => T,
  run: (value: T) => Promise<unknown>,
  transform: (value: unknown) => unknown = transformExactFacts,
): XaiFunctionTool {
  return {
    name,
    description,
    parameters: parameters(schema),
    execute: async (value) => {
      try {
        return transform(await run(parse(value)));
      } catch (error) {
        if (error instanceof ActualReadNotFoundError) {
          return { error: 'not_found', kind: error.kind };
        }
        if (error instanceof ActualReadProtocolError) {
          return { error: 'invalid_arguments' };
        }
        throw error;
      }
    },
  };
}

export function actualReadTools(
  reader: ActualReadPort,
): readonly XaiFunctionTool[] {
  return [
    readTool(
      'needs_categorization',
      'Return candidate imported transactions over at most one year that may need categorization: uncategorized, unsplit, on-budget ordinary purchases or cashback. Receipt reservations are rechecked at the write boundary, so treat these as candidates rather than a guaranteed actionable queue. Use this for questions such as how many transactions may need categorization or which uncategorized transactions remain. The count covers every candidate even when the returned row list is truncated.',
      needsCategorizationQuerySchema,
      parseNeedsCategorizationQuery,
      (query) => reader.needsCategorization(query),
    ),
    readTool(
      'search_transactions',
      'Search at most one year of the complete bound Actual ledger, including off-budget accounts and transfers. Use exact catalog names or null, optionally filter by one exact absolute amount in CAD cents, choose ordinary versus transfer rows, and sort by newest or largest absolute amount. An Actual transaction already split across categories is returned once as its parent: split is true, amountMinorUnits is the full aggregate amount, and categoryNames lists the existing split. Totals cover every match even when the returned row list is truncated.',
      transactionSearchQuerySchema,
      parseTransactionSearchQuery,
      (query) => reader.transactionSearch(query),
    ),
    readTool(
      'search_receipts',
      'Search canonical receipt facts and authenticated household purpose notes stored in Actual over at most one year. Use this for a named merchant, a requested full receipt item list, or receipt details over a date range. The date filter uses the printed purchase date, or the receipt creation date when the printed date is unknown. Optional text words are matched across merchant, receipt reference, household purpose notes, and item descriptions; every word must occur. Results include up to the latest three household purpose notes in chronological order, and every included receipt contains all of its recorded items. Use a merchant substring separately when helpful. Results intentionally omit source paths, hashes, and internal receipt IDs. Counts cover every match; truncated means additional matching receipts were omitted, not items from an included receipt.',
      receiptSearchQuerySchema,
      parseReceiptSearchQuery,
      (query) => reader.searchReceipts(query),
      transformReceiptExactFacts,
    ),
    readTool(
      'category_spend',
      'Return exact spending, refunds, net spending, and transaction counts for one exact category and date range.',
      categorySpendQuerySchema,
      parseCategorySpendQuery,
      (query) => reader.categorySpend(query),
    ),
    readTool(
      'merchant_spend',
      'Return exact spending, refunds, net spending, and transaction counts for one exact payee and date range.',
      merchantSpendQuerySchema,
      parseMerchantSpendQuery,
      (query) => reader.merchantSpend(query),
    ),
    readTool(
      'cash_flow',
      'Return exact household income, spending, and net cash flow for a date range.',
      cashFlowQuerySchema,
      parseCashFlowQuery,
      (query) => reader.cashFlow(query),
    ),
    readTool(
      'income',
      'Return exact income and its transaction count for a date range.',
      incomeQuerySchema,
      parseIncomeQuery,
      (query) => reader.income(query),
    ),
    readTool(
      'account_balances',
      'Return the balance of one exact account or all bound accounts as of a date.',
      accountBalancesQuerySchema,
      parseAccountBalancesQuery,
      (query) => reader.accountBalances(query),
    ),
    readTool(
      'available_funds',
      'Return the current Actual envelope summary and amount available after upcoming obligations.',
      availableFundsQuerySchema,
      parseAvailableFundsQuery,
      (query) => reader.availableFunds(query),
    ),
    readTool(
      'upcoming_bills',
      'Return active scheduled bills in an exact date range.',
      upcomingBillsQuerySchema,
      parseUpcomingBillsQuery,
      (query) => reader.upcomingBills(query),
    ),
    readTool(
      'budget_progress',
      'Return budgeted, spent, remaining, and overspent amounts for one exact category or all categories in a month.',
      budgetProgressQuerySchema,
      parseBudgetProgressQuery,
      (query) => reader.budgetProgress(query),
    ),
    readTool(
      'overspending',
      'Return all overspent categories and the exact total for a month.',
      overspendingQuerySchema,
      parseOverspendingQuery,
      (query) => reader.overspending(query),
    ),
    readTool(
      'budget_capacity',
      'Return the hard Actual ceiling available for one exact target category in a month. Household context still determines what is prudent.',
      budgetCapacityQuerySchema,
      parseBudgetCapacityQuery,
      (query) => reader.budgetCapacity(query),
    ),
    readTool(
      'category_explanation',
      'Explain one exact category total using its largest payee contributions and categorization completeness.',
      categoryExplanationQuerySchema,
      parseCategoryExplanationQuery,
      (query) => reader.categoryExplanation(query),
    ),
  ];
}

/**
 * Grok is materially more reliable when the read surface is presented as one
 * function with typed operation branches instead of a dozen sibling
 * functions. The selected branch still dispatches through the same strict
 * parser and bounded reader implementation above.
 */
export function actualReadAgentTool(reader: ActualReadPort): XaiFunctionTool {
  const tools: readonly XaiFunctionTool[] = [
    {
      name: 'catalog',
      description:
        'List the exact account, category, and merchant names available to the other read operations.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (value) => {
        const parsed = z.strictObject({}).safeParse(value);
        return parsed.success
          ? transformExactFacts(await reader.catalog())
          : { error: 'invalid_arguments' };
      },
    },
    ...actualReadTools(reader),
  ];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    name: 'read_actual',
    description:
      'Read verified household finance facts from Actual. Choose exactly one typed operation branch and its query. Call this repeatedly when the question needs more than one fact.',
    parameters: {
      oneOf: tools.map((tool) => ({
        type: 'object',
        description: tool.description,
        properties: {
          operation: { const: tool.name },
          query: tool.parameters,
        },
        required: ['operation', 'query'],
        additionalProperties: false,
      })),
    },
    execute: async (value, signal) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'invalid_arguments' };
      }
      const record = value as Record<string, unknown>;
      if (
        typeof record.operation !== 'string' ||
        !Object.hasOwn(record, 'query')
      ) {
        return { error: 'invalid_arguments' };
      }
      const tool = toolsByName.get(record.operation);
      return tool === undefined
        ? { error: 'invalid_arguments' }
        : tool.execute(record.query, signal);
    },
  };
}
