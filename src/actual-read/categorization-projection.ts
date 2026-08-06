import {
  transactionCategorizationObservationSchema,
  type TransactionCategorizationObservation,
} from '../categorization/transaction.js';
import type { ActualImportedTransactionObservation } from './port.js';
import { parseImportedTransactionObservation } from './protocol.js';

/**
 * The only model-safe projection of an identifier-bearing Actual observation.
 * Refund is represented by its direction because the categorization contract's
 * special-kind field intentionally contains only categories that change the
 * deterministic decision path.
 */
export function projectImportedTransactionForCategorization(
  untrusted: ActualImportedTransactionObservation,
): TransactionCategorizationObservation {
  const observation = parseImportedTransactionObservation(untrusted);
  return transactionCategorizationObservationSchema.parse({
    schemaVersion: 'transaction-categorization-observation.v1',
    date: observation.date,
    accountAlias: observation.accountAlias,
    amountMinorUnits: observation.amountMinorUnits,
    direction: observation.direction,
    payeeName: observation.payeeName,
    memo: observation.memo,
    specialKind:
      observation.specialKind === 'refund'
        ? 'ordinary'
        : observation.specialKind,
    currentCategoryAlias: observation.currentCategoryAlias,
    // Actual's public transaction API does not expose a refund-origin link.
    originalRefundCategoryAlias: null,
  });
}
