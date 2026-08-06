import type {
  ActualExistingTransactionUpdatePort,
  ActualUpdateLedgerView,
  ActualUpdateMutation,
  ActualUpdatePayeeRecord,
  ActualUpdateTransactionRecord,
} from './port.js';

export interface ActualUpdateApiFacade {
  sync(): Promise<unknown>;
  getTransactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<readonly ActualUpdateTransactionRecord[]>;
  getPayees(): Promise<readonly ActualUpdatePayeeRecord[]>;
}

export interface ActualUpdateCoreClient {
  send(
    name: 'transactions-batch-update',
    input: {
      readonly added: readonly Record<string, unknown>[];
      readonly updated: readonly Record<string, unknown>[];
      readonly deleted: readonly { readonly id: string }[];
      readonly learnCategories: false;
      readonly runTransfers: false;
    },
  ): Promise<unknown>;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const maximumTextLength = 32_000;
const parentPatchFields = new Set([
  'id',
  'category',
  'payee',
  'notes',
  'is_parent',
  'error',
]);
const childFields = new Set([
  'id',
  'account',
  'date',
  'amount',
  'category',
  'payee',
  'notes',
  'imported_id',
  'imported_payee',
  'cleared',
  'reconciled',
  'transfer_id',
  'starting_balance_flag',
  'sort_order',
  'is_parent',
  'is_child',
  'parent_id',
  'tombstone',
  'error',
  'schedule',
  'raw_synced_data',
]);

function hasOnlyFields(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 500 &&
    value === value.trim() &&
    !value.includes('\0')
  );
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isNullableText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length <= maximumTextLength &&
      !value.includes('\0'))
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function assertSafeMutation(mutation: ActualUpdateMutation): void {
  const {
    kind,
    parentPatch,
    addedChildren,
    deletedChildIds,
    expectedParentAmountMinorUnits,
  } = mutation;
  if (
    !hasOnlyFields(parentPatch, parentPatchFields) ||
    !isIdentifier(parentPatch.id) ||
    !Number.isSafeInteger(expectedParentAmountMinorUnits) ||
    ('category' in parentPatch &&
      !isNullableIdentifier(parentPatch.category)) ||
    ('payee' in parentPatch && !isNullableIdentifier(parentPatch.payee)) ||
    ('notes' in parentPatch && !isNullableText(parentPatch.notes)) ||
    ('is_parent' in parentPatch &&
      typeof parentPatch.is_parent !== 'boolean') ||
    ('error' in parentPatch && parentPatch.error !== null)
  ) {
    throw new TypeError('Actual update mutation contains an unapproved field');
  }
  if (
    addedChildren.some(
      (child) =>
        !hasOnlyFields(child, childFields) ||
        !isIdentifier(child.id) ||
        child.parent_id !== parentPatch.id ||
        !isIdentifier(child.account) ||
        !isIsoDate(child.date) ||
        !isIdentifier(child.category) ||
        !isNullableIdentifier(child.payee) ||
        !isNullableText(child.notes) ||
        child.transfer_id !== null ||
        child.is_child !== true ||
        child.is_parent !== false ||
        child.imported_id !== null ||
        child.imported_payee !== null ||
        typeof child.cleared !== 'boolean' ||
        typeof child.reconciled !== 'boolean' ||
        typeof child.starting_balance_flag !== 'boolean' ||
        !Number.isSafeInteger(child.sort_order) ||
        child.tombstone !== false ||
        child.error !== null ||
        child.schedule !== null ||
        child.raw_synced_data !== null ||
        !Number.isSafeInteger(child.amount),
    )
  ) {
    throw new TypeError('Actual split child is outside the allowed shape');
  }
  if (
    new Set(addedChildren.map((child) => child.id)).size !==
    addedChildren.length
  ) {
    throw new TypeError('Actual split child IDs must be unique');
  }
  if (
    deletedChildIds.some((id) => !isIdentifier(id)) ||
    new Set(deletedChildIds).size !== deletedChildIds.length ||
    deletedChildIds.includes(parentPatch.id) ||
    addedChildren.some((child) => deletedChildIds.includes(child.id))
  ) {
    throw new TypeError('Actual deleted child IDs are invalid or ambiguous');
  }
  if (kind === 'apply-single') {
    if (
      addedChildren.length !== 0 ||
      deletedChildIds.length !== 0 ||
      !isIdentifier(parentPatch.category) ||
      'is_parent' in parentPatch ||
      'error' in parentPatch
    ) {
      throw new TypeError(
        'A non-split Actual update must set one allowed category only',
      );
    }
    return;
  }
  if (kind === 'undo') {
    if (
      addedChildren.length !== 0 ||
      !('category' in parentPatch) ||
      !('payee' in parentPatch) ||
      !('notes' in parentPatch) ||
      (deletedChildIds.length === 0 &&
        ('is_parent' in parentPatch || 'error' in parentPatch)) ||
      (deletedChildIds.length > 0 &&
        (deletedChildIds.length < 2 ||
          parentPatch.is_parent !== false ||
          parentPatch.error !== null))
    ) {
      throw new TypeError('Actual undo mutation is incomplete');
    }
    return;
  }
  if (kind !== 'apply-split' || deletedChildIds.length !== 0) {
    throw new TypeError('Actual update mutation kind is invalid');
  }
  const parentSign = Math.sign(expectedParentAmountMinorUnits);
  if (
    addedChildren.length < 2 ||
    parentSign === 0 ||
    parentPatch.is_parent !== true ||
    parentPatch.category !== null ||
    parentPatch.payee !== null ||
    parentPatch.error !== null ||
    new Set(addedChildren.map((child) => child.category)).size !==
      addedChildren.length ||
    addedChildren.some(
      (child) => child.amount === 0 || Math.sign(child.amount) !== parentSign,
    ) ||
    addedChildren.reduce((total, child) => total + BigInt(child.amount), 0n) !==
      BigInt(expectedParentAmountMinorUnits)
  ) {
    throw new TypeError('Actual split mutation is incomplete or unbalanced');
  }
}

