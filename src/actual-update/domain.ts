import { createHash } from 'node:crypto';

import type { ActualUpdateTransactionRecord } from './port.js';

const sha256Pattern = /^[a-f0-9]{64}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const maximumTextLength = 32_000;

export type ActualUpdateEditableField<T> =
  { readonly kind: 'preserve' } | { readonly kind: 'set'; readonly value: T };

export interface ActualApprovedSingleCategorization {
  readonly kind: 'single';
  readonly categoryId: string;
}

export interface ActualApprovedSplitLine {
  readonly categoryId: string;
  readonly amountMinorUnits: number;
  readonly notes?: string | null;
}

export interface ActualApprovedSplitCategorization {
  readonly kind: 'split';
  readonly splits: readonly ActualApprovedSplitLine[];
}

export type ActualApprovedCategorization =
  ActualApprovedSingleCategorization | ActualApprovedSplitCategorization;

export interface ActualApprovedTransactionEdit {
  readonly payee: ActualUpdateEditableField<string | null>;
  readonly notes: ActualUpdateEditableField<string | null>;
  readonly categorization: ActualApprovedCategorization;
}

export interface ActualObservedSplitLine {
  readonly lineId: string;
  readonly categoryId: string | null;
  readonly amountMinorUnits: number;
  readonly payeeId: string | null;
  readonly notes: string | null;
}

export type ActualObservedCategorization =
  | {
      readonly kind: 'single';
      readonly categoryId: string | null;
    }
  | {
      readonly kind: 'split';
      readonly splits: readonly ActualObservedSplitLine[];
    };

export interface ActualObservedEditableState {
  readonly payeeId: string | null;
  readonly notes: string | null;
  readonly categorization: ActualObservedCategorization;
}

/**
 * A caller persists this value with the approved classification. The full
 * fingerprint is the optimistic version; the preserved fingerprint lets an
 * exact retry recognize the one allowed post-state without accepting drift in
 * account, amount, import identity, clear state, or any unrelated parent data.
 */
export interface ActualTransactionObservationV1 {
  readonly schemaVersion: 'actual-transaction-observation.v1';
  readonly transactionId: string;
  readonly accountId: string;
  readonly date: string;
  readonly amountMinorUnits: number;
  readonly importedId: string | null;
  readonly cleared: boolean;
  readonly reconciled: boolean;
  readonly transferId: string | null;
  readonly isParent: boolean;
  readonly isChild: boolean;
  readonly parentId: string | null;
  readonly tombstone: boolean;
  readonly fullFingerprint: string;
  readonly preservedFingerprint: string;
  readonly editable: ActualObservedEditableState;
  readonly observationFingerprint: string;
}

export interface ActualUpdateUndoIntentV1 {
  readonly schemaVersion: 'actual-update-undo.v1';
  readonly transactionId: string;
  readonly accountId: string;
  readonly date: string;
  readonly importedId: string;
  readonly idempotencyKeySha256: string;
  readonly original: ActualTransactionObservationV1;
  readonly expectedApplied: ActualTransactionObservationV1;
  readonly restore: ActualObservedEditableState;
  readonly createdAt: string;
}

export type ActualUpdateRefusalCode =
  | 'invalid-request'
  | 'target-not-found'
  | 'target-ambiguous'
  | 'target-changed'
  | 'target-account-not-safe'
  | 'target-non-imported'
  | 'target-transfer'
  | 'target-child'
  | 'target-deleted'
  | 'payee-not-safe'
  | 'unsupported-existing-split';

export class ActualUpdateRefusedError extends Error {
  constructor(
    readonly code: ActualUpdateRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActualUpdateRefusedError';
  }
}

export class ActualUpdateOutcomeUnknownError extends Error {
  constructor(
    readonly transactionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ActualUpdateOutcomeUnknownError';
  }
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          'Actual transaction data contains a non-finite number',
        );
      }
      return JSON.stringify(value);
    case 'undefined':
      return '{"$actualUndefined":true}';
    case 'object':
      break;
    default:
      throw new TypeError('Actual transaction data is not JSON-compatible');
  }

  if (ancestors.has(value)) {
    throw new TypeError('Actual transaction data contains a cycle');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => canonicalJson(item, ancestors))
        .join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        'Actual transaction data contains a non-plain object',
      );
    }
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

export function actualTransactionRecordFingerprint(
  transaction: ActualUpdateTransactionRecord,
): string {
  return fingerprint(transaction);
}

const editableParentFields = new Set([
  'category',
  'is_parent',
  'notes',
  'payee',
  'subtransactions',
]);

