import {
  matchReceiptToImportedTransactions,
  type ImportedTransactionCandidate,
  type ReceiptMatchIntent,
} from '../matching/index.js';
import {
  ReceiptMatchStoreConflictError,
  type ReceiptImportedTransactionLink,
  type ReceiptMatchStore,
} from '../storage/receipt-match-store.js';

export interface ImportedTransactionCandidateSource {
  candidatesForReceipt(
    intent: ReceiptMatchIntent,
  ): Promise<readonly ImportedTransactionCandidate[]>;
}

export interface ReceiptMatchApplier {
  applyReceiptMatch(
    receiptId: string,
    links: readonly ReceiptImportedTransactionLink[],
  ): Promise<
    | 'applied'
    | 'pending'
    | 'categorization-pending'
    | 'superseded'
    | 'needs-clarification'
    | void
  >;
}

export interface ReceiptMatchFreshnessSource {
  isCurrentReceiptSource(receiptId: string, sourceSha256: string): boolean;
}

export interface ReceiptPipelineReconcilerOptions {
  readonly matches: ReceiptMatchStore;
  readonly candidates: ImportedTransactionCandidateSource;
  readonly applier?: ReceiptMatchApplier;
  readonly freshness?: ReceiptMatchFreshnessSource;
  readonly now?: () => Date;
}

/**
 * Matches canonical receipt intake already recorded in ReceiptMatchStore,
 * retries delayed bank imports, and applies completed matches.
 */
export class ReceiptPipelineReconciler {
  readonly #matches: ReceiptMatchStore;
  readonly #candidates: ImportedTransactionCandidateSource;
  readonly #applier: ReceiptMatchApplier | undefined;
  readonly #freshness: ReceiptMatchFreshnessSource | undefined;
  readonly #now: () => Date;
  #running: Promise<number> | undefined;

  constructor(options: ReceiptPipelineReconcilerOptions) {
    this.#matches = options.matches;
    this.#candidates = options.candidates;
    this.#applier = options.applier;
    this.#freshness = options.freshness;
    this.#now = options.now ?? (() => new Date());
  }

  kick(): Promise<number> {
    this.#running ??= this.#process().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #process(): Promise<number> {
    this.#matches.expireAwaiting(this.#now().toISOString());
    let processed = await this.#processMatches();
    processed += await this.#processApplies();
    return processed;
  }

