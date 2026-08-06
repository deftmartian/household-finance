import { createHash } from 'node:crypto';

import type {
  ActualDeterministicTransactionPort,
  ActualImportedTransactionObservation,
  ActualPrepareCategorizationUpdateResult,
} from '../actual-read/port.js';
import {
  parseImportedTransactionScanResult,
  parsePrepareCategorizationUpdateResult,
} from '../actual-read/protocol.js';
import {
  actualReceiptLinkToken,
  extractActualReceiptLink,
} from '../actual-read/receipt-link-token.js';
import type {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateWorkflow,
} from '../actual-update/workflow.js';
import type {
  ActualUpdateInternalEnvelopePayloadV2,
  ActualUpdatePublicIntent,
} from '../storage/actual-update-store.js';
import type {
  ReadyReceiptCategorizationRecord,
  ReceiptCategorizationStore,
} from '../storage/receipt-categorization-store.js';
import type { ReceiptImportedTransactionLink } from '../storage/receipt-match-store.js';
import { plausibleForeignLedgerAmount } from '../matching/receipt-transaction.js';
import type { ReceiptMatchApplier } from '../workflow/receipt-pipeline-reconciler.js';
import type { CanonicalReceiptFreshnessSource } from '../receipts/record-projection.js';

const activeStatuses = new Set<ActualUpdatePublicIntent['status']>([
  'awaiting-approval',
  'queued',
  'claimed',
  'applying',
  'ambiguous',
]);

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(value.valueOf())) {
    throw new TypeError('Receipt purchase date is invalid');
  }
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function identity(
  record: ReadyReceiptCategorizationRecord,
  link: ReceiptImportedTransactionLink,
): {
  intentId: string;
  idempotencyKey: string;
  sourceId: string;
  auditId: string;
} {
  const digest = createHash('sha256')
    .update('receipt-existing-transaction-update.v1\0')
    .update(record.idempotencyKey)
    .update('\0')
    .update(link.accountAlias)
    .update('\0')
    .update(link.transactionId)
    .update('\0')
    .update(link.importedId)
    .digest('hex');
  return {
    intentId: `receipt-categorization/${digest}`,
    idempotencyKey: `receipt-update/${digest}`,
    sourceId: `receipt-categorization/${record.sourceSha256}`,
    auditId: `receipt-categorization-audit/${digest}`,
  };
}

function notesWithReceiptLink(
  notes: string | null,
  receiptId: string,
  sourceSha256: string,
): string {
  const current = notes ?? '';
  const extracted = extractActualReceiptLink(current);
  if (extracted.hasMalformedTokens) {
    throw new ActualReceiptMatchUpdateError('target-changed');
  }
  const existingForReceipt = extracted.links.filter(
    (link) => link.receiptId === receiptId,
  );
  if (
    existingForReceipt.length === 1 &&
    existingForReceipt[0]!.sourceSha256 === sourceSha256
  ) {
    return current;
  }
  const tokens = [
    ...extracted.links
      .filter((link) => link.receiptId !== receiptId)
      .map((link) => actualReceiptLinkToken(link.receiptId, link.sourceSha256)),
    actualReceiptLinkToken(receiptId, sourceSha256),
  ];
  const base = extracted.notesWithoutTokens.trimEnd();
  return [base, ...tokens].filter((part) => part.length > 0).join('\n');
}

function categoryAliases(
  record: ReadyReceiptCategorizationRecord,
): readonly string[] {
  return record.splits.map((split) => split.categoryAlias);
}

interface LedgerCategorySplit {
  readonly categoryAlias: string;
  readonly amountMinorUnits: number;
}

/**
 * Converts source-currency receipt splits to the imported transaction's exact
 * CAD total. Largest remainders receive the leftover cents, with category
 * alias as the stable tie-breaker, so every retry produces the same balanced
 * result.
 */
