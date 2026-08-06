import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  ActualPrepareCategorizationUpdateRefusedError,
  type ActualDeterministicTransactionPort,
  type ActualImportedTransactionObservation,
  type ActualPrepareCategorizationUpdateResult,
} from '../actual-read/port.js';
import {
  parseImportedTransactionScanResult,
  parsePrepareCategorizationUpdateResult,
} from '../actual-read/protocol.js';
import type {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateWorkflow,
} from '../actual-update/workflow.js';
import type {
  ActualUpdateInternalEnvelopePayloadV2,
  ActualUpdatePublicIntent,
} from '../storage/actual-update-store.js';
import {
  type TransactionCategorizationObservedRecord,
  type TransactionCategorizationStore,
  type TransactionCategoryUpdateRequest,
} from '../storage/transaction-categorization-store.js';
import type {
  TransactionCategorizationObservationSource,
  TransactionCategorizationScanPage,
  TransactionCategoryUpdateReconciliation,
  TransactionCategoryUpdateSink,
} from './workflow.js';

const MAXIMUM_ROLLING_WINDOW_DAYS = 90;
const activeIntentStatuses = new Set<ActualUpdatePublicIntent['status']>([
  'awaiting-approval',
  'queued',
  'claimed',
  'applying',
  'applied',
  'ambiguous',
]);

const updateRequestSchema = z.strictObject({
  schemaVersion: z.literal('transaction-category-update-request.v1'),
  idempotencyKey: z.string().min(1).max(200),
  importedId: z.string().min(1).max(500),
  accountAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  observationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  categoryAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});