/**
 * This adapter requires the client returned by `@actual-app/api.init()`.
 *
 * In @actual-app/api 26.7.0 the public `updateTransaction()` worker handler
 * starts `transactions-batch-update` without awaiting it. Using the typed core
 * client here is deliberate: `send('transactions-batch-update', ...)` is
 * awaited, supports one parent-plus-children mutation, and can therefore be
 * followed by an exact readback. Do not replace this with the public helper
 * without first verifying that version's runtime implementation.
 */
export class ActualApiExistingTransactionUpdatePort implements ActualExistingTransactionUpdatePort {
  constructor(
    private readonly api: ActualUpdateApiFacade,
    private readonly client: ActualUpdateCoreClient,
  ) {}

  async readAccountDate(
    accountId: string,
    date: string,
  ): Promise<ActualUpdateLedgerView> {
    await this.api.sync();
    const [transactions, payees] = await Promise.all([
      this.api.getTransactions(accountId, date, date),
      this.api.getPayees(),
    ]);
    return { transactions, payees };
  }

  async applyMutation(mutation: ActualUpdateMutation): Promise<void> {
    assertSafeMutation(mutation);
    const result = await this.client.send('transactions-batch-update', {
      added: mutation.addedChildren.map((child) => ({ ...child })),
      updated: [{ ...mutation.parentPatch }],
      deleted: mutation.deletedChildIds.map((id) => ({ id })),
      learnCategories: false,
      // The target and both payees were already proven non-transfer. Disabling
      // transfer post-processing prevents this classification-only mutation
      // from creating, deleting, or rewriting a linked transaction.
      runTransfers: false,
    });
    if (
      result === null ||
      typeof result !== 'object' ||
      !Array.isArray((result as { readonly errors?: unknown }).errors) ||
      (result as { readonly errors: readonly unknown[] }).errors.length !== 0
    ) {
      throw new Error(
        'Actual core batch update returned an error or an unknown result shape',
      );
    }
    await this.api.sync();
  }
}
