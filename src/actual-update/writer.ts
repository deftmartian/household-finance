import {
  ActualUpdateOutcomeUnknownError,
  ActualUpdateRefusedError,
  actualTransactionPreservedFingerprint,
  actualTransactionRecordFingerprint,
  assertActualTransactionObservation,
  assertActualUpdateUndoIntent,
  assertApprovedActualTransactionEdit,
  captureActualTransactionObservation,
  createActualUpdateUndoIntent,
  deterministicActualSplitChildId,
  type ActualApprovedSplitLine,
  type ActualApprovedTransactionEdit,
  type ActualTransactionObservationV1,
  type ActualUpdateUndoIntentV1,
} from './domain.js';
import type {
  ActualExistingTransactionUpdatePort,
  ActualUpdateChildInsert,
  ActualUpdateLedgerView,
  ActualUpdateMutation,
  ActualUpdateParentPatch,
  ActualUpdateTransactionRecord,
} from './port.js';

export interface UpdateExistingActualTransactionRequest {
  readonly idempotencyKey: string;
  readonly observed: ActualTransactionObservationV1;
  readonly edit: ActualApprovedTransactionEdit;
}

export type UpdateExistingActualTransactionResult =
  | {
      readonly status: 'unchanged';
      readonly applied: ActualTransactionObservationV1;
      readonly undoIntent: null;
    }
  | {
      readonly status: 'already-applied' | 'updated';
      readonly applied: ActualTransactionObservationV1;
      readonly undoIntent: ActualUpdateUndoIntentV1;
    };

export type UndoExistingActualTransactionResult = {
  readonly status: 'already-undone' | 'undone';
  readonly restored: ActualTransactionObservationV1;
};

export interface ActualExistingTransactionWriterOptions {
  readonly port: ActualExistingTransactionUpdatePort;
  readonly allowedAccountIds: readonly string[];
  readonly allowedCategoryIds: readonly string[];
  readonly allowedPayeeIds?: readonly string[];
  readonly now?: () => Date;
}