function positiveRollingWindowDays(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAXIMUM_ROLLING_WINDOW_DAYS
  ) {
    throw new RangeError(
      `rollingWindowDays must be from 1 to ${String(MAXIMUM_ROLLING_WINDOW_DAYS)}`,
    );
  }
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${name} returned an invalid Date`);
  }
  return value;
}

function currentDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((candidate) => candidate.type === type)?.value;
    if (value === undefined) {
      throw new TypeError('Current calendar date is unavailable');
    }
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mappedSpecialKind(
  observation: ActualImportedTransactionObservation,
): Exclude<ActualImportedTransactionObservation['specialKind'], 'refund'> {
  return observation.specialKind === 'refund'
    ? 'ordinary'
    : observation.specialKind;
}

export interface ActualTransactionCategorizationObservationSourceOptions {
  readonly actual: Pick<
    ActualDeterministicTransactionPort,
    'scanImportedTransactions'
  >;
  readonly rollingWindowDays: number;
  readonly timeZone: string;
  readonly receiptReservationSource?: {
    isImportedTransactionReserved(
      accountAlias: string,
      importedId: string,
    ): boolean;
  };
  readonly now?: () => Date;
}

/**
 * Internal adapter from Actual's identifier-bearing scan plane to the strict
 * categorization observer. Only the nested `observation` reaches xAI.
 */
export class ActualTransactionCategorizationObservationSource implements TransactionCategorizationObservationSource {
  readonly #actual: Pick<
    ActualDeterministicTransactionPort,
    'scanImportedTransactions'
  >;
  readonly #rollingWindowDays: number;
  readonly #timeZone: string;
  readonly #receiptReservations:
    | ActualTransactionCategorizationObservationSourceOptions['receiptReservationSource']
    | undefined;
  readonly #now: () => Date;

  constructor(
    options: ActualTransactionCategorizationObservationSourceOptions,
  ) {
    this.#actual = options.actual;
    this.#rollingWindowDays = positiveRollingWindowDays(
      options.rollingWindowDays,
    );
    this.#receiptReservations = options.receiptReservationSource;
    try {
      new Intl.DateTimeFormat('en-CA', {
        timeZone: options.timeZone,
      }).format(new Date(0));
    } catch {
      throw new TypeError('timeZone is invalid');
    }
    this.#timeZone = options.timeZone;
    this.#now = options.now ?? (() => new Date());
  }

  async scan(
    previousWatermark: string | null,
    signal?: AbortSignal,
  ): Promise<TransactionCategorizationScanPage> {
    signal?.throwIfAborted();
    const endDate = currentDateInTimeZone(
      validDate(this.#now(), 'Categorization observation clock'),
      this.#timeZone,
    );
    const startDate = addCalendarDays(endDate, -(this.#rollingWindowDays - 1));
    const result = parseImportedTransactionScanResult(
      await this.#actual.scanImportedTransactions({
        startDate,
        endDate,
        previousWatermark,
      }),
    );
    signal?.throwIfAborted();
    if (result.startDate !== startDate || result.endDate !== endDate) {
      throw new TypeError(
        'Actual transaction scan returned a different rolling window',
      );
    }
    return {
      watermark: result.watermark,
      unchanged: result.unchanged,
      observations: result.observations
        .filter(
          (observation) =>
            !this.#receiptReservations?.isImportedTransactionReserved(
              observation.accountAlias,
              observation.importedId,
            ),
        )
        .map((observation) => ({
          schemaVersion: 'transaction-categorization-observer-record.v1',
          transactionId: observation.transactionId,
          importedId: observation.importedId,
          actualObservationFingerprint: observation.observationFingerprint,
          accountOnBudget: observation.accountOnBudget,
          currentCategoryStatus: observation.currentCategoryStatus,
          split: observation.split,
          observation: {
            schemaVersion: 'transaction-categorization-observation.v1',
            date: observation.date,
            accountAlias: observation.accountAlias,
            amountMinorUnits: observation.amountMinorUnits,
            direction: observation.direction,
            payeeName: observation.payeeName,
            memo: observation.memo,
            specialKind: mappedSpecialKind(observation),
            currentCategoryAlias: observation.currentCategoryAlias,
            /*
             * Actual does not expose a durable original-transaction link for a
             * bank refund. Receipt matching may supply that alias in a future
             * source; absent such evidence, the categorizer must not invent it.
             */
            originalRefundCategoryAlias: null,
          },
        })),
    };
  }
}

export interface ActualUpdatePublicIntentSource {
  getPublicIntent(intentId: string): ActualUpdatePublicIntent | undefined;
}

export interface ActualTransactionCategoryUpdateSinkOptions {
  readonly actual: Pick<
    ActualDeterministicTransactionPort,
    'prepareCategorizationUpdate'
  >;
  readonly categorizationStore: Pick<
    TransactionCategorizationStore,
    'getByImportedId'
  >;
  readonly actualUpdateWorkflow: Pick<ActualUpdateWorkflow, 'enqueue'>;
  readonly actualUpdateIntents: ActualUpdatePublicIntentSource;
  readonly authenticator: ActualUpdateEnvelopeAuthenticator;
}

type PreparedUpdate = {
  readonly requestFingerprint: string;
  readonly target: TransactionCategorizationObservedRecord;
  readonly preparation: ActualPrepareCategorizationUpdateResult;
};

function requestFingerprint(request: TransactionCategoryUpdateRequest): string {
  return createHash('sha256')
    .update('transaction-categorization-actual-request.v1\0')
    .update(request.idempotencyKey)
    .update('\0')
    .update(request.importedId)
    .update('\0')
    .update(request.accountAlias)
    .update('\0')
    .update(request.observationFingerprint)
    .update('\0')
    .update(request.categoryAlias)
    .digest('hex');
}

export function transactionCategorizationIntentIdentity(
  request: TransactionCategoryUpdateRequest,
): {
  intentId: string;
  sourceId: string;
  auditId: string;
} {
  const digest = requestFingerprint(request);
  return {
    intentId: `transaction-categorization/${digest}`,
    sourceId: `transaction-categorization/${digest}`,
    auditId: `transaction-categorization-audit/${digest}`,
  };
}

function isMatchingPublicIntent(
  intent: ActualUpdatePublicIntent,
  request: TransactionCategoryUpdateRequest,
  targetRef: string,
  target: TransactionCategorizationObservedRecord,
): boolean {
  const identity = transactionCategorizationIntentIdentity(request);
  const proposal = intent.proposal;
  return (
    proposal.intentId === identity.intentId &&
    proposal.idempotencyKey === request.idempotencyKey &&
    proposal.targetRef === targetRef &&
    proposal.accountAlias === request.accountAlias &&
    proposal.summary?.date === target.observation.date &&
    proposal.summary.amountMinorUnits === target.observation.amountMinorUnits &&
    proposal.summary.payeeName === target.observation.payeeName &&
    proposal.payee.kind === 'preserve' &&
    proposal.notes.kind === 'preserve' &&
    proposal.categorization.kind === 'single' &&
    proposal.categorization.categoryAlias === request.categoryAlias &&
    proposal.sourceId === identity.sourceId &&
    proposal.auditId === identity.auditId
  );
}

export class ActualTransactionCategoryUpdateAdapterError extends Error {
  constructor(
    readonly code:
      | 'target-missing-or-changed'
      | 'preparation-invalid'
      | 'existing-intent-conflict',
  ) {
    super(`Actual transaction categorization adapter stopped safely: ${code}`);
    this.name = 'ActualTransactionCategoryUpdateAdapterError';
  }
}

/**
 * Converts an alias-only categorization request into an authenticated,
 * approval-gated Actual update intent. A successful `apply` means durable
 * handoff to ActualUpdateWorkflow; the Actual public intent remains the source
 * of truth for approval and ledger-application state.
 */
export class ActualTransactionCategoryUpdateSink implements TransactionCategoryUpdateSink {
  readonly #actual: Pick<
    ActualDeterministicTransactionPort,
    'prepareCategorizationUpdate'
  >;
  readonly #categorizationStore: Pick<
    TransactionCategorizationStore,
    'getByImportedId'
  >;
  readonly #actualUpdateWorkflow: Pick<ActualUpdateWorkflow, 'enqueue'>;
  readonly #actualUpdateIntents: ActualUpdatePublicIntentSource;
  readonly #authenticator: ActualUpdateEnvelopeAuthenticator;
  readonly #prepared = new Map<string, PreparedUpdate>();

  constructor(options: ActualTransactionCategoryUpdateSinkOptions) {
    this.#actual = options.actual;
    this.#categorizationStore = options.categorizationStore;
    this.#actualUpdateWorkflow = options.actualUpdateWorkflow;
    this.#actualUpdateIntents = options.actualUpdateIntents;
    this.#authenticator = options.authenticator;
  }

  async reconcile(
    input: TransactionCategoryUpdateRequest,
    signal?: AbortSignal,
  ): Promise<TransactionCategoryUpdateReconciliation> {
    const request = updateRequestSchema.parse(
      input,
    ) as TransactionCategoryUpdateRequest;
    signal?.throwIfAborted();
    const target = this.#target(request);
    if (target === undefined) {
      return 'conflict';
    }
    const existing = this.#existing(request, target);
    if (existing !== 'needs-apply') {
      this.#prepared.delete(request.idempotencyKey);
      return existing;
    }
    try {
      const preparation = await this.#prepare(request, target, signal);
      this.#prepared.set(request.idempotencyKey, {
        requestFingerprint: requestFingerprint(request),
        target,
        preparation,
      });
      return 'needs-apply';
    } catch (error) {
      if (error instanceof ActualPrepareCategorizationUpdateRefusedError) {
        this.#prepared.delete(request.idempotencyKey);
        return 'conflict';
      }
      throw error;
    }
  }

  async apply(
    input: TransactionCategoryUpdateRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = updateRequestSchema.parse(
      input,
    ) as TransactionCategoryUpdateRequest;
    signal?.throwIfAborted();
    const target = this.#target(request);
    if (target === undefined) {
      throw new ActualTransactionCategoryUpdateAdapterError(
        'target-missing-or-changed',
      );
    }
    const existing = this.#existing(request, target);
    if (existing === 'already-applied') {
      this.#prepared.delete(request.idempotencyKey);
      return;
    }
    if (existing === 'conflict') {
      throw new ActualTransactionCategoryUpdateAdapterError(
        'existing-intent-conflict',
      );
    }

    const cached = this.#prepared.get(request.idempotencyKey);
    const prepared =
      cached?.requestFingerprint === requestFingerprint(request)
        ? cached
        : {
            requestFingerprint: requestFingerprint(request),
            target,
            preparation: await this.#prepare(request, target, signal),
          };
    const payload = this.#payload(request, prepared);
    const enqueued = this.#actualUpdateWorkflow.enqueue(payload);
    this.#prepared.delete(request.idempotencyKey);
    const reconciliation = this.#publicIntentReconciliation(
      enqueued.intent,
      request,
      target,
    );
    if (reconciliation !== 'already-applied') {
      throw new ActualTransactionCategoryUpdateAdapterError(
        'existing-intent-conflict',
      );
    }
  }

  #target(
    request: TransactionCategoryUpdateRequest,
  ): TransactionCategorizationObservedRecord | undefined {
    const target = this.#categorizationStore.getByImportedId(
      request.importedId,
    );
    return target !== undefined &&
      target.importedId === request.importedId &&
      target.observation.accountAlias === request.accountAlias &&
      target.actualObservationFingerprint === request.observationFingerprint
      ? target
      : undefined;
  }

  #existing(
    request: TransactionCategoryUpdateRequest,
    target: TransactionCategorizationObservedRecord,
  ): TransactionCategoryUpdateReconciliation {
    const intent = this.#actualUpdateIntents.getPublicIntent(
      transactionCategorizationIntentIdentity(request).intentId,
    );
    return intent === undefined
      ? 'needs-apply'
      : this.#publicIntentReconciliation(intent, request, target);
  }

  #publicIntentReconciliation(
    intent: ActualUpdatePublicIntent,
    request: TransactionCategoryUpdateRequest,
    target: TransactionCategorizationObservedRecord,
  ): TransactionCategoryUpdateReconciliation {
    const targetRef = this.#authenticator.createTargetRef({
      transactionId: target.transactionId,
      importedId: target.importedId,
    });
    if (!isMatchingPublicIntent(intent, request, targetRef, target)) {
      return 'conflict';
    }
    return activeIntentStatuses.has(intent.status)
      ? 'already-applied'
      : 'conflict';
  }

  async #prepare(
    request: TransactionCategoryUpdateRequest,
    target: TransactionCategorizationObservedRecord,
    signal?: AbortSignal,
  ): Promise<ActualPrepareCategorizationUpdateResult> {
    signal?.throwIfAborted();
    const result = parsePrepareCategorizationUpdateResult(
      await this.#actual.prepareCategorizationUpdate({
        accountAlias: request.accountAlias,
        transactionId: target.transactionId,
        importedId: target.importedId,
        date: target.observation.date,
        amountMinorUnits: target.observation.amountMinorUnits,
        expectedObservationFingerprint: request.observationFingerprint,
        categoryAliases: [request.categoryAlias],
      }),
    );
    signal?.throwIfAborted();
    if (
      result.observed.transactionId !== target.transactionId ||
      result.observed.importedId !== target.importedId ||
      result.observed.date !== target.observation.date ||
      result.observed.amountMinorUnits !==
        target.observation.amountMinorUnits ||
      result.categories.length !== 1 ||
      result.categories[0]?.alias !== request.categoryAlias
    ) {
      throw new ActualTransactionCategoryUpdateAdapterError(
        'preparation-invalid',
      );
    }
    return result;
  }

  #payload(
    request: TransactionCategoryUpdateRequest,
    prepared: PreparedUpdate,
  ): ActualUpdateInternalEnvelopePayloadV2 {
    const identity = transactionCategorizationIntentIdentity(request);
    const category = prepared.preparation.categories[0];
    if (category === undefined || category.alias !== request.categoryAlias) {
      throw new ActualTransactionCategoryUpdateAdapterError(
        'preparation-invalid',
      );
    }
    return {
      schemaVersion: 'actual-update-internal-payload.v2',
      publicProposal: {
        schemaVersion: 'actual-update-public-proposal.v2',
        intentId: identity.intentId,
        idempotencyKey: request.idempotencyKey,
        targetRef: this.#authenticator.createTargetRef({
          transactionId: prepared.target.transactionId,
          importedId: prepared.target.importedId,
        }),
        accountAlias: request.accountAlias,
        summary: {
          date: prepared.target.observation.date,
          amountMinorUnits: prepared.target.observation.amountMinorUnits,
          payeeName: prepared.target.observation.payeeName,
        },
        payee: { kind: 'preserve' },
        notes: { kind: 'preserve' },
        categorization: {
          kind: 'single',
          categoryAlias: request.categoryAlias,
        },
        sourceId: identity.sourceId,
        auditId: identity.auditId,
        createdAt: new Date(prepared.target.observedAt).toISOString(),
      },
      writerRequest: {
        idempotencyKey: request.idempotencyKey,
        observed: prepared.preparation.observed,
        edit: {
          payee: { kind: 'preserve' },
          notes: { kind: 'preserve' },
          categorization: {
            kind: 'single',
            categoryId: category.categoryId,
          },
        },
      },
    };
  }
}
