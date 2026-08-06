import {
  ReceiptNoteEnvelopeAuthenticationError,
  type ReceiptNoteEnvelopeAuthenticator,
} from './auth.js';
import {
  ReceiptNoteOutboxLeaseError,
  type ReceiptNoteOutboxStore,
} from './outbox-store.js';
import {
  ReceiptNoteWriteOutcomeUnknownError,
  ReceiptNoteWriteRefusedError,
  type ActualReceiptNoteWriter,
} from './writer.js';

function currentInstant(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError('Receipt-note workflow clock returned an invalid Date');
  }
  return value.toISOString();
}

export type ReceiptNoteWorkflowStepResult =
  | { readonly status: 'none' }
  | {
      readonly status: 'applied' | 'ambiguous';
      readonly receiptId: string;
      readonly revision: number;
      readonly resultStatus: 'updated' | 'already-desired' | 'ambiguous';
      readonly reconciliation: boolean;
    }
  | {
      readonly status: 'retrying' | 'failed';
      readonly receiptId: string;
      readonly revision: number;
      readonly errorCode: string;
      readonly reconciliation: boolean;
    };

export interface ReceiptNoteWorkflowOptions {
  readonly store: ReceiptNoteOutboxStore;
  readonly writer: ActualReceiptNoteWriter;
  readonly authenticator: ReceiptNoteEnvelopeAuthenticator;
  readonly now?: () => Date;
}

export class ReceiptNoteWorkflow {
  readonly #store: ReceiptNoteOutboxStore;
  readonly #writer: ActualReceiptNoteWriter;
  readonly #authenticator: ReceiptNoteEnvelopeAuthenticator;
  readonly #now: () => Date;

  constructor(options: ReceiptNoteWorkflowOptions) {
    this.#store = options.store;
    this.#writer = options.writer;
    this.#authenticator = options.authenticator;
    this.#now = options.now ?? (() => new Date());
  }

  processNext(): Promise<ReceiptNoteWorkflowStepResult> {
    const claim = this.#store.claimNext(currentInstant(this.#now));
    if (claim === undefined) {
      return Promise.resolve({ status: 'none' });
    }
    return (async (): Promise<ReceiptNoteWorkflowStepResult> => {
      let payload;
      try {
        payload = this.#authenticator.verify(claim.envelope);
      } catch (error) {
        if (!(error instanceof ReceiptNoteEnvelopeAuthenticationError)) {
          throw error;
        }
        this.#store.fail(claim, 'invalid-envelope', currentInstant(this.#now));
        return {
          status: 'failed',
          receiptId: claim.receiptId,
          revision: claim.revision,
          errorCode: 'invalid-envelope',
          reconciliation: claim.mode === 'reconcile',
        };
      }

      let mutationStarted = false;
      try {
        const result = await this.#writer.upsert(payload, () => {
          this.#store.markApplying(claim, currentInstant(this.#now));
          mutationStarted = true;
        });
        this.#store.complete(claim, result, currentInstant(this.#now));
        return {
          status: result.status === 'ambiguous' ? 'ambiguous' : 'applied',
          receiptId: claim.receiptId,
          revision: claim.revision,
          resultStatus: result.status,
          reconciliation: claim.mode === 'reconcile',
        };
      } catch (error) {
        if (error instanceof ReceiptNoteOutboxLeaseError) {
          throw error;
        }
        const occurredAt = currentInstant(this.#now);
        if (
          mutationStarted ||
          error instanceof ReceiptNoteWriteOutcomeUnknownError
        ) {
          this.#store.scheduleReconciliation(
            claim,
            'write-outcome-unknown',
            occurredAt,
          );
          return {
            status: 'retrying',
            receiptId: claim.receiptId,
            revision: claim.revision,
            errorCode: 'write-outcome-unknown',
            reconciliation: true,
          };
        }
        if (error instanceof ReceiptNoteWriteRefusedError) {
          this.#store.fail(claim, 'write-refused', occurredAt);
          return {
            status: 'failed',
            receiptId: claim.receiptId,
            revision: claim.revision,
            errorCode: 'write-refused',
            reconciliation: claim.mode === 'reconcile',
          };
        }
        this.#store.retrySafeFailure(claim, 'actual-read-failed', occurredAt);
        return {
          status: 'retrying',
          receiptId: claim.receiptId,
          revision: claim.revision,
          errorCode: 'actual-read-failed',
          reconciliation: claim.mode === 'reconcile',
        };
      }
    })();
  }
}

export interface ReceiptNoteReconcilerOptions {
  readonly store: Pick<ReceiptNoteOutboxStore, 'recoverExpiredLeases'>;
  readonly workflow: Pick<ReceiptNoteWorkflow, 'processNext'>;
  readonly now?: () => Date;
}

export class ReceiptNoteReconciler {
  readonly #store: Pick<ReceiptNoteOutboxStore, 'recoverExpiredLeases'>;
  readonly #workflow: Pick<ReceiptNoteWorkflow, 'processNext'>;
  readonly #now: () => Date;

  constructor(options: ReceiptNoteReconcilerOptions) {
    this.#store = options.store;
    this.#workflow = options.workflow;
    this.#now = options.now ?? (() => new Date());
  }

  async runOne(): Promise<boolean> {
    this.#store.recoverExpiredLeases(currentInstant(this.#now));
    const result = await this.#workflow.processNext();
    return result.status !== 'none';
  }
}