  async #processMatches(): Promise<number> {
    let processed = 0;
    while (processed < 100) {
      const job = this.#matches.claimNextDueMatch(this.#now().toISOString());
      if (job === undefined) {
        break;
      }
      const receipt = this.#matches.getReceipt(job.receiptId);
      if (receipt === undefined) {
        throw new Error('Claimed receipt match job has no receipt');
      }
      if (!this.#isCurrentReceipt(receipt.receiptId, receipt.idempotencyKey)) {
        this.#matches.retryMatch(
          job.id,
          job.receiptId,
          'canonical-receipt-not-ready',
          this.#now().toISOString(),
        );
        processed += 1;
        continue;
      }
      let result;
      try {
        const candidates = await this.#candidates.candidatesForReceipt(
          receipt.intent,
        );
        result = matchReceiptToImportedTransactions(receipt.intent, candidates);
      } catch {
        this.#matches.retryMatch(
          job.id,
          job.receiptId,
          'candidate-read-failed',
          this.#now().toISOString(),
        );
        processed += 1;
        continue;
      }
      if (!this.#isCurrentReceipt(receipt.receiptId, receipt.idempotencyKey)) {
        this.#matches.retryMatch(
          job.id,
          job.receiptId,
          'canonical-receipt-not-ready',
          this.#now().toISOString(),
        );
        processed += 1;
        continue;
      }
      const now = this.#now().toISOString();
      switch (result.disposition) {
        case 'pending':
          this.#matches.rescheduleAwaitingMatch(
            job.id,
            job.receiptId,
            now,
            'no-candidate',
          );
          break;
        case 'matched':
          try {
            this.#matches.recordMatchedSet(
              job.id,
              job.receiptId,
              [result.candidate],
              result.score,
              now,
            );
          } catch (error) {
            if (!(error instanceof ReceiptMatchStoreConflictError)) {
              throw error;
            }
            this.#matches.markAttention(
              job.id,
              job.receiptId,
              'match-conflict',
              now,
            );
          }
          break;
        case 'matched-set':
          try {
            this.#matches.recordMatchedSet(
              job.id,
              job.receiptId,
              result.candidates,
              result.score,
              now,
            );
          } catch (error) {
            if (!(error instanceof ReceiptMatchStoreConflictError)) {
              throw error;
            }
            this.#matches.markAttention(
              job.id,
              job.receiptId,
              'match-conflict',
              now,
            );
          }
          break;
        case 'ambiguous-set':
          this.#matches.markAttention(
            job.id,
            job.receiptId,
            'operator-review',
            now,
          );
          break;
        case 'ambiguous':
          this.#matches.recordAmbiguous(
            job.id,
            job.receiptId,
            result.candidates,
            now,
          );
          break;
        case 'manual':
          this.#matches.markAttention(job.id, job.receiptId, 'cash', now);
          break;
      }
      processed += 1;
    }
    return processed;
  }

  async #processApplies(): Promise<number> {
    if (this.#applier === undefined) {
      return 0;
    }
    let processed = 0;
    while (processed < 100) {
      const job = this.#matches.claimNextDueApply(this.#now().toISOString());
      if (job === undefined) {
        break;
      }
      const receipt = this.#matches.getReceipt(job.receiptId);
      if (
        receipt === undefined ||
        !this.#isCurrentReceipt(receipt.receiptId, receipt.idempotencyKey)
      ) {
        const now = this.#now();
        this.#matches.deferApply(
          job.id,
          job.receiptId,
          new Date(now.valueOf() + 60_000).toISOString(),
          now.toISOString(),
          'canonical-receipt-not-ready',
        );
        processed += 1;
        continue;
      }
      const links = this.#matches.getImportedTransactionLinks(job.receiptId);
      if (links.length === 0) {
        this.#matches.markAttention(
          job.id,
          job.receiptId,
          'match-conflict',
          this.#now().toISOString(),
        );
        processed += 1;
        continue;
      }
      try {
        const outcome = await this.#applier.applyReceiptMatch(
          job.receiptId,
          links,
        );
        if (outcome === 'needs-clarification') {
          this.#matches.markAttention(
            job.id,
            job.receiptId,
            'operator-review',
            this.#now().toISOString(),
          );
          processed += 1;
          continue;
        }
        if (outcome === 'categorization-pending') {
          const now = this.#now();
          this.#matches.deferApply(
            job.id,
            job.receiptId,
            new Date(now.valueOf() + 60_000).toISOString(),
            now.toISOString(),
            'receipt-categorization-missing',
          );
          processed += 1;
          continue;
        }
        if (outcome === 'pending') {
          const now = this.#now();
          this.#matches.deferApply(
            job.id,
            job.receiptId,
            new Date(now.valueOf() + 60_000).toISOString(),
            now.toISOString(),
          );
          processed += 1;
          continue;
        }
        if (outcome === 'superseded') {
          const now = this.#now();
          this.#matches.deferApply(
            job.id,
            job.receiptId,
            new Date(now.valueOf() + 60_000).toISOString(),
            now.toISOString(),
            'canonical-receipt-not-ready',
          );
          processed += 1;
          continue;
        }
        this.#matches.markApplied(
          job.id,
          job.receiptId,
          this.#now().toISOString(),
        );
      } catch {
        this.#matches.retryApply(
          job.id,
          job.receiptId,
          'receipt-apply-failed',
          this.#now().toISOString(),
        );
      }
      processed += 1;
    }
    return processed;
  }

  #isCurrentReceipt(receiptId: string, idempotencyKey: string): boolean {
    if (this.#freshness === undefined) {
      return true;
    }
    const prefix = 'receipt-source-sha256:';
    if (!idempotencyKey.startsWith(prefix)) {
      return false;
    }
    const sourceSha256 = idempotencyKey.slice(prefix.length);
    return this.#freshness.isCurrentReceiptSource(receiptId, sourceSha256);
  }
}