export function allocateReceiptSplitsToLedgerTotal(
  sourceSplits: readonly LedgerCategorySplit[],
  sourceTotalMinorUnits: number,
  ledgerTotalMinorUnits: number,
): readonly LedgerCategorySplit[] {
  if (
    sourceSplits.length === 0 ||
    !Number.isSafeInteger(sourceTotalMinorUnits) ||
    sourceTotalMinorUnits <= 0 ||
    !Number.isSafeInteger(ledgerTotalMinorUnits) ||
    ledgerTotalMinorUnits <= 0 ||
    new Set(sourceSplits.map((split) => split.categoryAlias)).size !==
      sourceSplits.length ||
    sourceSplits.some(
      (split) =>
        !Number.isSafeInteger(split.amountMinorUnits) ||
        split.amountMinorUnits <= 0,
    )
  ) {
    throw new RangeError('Receipt split conversion input is invalid');
  }
  const sourceTotal = BigInt(sourceTotalMinorUnits);
  if (
    sourceSplits.reduce(
      (total, split) => total + BigInt(split.amountMinorUnits),
      0n,
    ) !== sourceTotal
  ) {
    throw new RangeError('Receipt source splits do not equal the source total');
  }
  const ledgerTotal = BigInt(ledgerTotalMinorUnits);
  const allocations = sourceSplits.map((split, index) => {
    const numerator = BigInt(split.amountMinorUnits) * ledgerTotal;
    return {
      ...split,
      index,
      allocated: numerator / sourceTotal,
      remainder: numerator % sourceTotal,
    };
  });
  let leftover =
    ledgerTotal -
    allocations.reduce((total, split) => total + split.allocated, 0n);
  const remainderOrder = [...allocations].sort((left, right) =>
    left.remainder === right.remainder
      ? left.categoryAlias === right.categoryAlias
        ? 0
        : left.categoryAlias < right.categoryAlias
          ? -1
          : 1
      : left.remainder > right.remainder
        ? -1
        : 1,
  );
  for (let index = 0; leftover > 0n; index += 1) {
    const allocation = remainderOrder[index % remainderOrder.length];
    if (allocation === undefined) {
      throw new RangeError('Receipt split remainder cannot be reconciled');
    }
    allocation.allocated += 1n;
    leftover -= 1n;
  }
  return allocations
    .sort((left, right) => left.index - right.index)
    .map(({ categoryAlias, allocated }) => {
      const amountMinorUnits = Number(allocated);
      if (!Number.isSafeInteger(amountMinorUnits) || amountMinorUnits <= 0) {
        throw new RangeError('Converted receipt split is invalid');
      }
      return { categoryAlias, amountMinorUnits };
    });
}

function expectedLedgerCategorization(
  record: ReadyReceiptCategorizationRecord,
  ledgerAmountMinorUnits: number,
):
  | {
      readonly kind: 'single';
      readonly categoryAlias: string;
    }
  | {
      readonly kind: 'split';
      readonly splits: readonly LedgerCategorySplit[];
    } {
  if (
    !Number.isSafeInteger(ledgerAmountMinorUnits) ||
    ledgerAmountMinorUnits >= 0
  ) {
    throw new RangeError('Receipt ledger amount must be a negative expense');
  }
  if (record.splits.length === 1) {
    return {
      kind: 'single',
      categoryAlias: record.splits[0]!.categoryAlias,
    };
  }
  return {
    kind: 'split',
    splits: allocateReceiptSplitsToLedgerTotal(
      record.splits,
      record.totalMinorUnits,
      -ledgerAmountMinorUnits,
    ),
  };
}