export function actualTransactionPreservedFingerprint(
  transaction: ActualUpdateTransactionRecord,
): string {
  return fingerprint(
    Object.fromEntries(
      Object.entries(transaction).filter(
        ([field]) => !editableParentFields.has(field),
      ),
    ),
  );
}

function assertText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 500 ||
    value !== value.trim() ||
    value.includes('\0')
  ) {
    throw new TypeError(`${field} must be a non-empty normalized identifier`);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.length > maximumTextLength ||
    value.includes('\0')
  ) {
    throw new TypeError(`${field} is not valid text`);
  }
  return value;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return assertText(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function assertSafeMinorUnits(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be safe integer minor units`);
  }
  return value;
}

function assertIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) {
    throw new TypeError(`${field} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${field} must be an ISO calendar date`);
  }
  return value;
}

function splitLines(
  transaction: ActualUpdateTransactionRecord,
): readonly ActualObservedSplitLine[] {
  return [...(transaction.subtransactions ?? [])]
    .map((line, index) => ({
      lineId: assertText(line.id, `subtransactions[${String(index)}].id`),
      categoryId: nullableIdentifier(
        line.category,
        `subtransactions[${String(index)}].category`,
      ),
      amountMinorUnits: assertSafeMinorUnits(
        line.amount,
        `subtransactions[${String(index)}].amount`,
      ),
      payeeId: nullableIdentifier(
        line.payee,
        `subtransactions[${String(index)}].payee`,
      ),
      notes: nullableText(
        line.notes,
        `subtransactions[${String(index)}].notes`,
      ),
    }))
    .sort((left, right) =>
      compareText(
        canonicalJson([
          left.categoryId,
          left.amountMinorUnits,
          left.notes,
          left.lineId,
        ]),
        canonicalJson([
          right.categoryId,
          right.amountMinorUnits,
          right.notes,
          right.lineId,
        ]),
      ),
    );
}

export function captureActualTransactionObservation(
  transaction: ActualUpdateTransactionRecord,
): ActualTransactionObservationV1 {
  const id = assertText(transaction.id, 'transaction.id');
  const account = assertText(transaction.account, 'transaction.account');
  const date = assertIsoDate(transaction.date, 'transaction.date');
  const amount = assertSafeMinorUnits(transaction.amount, 'transaction.amount');
  const isParent = booleanValue(transaction.is_parent, 'transaction.is_parent');
  const lines = splitLines(transaction);
  const categorization: ActualObservedCategorization =
    isParent || lines.length > 0
      ? { kind: 'split', splits: lines }
      : {
          kind: 'single',
          categoryId: nullableIdentifier(
            transaction.category,
            'transaction.category',
          ),
        };

  // Canonicalization is deliberately evaluated here so an unsupported raw
  // value cannot enter a durable optimistic-lock snapshot.
  const fullFingerprint = actualTransactionRecordFingerprint(transaction);
  const preservedFingerprint =
    actualTransactionPreservedFingerprint(transaction);
  const observation: Omit<
    ActualTransactionObservationV1,
    'observationFingerprint'
  > = {
    schemaVersion: 'actual-transaction-observation.v1',
    transactionId: id,
    accountId: account,
    date,
    amountMinorUnits: amount,
    importedId: nullableIdentifier(
      transaction.imported_id,
      'transaction.imported_id',
    ),
    cleared: booleanValue(transaction.cleared, 'transaction.cleared'),
    reconciled: booleanValue(transaction.reconciled, 'transaction.reconciled'),
    transferId: nullableIdentifier(
      transaction.transfer_id,
      'transaction.transfer_id',
    ),
    isParent,
    isChild: booleanValue(transaction.is_child, 'transaction.is_child'),
    parentId: nullableIdentifier(
      transaction.parent_id,
      'transaction.parent_id',
    ),
    tombstone: booleanValue(transaction.tombstone, 'transaction.tombstone'),
    fullFingerprint,
    preservedFingerprint,
    editable: {
      payeeId: nullableIdentifier(transaction.payee, 'transaction.payee'),
      notes: nullableText(transaction.notes, 'transaction.notes'),
      categorization,
    },
  };
  return {
    ...observation,
    observationFingerprint: fingerprint(observation),
  };
}

function assertObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActualUpdateRefusedError(
      'invalid-request',
      `${field} must be an object`,
    );
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ActualUpdateRefusedError(
      'invalid-request',
      `${field} contains an unapproved field`,
    );
  }
}

export function assertActualTransactionObservation(
  value: ActualTransactionObservationV1,
): void {
  try {
    assertObject(value, 'observation');
    assertExactKeys(
      value,
      [
        'schemaVersion',
        'transactionId',
        'accountId',
        'date',
        'amountMinorUnits',
        'importedId',
        'cleared',
        'reconciled',
        'transferId',
        'isParent',
        'isChild',
        'parentId',
        'tombstone',
        'fullFingerprint',
        'preservedFingerprint',
        'editable',
        'observationFingerprint',
      ],
      'observation',
    );
    if (value.schemaVersion !== 'actual-transaction-observation.v1') {
      throw new TypeError('observation schema version is unsupported');
    }
    assertText(value.transactionId, 'observation.transactionId');
    assertText(value.accountId, 'observation.accountId');
    assertIsoDate(value.date, 'observation.date');
    assertSafeMinorUnits(
      value.amountMinorUnits,
      'observation.amountMinorUnits',
    );
    nullableIdentifier(value.importedId, 'observation.importedId');
    nullableIdentifier(value.transferId, 'observation.transferId');
    nullableIdentifier(value.parentId, 'observation.parentId');
    if (
      typeof value.cleared !== 'boolean' ||
      typeof value.reconciled !== 'boolean' ||
      typeof value.isParent !== 'boolean' ||
      typeof value.isChild !== 'boolean' ||
      typeof value.tombstone !== 'boolean' ||
      !sha256Pattern.test(value.fullFingerprint) ||
      !sha256Pattern.test(value.preservedFingerprint) ||
      !sha256Pattern.test(value.observationFingerprint)
    ) {
      throw new TypeError('observation contains an invalid guard');
    }
    assertObservedEditableState(value.editable);
    const { observationFingerprint, ...observation } = value;
    if (fingerprint(observation) !== observationFingerprint) {
      throw new TypeError('observation fingerprint does not match its fields');
    }
  } catch (error) {
    if (error instanceof ActualUpdateRefusedError) {
      throw error;
    }
    throw new ActualUpdateRefusedError(
      'invalid-request',
      error instanceof Error ? error.message : 'observation is invalid',
    );
  }
}

function assertObservedEditableState(value: ActualObservedEditableState): void {
  assertObject(value, 'observation.editable');
  assertExactKeys(
    value,
    ['payeeId', 'notes', 'categorization'],
    'observation.editable',
  );
  nullableIdentifier(value.payeeId, 'observation.editable.payeeId');
  nullableText(value.notes, 'observation.editable.notes');
  assertObject(value.categorization, 'observation.editable.categorization');
  if (value.categorization.kind === 'single') {
    assertExactKeys(
      value.categorization,
      ['kind', 'categoryId'],
      'observation.editable.categorization',
    );
    nullableIdentifier(
      value.categorization.categoryId,
      'observation.editable.categorization.categoryId',
    );
    return;
  }
  if (value.categorization.kind !== 'split') {
    throw new TypeError('observation categorization kind is invalid');
  }
  assertExactKeys(
    value.categorization,
    ['kind', 'splits'],
    'observation.editable.categorization',
  );
  if (!Array.isArray(value.categorization.splits)) {
    throw new TypeError('observation split lines must be an array');
  }
  for (const [index, line] of value.categorization.splits.entries()) {
    assertObject(
      line,
      `observation.editable.categorization.splits[${String(index)}]`,
    );
    assertExactKeys(
      line,
      ['lineId', 'categoryId', 'amountMinorUnits', 'payeeId', 'notes'],
      `observation.editable.categorization.splits[${String(index)}]`,
    );
    assertText(
      line.lineId,
      `observation.editable.categorization.splits[${String(index)}].lineId`,
    );
    nullableIdentifier(
      line.categoryId,
      `observation.editable.categorization.splits[${String(index)}].categoryId`,
    );
    assertSafeMinorUnits(
      line.amountMinorUnits,
      `observation.editable.categorization.splits[${String(index)}].amountMinorUnits`,
    );
    nullableIdentifier(
      line.payeeId,
      `observation.editable.categorization.splits[${String(index)}].payeeId`,
    );
    nullableText(
      line.notes,
      `observation.editable.categorization.splits[${String(index)}].notes`,
    );
  }
}

function assertEditableField(
  value: unknown,
  field: string,
  validator: (candidate: unknown, candidateField: string) => unknown,
): void {
  assertObject(value, field);
  if (value.kind === 'preserve') {
    assertExactKeys(value, ['kind'], field);
    return;
  }
  if (value.kind === 'set') {
    assertExactKeys(value, ['kind', 'value'], field);
    validator(value.value, `${field}.value`);
    return;
  }
  throw new ActualUpdateRefusedError(
    'invalid-request',
    `${field}.kind is invalid`,
  );
}

export function assertApprovedActualTransactionEdit(
  value: ActualApprovedTransactionEdit,
  parentAmountMinorUnits: number,
  allowedCategoryIds: ReadonlySet<string>,
): void {
  try {
    assertObject(value, 'edit');
    assertExactKeys(value, ['payee', 'notes', 'categorization'], 'edit');
    assertEditableField(value.payee, 'edit.payee', nullableIdentifier);
    assertEditableField(value.notes, 'edit.notes', nullableText);
    assertObject(value.categorization, 'edit.categorization');
    if (value.categorization.kind === 'single') {
      assertExactKeys(
        value.categorization,
        ['kind', 'categoryId'],
        'edit.categorization',
      );
      const categoryId = assertText(
        value.categorization.categoryId,
        'edit.categorization.categoryId',
      );
      if (!allowedCategoryIds.has(categoryId)) {
        throw new TypeError('edit category is outside the allowlist');
      }
      return;
    }
    if (value.categorization.kind !== 'split') {
      throw new TypeError('edit categorization kind is invalid');
    }
    assertExactKeys(
      value.categorization,
      ['kind', 'splits'],
      'edit.categorization',
    );
    if (
      !Array.isArray(value.categorization.splits) ||
      value.categorization.splits.length < 2
    ) {
      throw new TypeError('split categorization requires at least two lines');
    }
    const seenCategories = new Set<string>();
    let total = 0n;
    const parentSign = Math.sign(parentAmountMinorUnits);
    if (parentSign === 0) {
      throw new TypeError('a zero-value transaction cannot be split');
    }
    for (const [index, candidate] of value.categorization.splits.entries()) {
      assertObject(candidate, `edit.categorization.splits[${String(index)}]`);
      assertExactKeys(
        candidate,
        ['categoryId', 'amountMinorUnits', 'notes'],
        `edit.categorization.splits[${String(index)}]`,
      );
      const categoryId = assertText(
        candidate.categoryId,
        `edit.categorization.splits[${String(index)}].categoryId`,
      );
      if (
        !allowedCategoryIds.has(categoryId) ||
        seenCategories.has(categoryId)
      ) {
        throw new TypeError(
          'split categories must be unique members of the allowlist',
        );
      }
      seenCategories.add(categoryId);
      const amount = assertSafeMinorUnits(
        candidate.amountMinorUnits,
        `edit.categorization.splits[${String(index)}].amountMinorUnits`,
      );
      if (amount === 0 || Math.sign(amount) !== parentSign) {
        throw new TypeError(
          'split amounts must be non-zero and have the parent sign',
        );
      }
      nullableText(
        candidate.notes,
        `edit.categorization.splits[${String(index)}].notes`,
      );
      total += BigInt(amount);
    }
    if (total !== BigInt(parentAmountMinorUnits)) {
      throw new TypeError('split minor units must sum exactly to the parent');
    }
  } catch (error) {
    if (error instanceof ActualUpdateRefusedError) {
      throw error;
    }
    throw new ActualUpdateRefusedError(
      'invalid-request',
      error instanceof Error ? error.message : 'approved edit is invalid',
    );
  }
}

export function deterministicActualSplitChildId(input: {
  readonly idempotencyKey: string;
  readonly transactionId: string;
  readonly categoryId: string;
  readonly amountMinorUnits: number;
  readonly index: number;
}): string {
  const hex = createHash('sha256')
    .update('actual-update-split-child-v1\0')
    .update(input.idempotencyKey)
    .update('\0')
    .update(input.transactionId)
    .update('\0')
    .update(input.categoryId)
    .update('\0')
    .update(String(input.amountMinorUnits))
    .update('\0')
    .update(String(input.index))
    .digest('hex')
    .slice(0, 32);
  // UUID-shaped IDs match Actual's own transaction identifiers. Version and
  // variant bits are fixed so the same approved request produces the same IDs.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(
    13,
    16,
  )}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createActualUpdateUndoIntent(input: {
  readonly idempotencyKey: string;
  readonly original: ActualTransactionObservationV1;
  readonly expectedApplied: ActualTransactionObservationV1;
  readonly createdAt: string;
}): ActualUpdateUndoIntentV1 {
  assertActualTransactionObservation(input.original);
  assertActualTransactionObservation(input.expectedApplied);
  if (input.original.importedId === null) {
    throw new TypeError(
      'Cannot create an undo intent for a non-imported target',
    );
  }
  if (
    input.expectedApplied.transactionId !== input.original.transactionId ||
    input.expectedApplied.accountId !== input.original.accountId ||
    input.expectedApplied.date !== input.original.date ||
    input.expectedApplied.amountMinorUnits !==
      input.original.amountMinorUnits ||
    input.expectedApplied.importedId !== input.original.importedId ||
    input.expectedApplied.cleared !== input.original.cleared ||
    input.expectedApplied.reconciled !== input.original.reconciled ||
    input.expectedApplied.transferId !== input.original.transferId ||
    input.expectedApplied.preservedFingerprint !==
      input.original.preservedFingerprint
  ) {
    throw new TypeError(
      'Undo intent states do not preserve the transaction identity and guards',
    );
  }
  if (
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey !== input.idempotencyKey.trim() ||
    input.idempotencyKey.includes('\0')
  ) {
    throw new TypeError('Undo intent idempotency key is invalid');
  }
  const createdAt = new Date(input.createdAt);
  if (
    Number.isNaN(createdAt.valueOf()) ||
    createdAt.toISOString() !== input.createdAt
  ) {
    throw new TypeError('Undo intent timestamp must be canonical ISO datetime');
  }
  const intent: ActualUpdateUndoIntentV1 = {
    schemaVersion: 'actual-update-undo.v1',
    transactionId: input.original.transactionId,
    accountId: input.original.accountId,
    date: input.original.date,
    importedId: input.original.importedId,
    idempotencyKeySha256: createHash('sha256')
      .update(input.idempotencyKey, 'utf8')
      .digest('hex'),
    original: structuredClone(input.original),
    expectedApplied: structuredClone(input.expectedApplied),
    restore: structuredClone(input.original.editable),
    createdAt: input.createdAt,
  };
  assertActualUpdateUndoIntent(intent);
  return intent;
}

export function assertActualUpdateUndoIntent(
  value: ActualUpdateUndoIntentV1,
): void {
  try {
    assertObject(value, 'undoIntent');
    assertExactKeys(
      value,
      [
        'schemaVersion',
        'transactionId',
        'accountId',
        'date',
        'importedId',
        'idempotencyKeySha256',
        'original',
        'expectedApplied',
        'restore',
        'createdAt',
      ],
      'undoIntent',
    );
    if (value.schemaVersion !== 'actual-update-undo.v1') {
      throw new TypeError('undo intent schema version is unsupported');
    }
    assertText(value.transactionId, 'undoIntent.transactionId');
    assertText(value.accountId, 'undoIntent.accountId');
    assertIsoDate(value.date, 'undoIntent.date');
    assertText(value.importedId, 'undoIntent.importedId');
    if (!sha256Pattern.test(value.idempotencyKeySha256)) {
      throw new TypeError('undo intent idempotency digest is invalid');
    }
    assertActualTransactionObservation(value.original);
    assertActualTransactionObservation(value.expectedApplied);
    assertObservedEditableState(value.restore);
    const createdAt = new Date(value.createdAt);
    if (
      Number.isNaN(createdAt.valueOf()) ||
      createdAt.toISOString() !== value.createdAt
    ) {
      throw new TypeError(
        'undo intent timestamp must be canonical ISO datetime',
      );
    }
    if (
      value.transactionId !== value.original.transactionId ||
      value.accountId !== value.original.accountId ||
      value.date !== value.original.date ||
      value.importedId !== value.original.importedId ||
      value.expectedApplied.transactionId !== value.original.transactionId ||
      value.expectedApplied.accountId !== value.original.accountId ||
      value.expectedApplied.date !== value.original.date ||
      value.expectedApplied.amountMinorUnits !==
        value.original.amountMinorUnits ||
      value.expectedApplied.importedId !== value.original.importedId ||
      value.expectedApplied.cleared !== value.original.cleared ||
      value.expectedApplied.reconciled !== value.original.reconciled ||
      value.expectedApplied.transferId !== value.original.transferId ||
      value.expectedApplied.preservedFingerprint !==
        value.original.preservedFingerprint ||
      JSON.stringify(value.restore) !== JSON.stringify(value.original.editable)
    ) {
      throw new TypeError(
        'undo intent does not preserve its exact original and applied guards',
      );
    }
  } catch (error) {
    if (error instanceof ActualUpdateRefusedError) {
      throw error;
    }
    throw new ActualUpdateRefusedError(
      'invalid-request',
      error instanceof Error ? error.message : 'undo intent is invalid',
    );
  }
}