interface NormalizedDesiredEdit {
  readonly payeeId: string | null;
  readonly notes: string | null;
  readonly categorization:
    | { readonly kind: 'single'; readonly categoryId: string }
    | {
        readonly kind: 'split';
        readonly splits: readonly Required<ActualApprovedSplitLine>[];
      };
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function normalizedDesired(
  request: UpdateExistingActualTransactionRequest,
): NormalizedDesiredEdit {
  const observed = request.observed;
  const categorization =
    request.edit.categorization.kind === 'single'
      ? request.edit.categorization
      : {
          kind: 'split' as const,
          splits: request.edit.categorization.splits
            .map((split) => ({
              categoryId: split.categoryId,
              amountMinorUnits: split.amountMinorUnits,
              notes: split.notes ?? null,
            }))
            .sort((left, right) =>
              compareText(left.categoryId, right.categoryId),
            ),
        };
  return {
    payeeId:
      request.edit.payee.kind === 'preserve'
        ? observed.editable.payeeId
        : request.edit.payee.value,
    notes:
      request.edit.notes.kind === 'preserve'
        ? observed.editable.notes
        : request.edit.notes.value,
    categorization,
  };
}

function nullableString(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function bool(value: unknown): boolean {
  return value === true;
}

function assertRequestIdentity(
  transaction: ActualUpdateTransactionRecord,
  observed: ActualTransactionObservationV1,
): void {
  let current: ActualTransactionObservationV1;
  try {
    current = captureActualTransactionObservation(transaction);
  } catch (error) {
    throw new ActualUpdateRefusedError(
      'target-changed',
      error instanceof Error
        ? `The current transaction is invalid: ${error.message}`
        : 'The current transaction is invalid',
    );
  }
  if (
    current.transactionId !== observed.transactionId ||
    current.accountId !== observed.accountId ||
    current.date !== observed.date ||
    current.amountMinorUnits !== observed.amountMinorUnits ||
    current.importedId !== observed.importedId ||
    current.cleared !== observed.cleared ||
    current.reconciled !== observed.reconciled
  ) {
    throw new ActualUpdateRefusedError(
      'target-changed',
      'The target identity or protected ledger values changed',
    );
  }
  if (
    current.fullFingerprint === observed.fullFingerprint &&
    (current.transferId !== observed.transferId ||
      current.isParent !== observed.isParent ||
      current.isChild !== observed.isChild ||
      current.parentId !== observed.parentId ||
      current.tombstone !== observed.tombstone ||
      JSON.stringify(current.editable) !== JSON.stringify(observed.editable))
  ) {
    throw new ActualUpdateRefusedError(
      'target-changed',
      'The observed semantic snapshot does not match its raw transaction',
    );
  }
  if (current.importedId === null) {
    throw new ActualUpdateRefusedError(
      'target-non-imported',
      'The target is not an imported transaction',
    );
  }
  if (current.tombstone || transaction._deleted === true) {
    throw new ActualUpdateRefusedError(
      'target-deleted',
      'The target is deleted',
    );
  }
  if (current.isChild || current.parentId !== null) {
    throw new ActualUpdateRefusedError(
      'target-child',
      'The target is a split child rather than one imported parent',
    );
  }
  if (
    current.transferId !== null ||
    (transaction.subtransactions ?? []).some(
      (line) => nullableString(line.transfer_id) !== null,
    )
  ) {
    throw new ActualUpdateRefusedError(
      'target-transfer',
      'Transfers cannot be updated by the categorization writer',
    );
  }
}

function uniqueTarget(
  view: ActualUpdateLedgerView,
  observed: ActualTransactionObservationV1,
): ActualUpdateTransactionRecord {
  const matches = view.transactions.filter(
    (candidate) => candidate.id === observed.transactionId,
  );
  if (matches.length === 0) {
    throw new ActualUpdateRefusedError(
      'target-not-found',
      'The observed transaction no longer exists at its account and date',
    );
  }
  if (matches.length !== 1) {
    throw new ActualUpdateRefusedError(
      'target-ambiguous',
      'More than one transaction matched the observed identity',
    );
  }
  const target = matches[0];
  if (target === undefined) {
    throw new Error('Unique target invariant failed');
  }
  return target;
}

function assertSafePayee(
  payeeId: string | null,
  view: ActualUpdateLedgerView,
): void {
  if (payeeId === null) {
    return;
  }
  const matches = view.payees.filter((candidate) => candidate.id === payeeId);
  if (
    matches.length !== 1 ||
    nullableString(matches[0]?.transfer_acct) !== null
  ) {
    throw new ActualUpdateRefusedError(
      'payee-not-safe',
      'The payee is missing, ambiguous, or represents an Actual transfer',
    );
  }
}

function assertPayeeBoundary(
  transaction: ActualUpdateTransactionRecord,
  desired: NormalizedDesiredEdit,
  request: UpdateExistingActualTransactionRequest,
  view: ActualUpdateLedgerView,
  allowedPayeeIds: ReadonlySet<string>,
): void {
  if (
    request.edit.payee.kind === 'set' &&
    desired.payeeId !== null &&
    !allowedPayeeIds.has(desired.payeeId)
  ) {
    throw new ActualUpdateRefusedError(
      'payee-not-safe',
      'The requested payee is outside the configured allowlist',
    );
  }
  assertSafePayee(desired.payeeId, view);
  assertSafePayee(nullableString(transaction.payee), view);
  for (const line of transaction.subtransactions ?? []) {
    assertSafePayee(nullableString(line.payee), view);
  }
}

function recordMatchesDesired(
  transaction: ActualUpdateTransactionRecord,
  desired: NormalizedDesiredEdit,
): boolean {
  if (nullableString(transaction.notes) !== desired.notes) {
    return false;
  }
  if (desired.categorization.kind === 'single') {
    return (
      !bool(transaction.is_parent) &&
      (transaction.subtransactions?.length ?? 0) === 0 &&
      nullableString(transaction.category) ===
        desired.categorization.categoryId &&
      nullableString(transaction.payee) === desired.payeeId
    );
  }

  if (
    !bool(transaction.is_parent) ||
    nullableString(transaction.category) !== null ||
    nullableString(transaction.payee) !== null ||
    transaction.error !== null ||
    (transaction.subtransactions?.length ?? 0) !==
      desired.categorization.splits.length
  ) {
    return false;
  }
  const actualLines = [...(transaction.subtransactions ?? [])].sort(
    (left, right) =>
      compareText(
        nullableString(left.category) ?? '',
        nullableString(right.category) ?? '',
      ),
  );
  return desired.categorization.splits.every((expected, index) => {
    const actual = actualLines[index];
    return (
      actual !== undefined &&
      nullableString(actual.category) === expected.categoryId &&
      actual.amount === expected.amountMinorUnits &&
      nullableString(actual.payee) === desired.payeeId &&
      nullableString(actual.notes) === expected.notes &&
      bool(actual.is_child) &&
      nullableString(actual.parent_id) === transaction.id &&
      actual.account === transaction.account &&
      actual.date === transaction.date &&
      bool(actual.cleared) === bool(transaction.cleared) &&
      bool(actual.reconciled) === bool(transaction.reconciled) &&
      nullableString(actual.transfer_id) === null &&
      nullableString(actual.imported_id) === null &&
      !bool(actual.tombstone)
    );
  });
}

function preservedMatchesObservation(
  transaction: ActualUpdateTransactionRecord,
  observed: ActualTransactionObservationV1,
): boolean {
  return (
    actualTransactionPreservedFingerprint(transaction) ===
    observed.preservedFingerprint
  );
}

function fullMatchesObservation(
  transaction: ActualUpdateTransactionRecord,
  observed: ActualTransactionObservationV1,
): boolean {
  return (
    actualTransactionRecordFingerprint(transaction) ===
      observed.fullFingerprint &&
    preservedMatchesObservation(transaction, observed)
  );
}

function parentPatch(
  request: UpdateExistingActualTransactionRequest,
  transaction: ActualUpdateTransactionRecord,
  desired: NormalizedDesiredEdit,
): ActualUpdateParentPatch {
  if (desired.categorization.kind === 'split') {
    return {
      id: transaction.id,
      is_parent: true,
      category: null,
      payee: null,
      error: null,
      ...(request.edit.notes.kind === 'set' ? { notes: desired.notes } : {}),
    };
  }
  return {
    id: transaction.id,
    category: desired.categorization.categoryId,
    ...(request.edit.payee.kind === 'set' ? { payee: desired.payeeId } : {}),
    ...(request.edit.notes.kind === 'set' ? { notes: desired.notes } : {}),
  };
}

function splitChildren(
  request: UpdateExistingActualTransactionRequest,
  transaction: ActualUpdateTransactionRecord,
  desired: NormalizedDesiredEdit,
): readonly ActualUpdateChildInsert[] {
  if (desired.categorization.kind !== 'split') {
    return [];
  }
  return desired.categorization.splits.map((split, index) => ({
    id: deterministicActualSplitChildId({
      idempotencyKey: request.idempotencyKey,
      transactionId: transaction.id,
      categoryId: split.categoryId,
      amountMinorUnits: split.amountMinorUnits,
      index,
    }),
    account: transaction.account,
    date: transaction.date,
    amount: split.amountMinorUnits,
    category: split.categoryId,
    payee: desired.payeeId,
    notes: split.notes,
    imported_id: null,
    imported_payee: null,
    cleared: bool(transaction.cleared),
    reconciled: bool(transaction.reconciled),
    transfer_id: null,
    starting_balance_flag: bool(transaction.starting_balance_flag),
    sort_order: -(index + 1),
    is_parent: false,
    is_child: true,
    parent_id: transaction.id,
    tombstone: false,
    error: null,
    schedule: null,
    raw_synced_data: null,
  }));
}

function mutationFor(
  request: UpdateExistingActualTransactionRequest,
  transaction: ActualUpdateTransactionRecord,
  desired: NormalizedDesiredEdit,
): ActualUpdateMutation {
  const split = desired.categorization.kind === 'split';
  return {
    kind: split ? 'apply-split' : 'apply-single',
    parentPatch: parentPatch(request, transaction, desired),
    addedChildren: splitChildren(request, transaction, desired),
    deletedChildIds: [],
    expectedParentAmountMinorUnits: request.observed.amountMinorUnits,
  };
}

function undoMutationFor(
  intent: ActualUpdateUndoIntentV1,
): ActualUpdateMutation {
  if (intent.original.editable.categorization.kind !== 'single') {
    throw new ActualUpdateRefusedError(
      'unsupported-existing-split',
      'Undo can restore only the original ordinary imported transaction',
    );
  }
  const appliedCategorization = intent.expectedApplied.editable.categorization;
  const deletedChildIds =
    appliedCategorization.kind === 'split'
      ? appliedCategorization.splits.map((line) => line.lineId)
      : [];
  return {
    kind: 'undo',
    parentPatch: {
      id: intent.transactionId,
      category: intent.original.editable.categorization.categoryId,
      payee: intent.original.editable.payeeId,
      notes: intent.original.editable.notes,
      ...(deletedChildIds.length > 0
        ? { is_parent: false as const, error: null }
        : {}),
    },
    addedChildren: [],
    deletedChildIds,
    expectedParentAmountMinorUnits: intent.original.amountMinorUnits,
  };
}

function assertIdempotencyKey(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1_000 ||
    value !== value.trim() ||
    value.includes('\0')
  ) {
    throw new ActualUpdateRefusedError(
      'invalid-request',
      'The idempotency key is invalid',
    );
  }
}

export class ActualExistingTransactionWriter {
  readonly #port: ActualExistingTransactionUpdatePort;
  readonly #allowedAccountIds: ReadonlySet<string>;
  readonly #allowedCategoryIds: ReadonlySet<string>;
  readonly #allowedPayeeIds: ReadonlySet<string>;
  readonly #now: () => Date;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: ActualExistingTransactionWriterOptions) {
    if (options.allowedAccountIds.length === 0) {
      throw new TypeError('At least one Actual account must be allowed');
    }
    if (options.allowedCategoryIds.length === 0) {
      throw new TypeError('At least one Actual category must be allowed');
    }
    this.#port = options.port;
    this.#allowedAccountIds = new Set(options.allowedAccountIds);
    this.#allowedCategoryIds = new Set(options.allowedCategoryIds);
    this.#allowedPayeeIds = new Set(options.allowedPayeeIds ?? []);
    this.#now = options.now ?? (() => new Date());
  }

