export interface ActualUpdateTransactionRecord {
  readonly id: string;
  readonly account: string;
  readonly date: string;
  readonly amount: number;
  readonly category?: string | null;
  readonly payee?: string | null;
  readonly notes?: string | null;
  readonly imported_id?: string | null;
  readonly imported_payee?: string | null;
  readonly cleared?: boolean | null;
  readonly reconciled?: boolean | null;
  readonly transfer_id?: string | null;
  readonly starting_balance_flag?: boolean | null;
  readonly sort_order?: number | null;
  readonly is_parent?: boolean | null;
  readonly is_child?: boolean | null;
  readonly parent_id?: string | null;
  readonly tombstone?: boolean | null;
  readonly error?: unknown;
  readonly subtransactions?: readonly ActualUpdateTransactionRecord[];
  readonly [field: string]: unknown;
}

export interface ActualUpdatePayeeRecord {
  readonly id: string;
  readonly transfer_acct?: string | null;
}

export interface ActualUpdateLedgerView {
  readonly transactions: readonly ActualUpdateTransactionRecord[];
  readonly payees: readonly ActualUpdatePayeeRecord[];
}

export interface ActualUpdateParentPatch {
  readonly id: string;
  readonly category?: string | null;
  readonly payee?: string | null;
  readonly notes?: string | null;
  readonly is_parent?: boolean;
  readonly error?: null;
}

export interface ActualUpdateChildInsert {
  readonly id: string;
  readonly account: string;
  readonly date: string;
  readonly amount: number;
  readonly category: string;
  readonly payee: string | null;
  readonly notes: string | null;
  readonly imported_id: null;
  readonly imported_payee: null;
  readonly cleared: boolean;
  readonly reconciled: boolean;
  readonly transfer_id: null;
  readonly starting_balance_flag: boolean;
  readonly sort_order: number;
  readonly is_parent: false;
  readonly is_child: true;
  readonly parent_id: string;
  readonly tombstone: false;
  readonly error: null;
  readonly schedule: null;
  readonly raw_synced_data: null;
  readonly [field: string]: unknown;
}

export interface ActualUpdateMutation {
  readonly kind: 'apply-single' | 'apply-split' | 'undo';
  readonly parentPatch: ActualUpdateParentPatch;
  readonly addedChildren: readonly ActualUpdateChildInsert[];
  readonly deletedChildIds: readonly string[];
  readonly expectedParentAmountMinorUnits: number;
}

/**
 * The writer deliberately depends on this narrow port rather than exposing the
 * model or workflow layer to an Actual client.
 */
export interface ActualExistingTransactionUpdatePort {
  readAccountDate(
    accountId: string,
    date: string,
  ): Promise<ActualUpdateLedgerView>;

  applyMutation(mutation: ActualUpdateMutation): Promise<void>;
}