function matchingExistingIntent(
  intent: ActualUpdatePublicIntent,
  record: ReadyReceiptCategorizationRecord,
  link: ReceiptImportedTransactionLink,
  authenticator: ActualUpdateEnvelopeAuthenticator,
  observed: ActualImportedTransactionObservation,
  desiredNotes: string,
): boolean {
  const expectedIdentity = identity(record, link);
  const proposal = intent.proposal;
  const ledgerAmountMinorUnits = observed.amountMinorUnits;
  let expectedCategorization;
  try {
    expectedCategorization = expectedLedgerCategorization(
      record,
      ledgerAmountMinorUnits,
    );
  } catch {
    return false;
  }
  const categorizationMatches =
    expectedCategorization.kind === 'single'
      ? proposal.categorization.kind === 'single' &&
        proposal.categorization.categoryAlias ===
          expectedCategorization.categoryAlias
      : proposal.categorization.kind === 'split' &&
        proposal.categorization.splits.length ===
          expectedCategorization.splits.length &&
        proposal.categorization.splits.every((split, index) => {
          const expected = expectedCategorization.splits[index];
          return (
            expected !== undefined &&
            split.categoryAlias === expected.categoryAlias &&
            split.amountMinorUnits === -expected.amountMinorUnits &&
            split.notes === null
          );
        });
  return (
    proposal.intentId === expectedIdentity.intentId &&
    proposal.idempotencyKey === expectedIdentity.idempotencyKey &&
    proposal.targetRef ===
      authenticator.createTargetRef({
        transactionId: link.transactionId,
        importedId: link.importedId,
      }) &&
    proposal.accountAlias === link.accountAlias &&
    proposal.summary?.date === record.record.purchaseDate &&
    proposal.summary.amountMinorUnits === ledgerAmountMinorUnits &&
    proposal.summary.payeeName === record.record.merchant &&
    proposal.payee.kind === 'preserve' &&
    proposal.notes.kind === 'set' &&
    proposal.notes.value === desiredNotes &&
    proposal.sourceId === expectedIdentity.sourceId &&
    proposal.auditId === expectedIdentity.auditId &&
    categorizationMatches
  );
}

function exactObservation(
  observations: readonly ActualImportedTransactionObservation[],
  link: ReceiptImportedTransactionLink,
): ActualImportedTransactionObservation {
  const matches = observations.filter(
    (candidate) =>
      candidate.transactionId === link.transactionId &&
      candidate.importedId === link.importedId &&
      candidate.accountAlias === link.accountAlias,
  );
  if (matches.length !== 1) {
    throw new ActualReceiptMatchUpdateError('target-not-found-or-ambiguous');
  }
  return matches[0]!;
}

function resolvedCategories(
  prepared: ActualPrepareCategorizationUpdateResult,
  expectedAliases: readonly string[],
): ReadonlyMap<string, string> {
  if (
    prepared.categories.length !== expectedAliases.length ||
    prepared.categories.some(
      (category, index) => category.alias !== expectedAliases[index],
    )
  ) {
    throw new ActualReceiptMatchUpdateError('preparation-invalid');
  }
  return new Map(
    prepared.categories.map((category) => [
      category.alias,
      category.categoryId,
    ]),
  );
}

export interface ActualReceiptMatchUpdateApplierOptions {
  readonly actual: Pick<
    ActualDeterministicTransactionPort,
    'scanImportedTransactions' | 'prepareCategorizationUpdate'
  >;
  readonly receipts: Pick<
    ReceiptCategorizationStore,
    'getSource' | 'getReadyReceipt'
  >;
  readonly actualUpdateWorkflow: Pick<ActualUpdateWorkflow, 'enqueue'>;
  readonly actualUpdateIntents: {
    getPublicIntent(intentId: string): ActualUpdatePublicIntent | undefined;
  };
  readonly authenticator: ActualUpdateEnvelopeAuthenticator;
  readonly freshness?: CanonicalReceiptFreshnessSource;
  readonly now?: () => Date;
}

export class ActualReceiptMatchUpdateError extends Error {
  constructor(
    readonly code:
      | 'receipt-link-conflict'
      | 'target-not-found-or-ambiguous'
      | 'target-changed'
      | 'preparation-invalid'
      | 'existing-intent-conflict'
      | 'update-intent-terminal',
  ) {
    super(`Receipt Actual update stopped safely: ${code}`);
    this.name = 'ActualReceiptMatchUpdateError';
  }
}