  update(
    request: UpdateExistingActualTransactionRequest,
  ): Promise<UpdateExistingActualTransactionResult> {
    let ownedRequest: UpdateExistingActualTransactionRequest;
    try {
      ownedRequest = structuredClone(request);
    } catch (error) {
      return Promise.reject(
        new ActualUpdateRefusedError(
          'invalid-request',
          error instanceof Error
            ? `The update request is not durable data: ${error.message}`
            : 'The update request is not durable data',
        ),
      );
    }
    const result = this.#operationTail.then(
      () => this.#update(ownedRequest),
      () => this.#update(ownedRequest),
    );
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  undo(
    intent: ActualUpdateUndoIntentV1,
  ): Promise<UndoExistingActualTransactionResult> {
    let ownedIntent: ActualUpdateUndoIntentV1;
    try {
      ownedIntent = structuredClone(intent);
    } catch (error) {
      return Promise.reject(
        new ActualUpdateRefusedError(
          'invalid-request',
          error instanceof Error
            ? `The undo intent is not durable data: ${error.message}`
            : 'The undo intent is not durable data',
        ),
      );
    }
    const result = this.#operationTail.then(
      () => this.#undo(ownedIntent),
      () => this.#undo(ownedIntent),
    );
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read(
    observed: ActualTransactionObservationV1,
  ): Promise<ActualUpdateLedgerView> {
    return this.#port.readAccountDate(observed.accountId, observed.date);
  }