/**
 * Bridges a uniquely matched, deterministically split receipt into the same
 * signed update-existing workflow used by bank-only categorization.
 */
export class ActualReceiptMatchUpdateApplier implements ReceiptMatchApplier {
  readonly #actual: ActualReceiptMatchUpdateApplierOptions['actual'];
  readonly #receipts: ActualReceiptMatchUpdateApplierOptions['receipts'];
  readonly #workflow: ActualReceiptMatchUpdateApplierOptions['actualUpdateWorkflow'];
  readonly #intents: ActualReceiptMatchUpdateApplierOptions['actualUpdateIntents'];
  readonly #authenticator: ActualUpdateEnvelopeAuthenticator;
  readonly #freshness: CanonicalReceiptFreshnessSource | undefined;
  readonly #now: () => Date;

  constructor(options: ActualReceiptMatchUpdateApplierOptions) {
    this.#actual = options.actual;
    this.#receipts = options.receipts;
    this.#workflow = options.actualUpdateWorkflow;
    this.#intents = options.actualUpdateIntents;
    this.#authenticator = options.authenticator;
    this.#freshness = options.freshness;
    this.#now = options.now ?? (() => new Date());
  }

  async applyReceiptMatch(
    receiptId: string,
    links: readonly ReceiptImportedTransactionLink[],
  ): Promise<
    | 'applied'
    | 'pending'
    | 'categorization-pending'
    | 'superseded'
    | 'needs-clarification'
  > {
    const source = this.#receipts.getSource(receiptId);
    if (
      source === undefined ||
      source.record.purchaseDate === null ||
      source.record.currency === null ||
      source.record.amounts.totalMinor === null ||
      source.record.amounts.totalMinor <= 0
    ) {
      return 'categorization-pending';
    }
    if (!this.#isCurrent(receiptId, source.sourceSha256)) {
      return 'superseded';
    }
    if (
      !Array.isArray(links) ||
      links.length < 1 ||
      links.length > 6 ||
      links.some((link) => link.receiptId !== receiptId) ||
      new Set(
        links.map(
          (link) =>
            `${link.transactionId}\0${link.accountAlias}\0${link.importedId}`,
        ),
      ).size !== links.length
    ) {
      throw new ActualReceiptMatchUpdateError('receipt-link-conflict');
    }
    const receipt = this.#receipts.getReadyReceipt(receiptId);
    const plural = links.length > 1;
    if (receipt !== undefined && plural && receipt.splits.length !== 1) {
      return 'needs-clarification';
    }
    const scan = parseImportedTransactionScanResult(
      await this.#actual.scanImportedTransactions({
        startDate: source.record.purchaseDate,
        endDate: addUtcDays(source.record.purchaseDate, 7),
        previousWatermark: null,
      }),
    );
    const observations = links.map((link) => ({
      link,
      observed: exactObservation(scan.observations, link),
    }));
    if (!this.#isCurrent(receiptId, source.sourceSha256)) {
      return 'superseded';
    }
    if (
      observations.some(
        ({ observed }) =>
          observed.amountMinorUnits >= 0 || observed.direction !== 'expense',
      )
    ) {
      throw new ActualReceiptMatchUpdateError('target-changed');
    }
    if (plural) {
      if (
        source.record.currency !== 'CAD' ||
        observations.reduce(
          (total, { observed }) => total - observed.amountMinorUnits,
          0,
        ) !== source.record.amounts.totalMinor
      ) {
        return 'needs-clarification';
      }
    } else {
      const observed = observations[0]!.observed;
      if (
        (source.record.currency === 'CAD' &&
          observed.amountMinorUnits !== -source.record.amounts.totalMinor) ||
        (source.record.currency !== 'CAD' &&
          !plausibleForeignLedgerAmount(
            source.record.amounts.totalMinor,
            -observed.amountMinorUnits,
          ))
      ) {
        throw new ActualReceiptMatchUpdateError('target-changed');
      }
    }
    const existingReceiptLinks = observations.map(({ observed }) =>
      observed.alreadyLinkedReceipts.filter(
        (existing) => existing.receiptId === receiptId,
      ),
    );
    if (
      existingReceiptLinks.every((existing) =>
        existing.some((link) => link.sourceSha256 === source.sourceSha256),
      )
    ) {
      return 'applied';
    }
    if (
      existingReceiptLinks.some(
        (existing) =>
          existing.length > 0 &&
          !existing.some((link) => link.sourceSha256 === source.sourceSha256),
      )
    ) {
      return 'needs-clarification';
    }
    if (receipt === undefined) {
      return 'categorization-pending';
    }
    if (
      receipt.sourceSha256 !== source.sourceSha256 ||
      receipt.record.amounts.totalMinor !== receipt.totalMinorUnits ||
      receipt.totalMinorUnits <= 0 ||
      receipt.record.purchaseDate === null ||
      receipt.record.currency === null
    ) {
      throw new ActualReceiptMatchUpdateError('receipt-link-conflict');
    }
    const aliases = categoryAliases(receipt);
    let allLinksConfirmedInActual = true;
    const pendingEnqueues: Array<{
      readonly payload: ActualUpdateInternalEnvelopePayloadV2;
      readonly link: ReceiptImportedTransactionLink;
      readonly observed: ActualImportedTransactionObservation;
      readonly desiredNotes: string;
    }> = [];
    for (const { link, observed } of observations) {
      const existingReceiptLinks = observed.alreadyLinkedReceipts.filter(
        (existing) => existing.receiptId === receiptId,
      );
      if (
        existingReceiptLinks.some(
          (existing) => existing.sourceSha256 === receipt.sourceSha256,
        )
      ) {
        continue;
      }
      if (existingReceiptLinks.length > 0) {
        return 'needs-clarification';
      }
      if (observed.alreadyLinkedReceipts.length > 0) {
        throw new ActualReceiptMatchUpdateError('target-changed');
      }
      if (observed.split || observed.currentCategoryStatus === 'split') {
        throw new ActualReceiptMatchUpdateError('target-changed');
      }
      const prepared = parsePrepareCategorizationUpdateResult(
        await this.#actual.prepareCategorizationUpdate({
          accountAlias: link.accountAlias,
          transactionId: link.transactionId,
          importedId: link.importedId,
          date: observed.date,
          amountMinorUnits: observed.amountMinorUnits,
          expectedObservationFingerprint: observed.observationFingerprint,
          categoryAliases: aliases,
        }),
      );
      if (
        prepared.observed.transactionId !== link.transactionId ||
        prepared.observed.importedId !== link.importedId ||
        prepared.observed.amountMinorUnits !== observed.amountMinorUnits ||
        prepared.observed.date !== observed.date
      ) {
        throw new ActualReceiptMatchUpdateError('preparation-invalid');
      }
      if (!this.#isCurrent(receipt.receiptId, receipt.sourceSha256)) {
        return 'superseded';
      }
      const preparedLinks = extractActualReceiptLink(
        prepared.observed.editable.notes ?? '',
      );
      if (preparedLinks.hasMalformedTokens) {
        throw new ActualReceiptMatchUpdateError('target-changed');
      }
      const preparedReceiptLinks = preparedLinks.links.filter(
        (existing) => existing.receiptId === receiptId,
      );
      if (
        preparedReceiptLinks.some(
          (existing) => existing.sourceSha256 === receipt.sourceSha256,
        )
      ) {
        continue;
      }
      if (preparedReceiptLinks.length > 0) {
        return 'needs-clarification';
      }
      if (preparedLinks.links.length > 0) {
        throw new ActualReceiptMatchUpdateError('target-changed');
      }
      allLinksConfirmedInActual = false;
      const desiredNotes = notesWithReceiptLink(
        prepared.observed.editable.notes,
        receiptId,
        receipt.sourceSha256,
      );
      const expectedIdentity = identity(receipt, link);
      const existing = this.#intents.getPublicIntent(expectedIdentity.intentId);
      if (existing !== undefined) {
        if (
          !matchingExistingIntent(
            existing,
            receipt,
            link,
            this.#authenticator,
            observed,
            desiredNotes,
          )
        ) {
          throw new ActualReceiptMatchUpdateError('existing-intent-conflict');
        }
        if (
          existing.status === 'applied' ||
          activeStatuses.has(existing.status)
        ) {
          continue;
        }
        throw new ActualReceiptMatchUpdateError('update-intent-terminal');
      }

      const categories = resolvedCategories(prepared, aliases);
      const ledgerCategorization = expectedLedgerCategorization(
        receipt,
        observed.amountMinorUnits,
      );
      const categorization =
        ledgerCategorization.kind === 'single'
          ? {
              kind: 'single' as const,
              categoryId: categories.get(ledgerCategorization.categoryAlias)!,
            }
          : {
              kind: 'split' as const,
              splits: ledgerCategorization.splits.map((split) => ({
                categoryId: categories.get(split.categoryAlias)!,
                amountMinorUnits: -split.amountMinorUnits,
                notes: null,
              })),
            };
      if (
        (categorization.kind === 'single' &&
          categorization.categoryId === undefined) ||
        (categorization.kind === 'split' &&
          categorization.splits.some(
            (split) =>
              split.categoryId === undefined || split.amountMinorUnits === 0,
          ))
      ) {
        throw new ActualReceiptMatchUpdateError('preparation-invalid');
      }
      const publicCategorization =
        ledgerCategorization.kind === 'single'
          ? {
              kind: 'single' as const,
              categoryAlias: ledgerCategorization.categoryAlias,
            }
          : {
              kind: 'split' as const,
              splits: ledgerCategorization.splits.map((split) => ({
                categoryAlias: split.categoryAlias,
                amountMinorUnits: -split.amountMinorUnits,
                notes: null,
              })),
            };
      const createdAt = this.#now().toISOString();
      const payload: ActualUpdateInternalEnvelopePayloadV2 = {
        schemaVersion: 'actual-update-internal-payload.v2',
        publicProposal: {
          schemaVersion: 'actual-update-public-proposal.v2',
          intentId: expectedIdentity.intentId,
          idempotencyKey: expectedIdentity.idempotencyKey,
          targetRef: this.#authenticator.createTargetRef({
            transactionId: link.transactionId,
            importedId: link.importedId,
          }),
          accountAlias: link.accountAlias,
          summary: {
            date: receipt.record.purchaseDate,
            amountMinorUnits: observed.amountMinorUnits,
            payeeName: receipt.record.merchant,
          },
          payee: { kind: 'preserve' },
          notes: { kind: 'set', value: desiredNotes },
          categorization: publicCategorization,
          sourceId: expectedIdentity.sourceId,
          auditId: expectedIdentity.auditId,
          createdAt,
        },
        writerRequest: {
          idempotencyKey: expectedIdentity.idempotencyKey,
          observed: prepared.observed,
          edit: {
            payee: { kind: 'preserve' },
            notes: { kind: 'set', value: desiredNotes },
            categorization,
          },
        },
      };
      pendingEnqueues.push({ payload, link, observed, desiredNotes });
    }
    if (!this.#isCurrent(receipt.receiptId, receipt.sourceSha256)) {
      return 'superseded';
    }
    for (const plan of pendingEnqueues) {
      const enqueued = this.#workflow.enqueue(plan.payload);
      if (
        !matchingExistingIntent(
          enqueued.intent,
          receipt,
          plan.link,
          this.#authenticator,
          plan.observed,
          plan.desiredNotes,
        )
      ) {
        throw new ActualReceiptMatchUpdateError('existing-intent-conflict');
      }
    }
    return allLinksConfirmedInActual ? 'applied' : 'pending';
  }

  #isCurrent(receiptId: string, sourceSha256: string): boolean {
    return (
      this.#freshness?.isCurrentReceiptSource(receiptId, sourceSha256) ?? true
    );
  }
}