  #undoIntent(
    request: UpdateExistingActualTransactionRequest,
    applied: ActualTransactionObservationV1,
    createdAt: string,
  ): ActualUpdateUndoIntentV1 {
    return createActualUpdateUndoIntent({
      idempotencyKey: request.idempotencyKey,
      original: request.observed,
      expectedApplied: applied,
      createdAt,
    });
  }

  #reconcileOrAssertObserved(input: {
    request: UpdateExistingActualTransactionRequest;
    desired: NormalizedDesiredEdit;
    view: ActualUpdateLedgerView;
  }):
    | {
        readonly state: 'observed';
        readonly transaction: ActualUpdateTransactionRecord;
      }
    | {
        readonly state: 'already-applied';
        readonly transaction: ActualUpdateTransactionRecord;
      }
    | {
        readonly state: 'unchanged';
        readonly transaction: ActualUpdateTransactionRecord;
      } {
    const transaction = uniqueTarget(input.view, input.request.observed);
    assertRequestIdentity(transaction, input.request.observed);
    assertPayeeBoundary(
      transaction,
      input.desired,
      input.request,
      input.view,
      this.#allowedPayeeIds,
    );
    const fullObserved = fullMatchesObservation(
      transaction,
      input.request.observed,
    );
    if (
      recordMatchesDesired(transaction, input.desired) &&
      preservedMatchesObservation(transaction, input.request.observed)
    ) {
      return {
        state: fullObserved ? 'unchanged' : 'already-applied',
        transaction,
      };
    }
    if (!fullObserved) {
      throw new ActualUpdateRefusedError(
        'target-changed',
        'The transaction changed after the approved observation',
      );
    }
    if (
      bool(transaction.is_parent) ||
      (transaction.subtransactions?.length ?? 0) > 0
    ) {
      throw new ActualUpdateRefusedError(
        'unsupported-existing-split',
        'Changing an existing non-matching split is not safely supported',
      );
    }
    return { state: 'observed', transaction };
  }

  async #update(
    request: UpdateExistingActualTransactionRequest,
  ): Promise<UpdateExistingActualTransactionResult> {
    assertIdempotencyKey(request.idempotencyKey);
    assertActualTransactionObservation(request.observed);
    if (!this.#allowedAccountIds.has(request.observed.accountId)) {
      throw new ActualUpdateRefusedError(
        'target-account-not-safe',
        'The target account is outside the configured production allowlist',
      );
    }
    if (request.observed.importedId === null) {
      throw new ActualUpdateRefusedError(
        'target-non-imported',
        'The approved observation is not an imported transaction',
      );
    }
    if (
      request.observed.transferId !== null ||
      request.observed.isChild ||
      request.observed.parentId !== null
    ) {
      throw new ActualUpdateRefusedError(
        request.observed.isChild || request.observed.parentId !== null
          ? 'target-child'
          : 'target-transfer',
        'The approved observation is outside the ordinary imported boundary',
      );
    }
    assertApprovedActualTransactionEdit(
      request.edit,
      request.observed.amountMinorUnits,
      this.#allowedCategoryIds,
    );
    let createdAt: string;
    try {
      createdAt = this.#now().toISOString();
    } catch (error) {
      throw new ActualUpdateRefusedError(
        'invalid-request',
        error instanceof Error
          ? `The update clock is invalid: ${error.message}`
          : 'The update clock is invalid',
      );
    }
    const desired = normalizedDesired(request);

    const first = this.#reconcileOrAssertObserved({
      request,
      desired,
      view: await this.#read(request.observed),
    });
    if (first.state !== 'observed') {
      const applied = captureActualTransactionObservation(first.transaction);
      return first.state === 'unchanged'
        ? { status: 'unchanged', applied, undoIntent: null }
        : {
            status: 'already-applied',
            applied,
            undoIntent: this.#undoIntent(request, applied, createdAt),
          };
    }

    // This second synchronized read is intentionally adjacent to the mutation.
    // It is the Actual API's available optimistic compare-and-set boundary.
    const prewrite = this.#reconcileOrAssertObserved({
      request,
      desired,
      view: await this.#read(request.observed),
    });
    if (prewrite.state !== 'observed') {
      const applied = captureActualTransactionObservation(prewrite.transaction);
      return prewrite.state === 'unchanged'
        ? { status: 'unchanged', applied, undoIntent: null }
        : {
            status: 'already-applied',
            applied,
            undoIntent: this.#undoIntent(request, applied, createdAt),
          };
    }

    try {
      await this.#port.applyMutation(
        mutationFor(request, prewrite.transaction, desired),
      );
    } catch (error) {
      throw new ActualUpdateOutcomeUnknownError(
        request.observed.transactionId,
        'The Actual update may have been applied; exact reconciliation is required',
        { cause: error },
      );
    }

    let verifiedView: ActualUpdateLedgerView;
    try {
      verifiedView = await this.#read(request.observed);
    } catch (error) {
      throw new ActualUpdateOutcomeUnknownError(
        request.observed.transactionId,
        'The Actual update completed without a readable verification state',
        { cause: error },
      );
    }
    let verified: ActualUpdateTransactionRecord;
    try {
      verified = uniqueTarget(verifiedView, request.observed);
      assertRequestIdentity(verified, request.observed);
      assertPayeeBoundary(
        verified,
        desired,
        request,
        verifiedView,
        this.#allowedPayeeIds,
      );
      if (
        !preservedMatchesObservation(verified, request.observed) ||
        !recordMatchesDesired(verified, desired)
      ) {
        throw new Error(
          'Actual readback does not equal the approved post-state',
        );
      }
    } catch (error) {
      throw new ActualUpdateOutcomeUnknownError(
        request.observed.transactionId,
        'The Actual update readback did not verify the exact approved post-state',
        { cause: error },
      );
    }
    const applied = captureActualTransactionObservation(verified);
    return {
      status: 'updated',
      applied,
      undoIntent: this.#undoIntent(request, applied, createdAt),
    };
  }

  #assertUndoIntent(intent: ActualUpdateUndoIntentV1): void {
    assertActualUpdateUndoIntent(intent);
    if (
      intent.schemaVersion !== 'actual-update-undo.v1' ||
      intent.transactionId !== intent.original.transactionId ||
      intent.accountId !== intent.original.accountId ||
      intent.date !== intent.original.date ||
      intent.importedId !== intent.original.importedId ||
      intent.importedId.length === 0 ||
      intent.restore.payeeId !== intent.original.editable.payeeId ||
      intent.restore.notes !== intent.original.editable.notes ||
      JSON.stringify(intent.restore.categorization) !==
        JSON.stringify(intent.original.editable.categorization) ||
      !/^[a-f0-9]{64}$/.test(intent.idempotencyKeySha256)
    ) {
      throw new ActualUpdateRefusedError(
        'invalid-request',
        'The undo intent does not match its original transaction guard',
      );
    }
    assertActualTransactionObservation(intent.original);
    assertActualTransactionObservation(intent.expectedApplied);
    if (
      intent.expectedApplied.transactionId !== intent.transactionId ||
      intent.expectedApplied.accountId !== intent.accountId ||
      intent.expectedApplied.date !== intent.date ||
      intent.expectedApplied.importedId !== intent.importedId ||
      intent.expectedApplied.amountMinorUnits !==
        intent.original.amountMinorUnits ||
      intent.expectedApplied.cleared !== intent.original.cleared ||
      intent.expectedApplied.reconciled !== intent.original.reconciled ||
      intent.expectedApplied.transferId !== intent.original.transferId ||
      intent.expectedApplied.preservedFingerprint !==
        intent.original.preservedFingerprint ||
      intent.original.editable.categorization.kind !== 'single'
    ) {
      throw new ActualUpdateRefusedError(
        'invalid-request',
        'The undo states do not preserve the original imported transaction',
      );
    }
    const createdAt = new Date(intent.createdAt);
    if (
      Number.isNaN(createdAt.valueOf()) ||
      createdAt.toISOString() !== intent.createdAt
    ) {
      throw new ActualUpdateRefusedError(
        'invalid-request',
        'The undo timestamp is invalid',
      );
    }
    if (intent.expectedApplied.editable.categorization.kind === 'split') {
      const ids = intent.expectedApplied.editable.categorization.splits.map(
        (line) => line.lineId,
      );
      if (ids.length < 2 || new Set(ids).size !== ids.length) {
        throw new ActualUpdateRefusedError(
          'invalid-request',
          'The undo split child guards are incomplete or ambiguous',
        );
      }
    }
  }

  #reconcileUndo(input: {
    intent: ActualUpdateUndoIntentV1;
    view: ActualUpdateLedgerView;
  }):
    | {
        readonly state: 'applied';
        readonly transaction: ActualUpdateTransactionRecord;
      }
    | {
        readonly state: 'restored';
        readonly transaction: ActualUpdateTransactionRecord;
      } {
    const transaction = uniqueTarget(input.view, input.intent.original);
    assertRequestIdentity(transaction, input.intent.original);
    assertSafePayee(nullableString(transaction.payee), input.view);
    assertSafePayee(input.intent.original.editable.payeeId, input.view);
    for (const line of transaction.subtransactions ?? []) {
      assertSafePayee(nullableString(line.payee), input.view);
    }
    if (fullMatchesObservation(transaction, input.intent.original)) {
      return { state: 'restored', transaction };
    }
    if (!fullMatchesObservation(transaction, input.intent.expectedApplied)) {
      throw new ActualUpdateRefusedError(
        'target-changed',
        'The transaction changed after the applied update; undo was refused',
      );
    }
    return { state: 'applied', transaction };
  }

  async #undo(
    intent: ActualUpdateUndoIntentV1,
  ): Promise<UndoExistingActualTransactionResult> {
    this.#assertUndoIntent(intent);
    if (!this.#allowedAccountIds.has(intent.original.accountId)) {
      throw new ActualUpdateRefusedError(
        'target-account-not-safe',
        'The undo target account is outside the configured production allowlist',
      );
    }
    const first = this.#reconcileUndo({
      intent,
      view: await this.#read(intent.original),
    });
    if (first.state === 'restored') {
      return {
        status: 'already-undone',
        restored: captureActualTransactionObservation(first.transaction),
      };
    }
    const prewrite = this.#reconcileUndo({
      intent,
      view: await this.#read(intent.original),
    });
    if (prewrite.state === 'restored') {
      return {
        status: 'already-undone',
        restored: captureActualTransactionObservation(prewrite.transaction),
      };
    }
    try {
      await this.#port.applyMutation(undoMutationFor(intent));
    } catch (error) {
      throw new ActualUpdateOutcomeUnknownError(
        intent.transactionId,
        'The Actual undo may have been applied; exact reconciliation is required',
        { cause: error },
      );
    }
    let view: ActualUpdateLedgerView;
    try {
      view = await this.#read(intent.original);
    } catch (error) {
      throw new ActualUpdateOutcomeUnknownError(
        intent.transactionId,
        'The Actual undo completed without a readable verification state',
        { cause: error },
      );
    }
    let restored: ActualUpdateTransactionRecord;
    try {
      const reconciled = this.#reconcileUndo({ intent, view });
      if (reconciled.state !== 'restored') {
        throw new Error('The Exact original state was not restored');
      }
      restored = reconciled.transaction;
    } catch (error) {
      throw new ActualUpdateOutcomeUnknownError(
        intent.transactionId,
        'The Actual undo readback did not verify the exact original state',
        { cause: error },
      );
    }
    return {
      status: 'undone',
      restored: captureActualTransactionObservation(restored),
    };
  }
}
