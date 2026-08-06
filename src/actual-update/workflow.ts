import { createHmac, timingSafeEqual, type BinaryLike } from 'node:crypto';

import {
  ActualUpdateOutcomeUnknownError,
  ActualUpdateRefusedError,
  type ActualUpdateUndoIntentV1,
} from './domain.js';
import type {
  UndoExistingActualTransactionResult,
  UpdateExistingActualTransactionRequest,
  UpdateExistingActualTransactionResult,
} from './writer.js';
import {
  ActualUpdateLeaseError,
  type ActualUpdateApprovalInput,
  type ActualUpdateApplyClaim,
  type ActualUpdateInternalEnvelopePayloadV2,
  type ActualUpdateIntentStore,
  type ActualUpdateLeaseRecoveryResult,
  type ActualUpdatePublicIntent,
  type ActualUpdateRejectionInput,
  type ActualUpdateUndoClaim,
  type ActualUpdateUndoRequestInput,
  parseActualUpdateInternalPayload,
  parseSealedActualUpdateEnvelope,
  type SealedActualUpdateIntentEnvelopeV2,
} from '../storage/actual-update-store.js';

const hmacDomain = 'household-finance.actual-update-envelope.v2\0';
const targetRefDomain = 'household-finance.actual-update-target-ref.v1\0';

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
          'Authenticated update data contains a non-finite number',
        );
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError('Authenticated update data is not JSON-compatible');
  }
  if (ancestors.has(value)) {
    throw new TypeError('Authenticated update data contains a cycle');
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
        'Authenticated update data contains a non-plain object',
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

function keyMaterial(value: string | Uint8Array, keyId: string): Buffer {
  const key =
    typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (key.byteLength < 32) {
    key.fill(0);
    throw new TypeError(
      `Actual update authentication key ${keyId} must contain at least 32 bytes`,
    );
  }
  return key;
}

function sign(
  key: BinaryLike,
  value: Omit<SealedActualUpdateIntentEnvelopeV2, 'signatureSha256'>,
): string {
  return createHmac('sha256', key)
    .update(hmacDomain, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function targetRefWithKey(
  key: BinaryLike,
  transactionId: string,
  importedId: string,
): string {
  const digest = createHmac('sha256', key)
    .update(targetRefDomain, 'utf8')
    .update(transactionId, 'utf8')
    .update('\0', 'utf8')
    .update(importedId, 'utf8')
    .digest('hex');
  return `actual-target/${digest}`;
}

function currentInstant(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(
      'Actual update workflow clock returned an invalid Date',
    );
  }
  return value.toISOString();
}

export class ActualUpdateEnvelopeAuthenticationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ActualUpdateEnvelopeAuthenticationError';
  }
}

export interface ActualUpdateEnvelopeAuthenticatorOptions {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string | Uint8Array>>;
  /**
   * Stable across signing-key rotations. This keeps opaque target handles
   * deterministic while old signing keys remain verification-only.
   */
  readonly targetReferenceKey: string | Uint8Array;
}

/**
 * Internal trust boundary between deterministic matching/approval and the
 * ledger writer. The model never receives these keys or envelopes.
 */
export class ActualUpdateEnvelopeAuthenticator {
  readonly #activeKeyId: string;
  readonly #keys = new Map<string, Buffer>();
  readonly #targetReferenceKey: Buffer;
  #destroyed = false;

  constructor(options: ActualUpdateEnvelopeAuthenticatorOptions) {
    if (
      options.activeKeyId.length === 0 ||
      options.activeKeyId !== options.activeKeyId.trim() ||
      options.activeKeyId.includes('\0')
    ) {
      throw new TypeError('Active Actual update key ID is invalid');
    }
    const targetReferenceKey = keyMaterial(
      options.targetReferenceKey,
      'target-reference',
    );
    try {
      for (const [keyId, value] of Object.entries(options.keys)) {
        if (
          keyId.length === 0 ||
          keyId !== keyId.trim() ||
          keyId.includes('\0')
        ) {
          throw new TypeError('Actual update key ID is invalid');
        }
        this.#keys.set(keyId, keyMaterial(value, keyId));
      }
      if (!this.#keys.has(options.activeKeyId)) {
        throw new TypeError('Active Actual update key is not configured');
      }
    } catch (error) {
      targetReferenceKey.fill(0);
      for (const key of this.#keys.values()) {
        key.fill(0);
      }
      this.#keys.clear();
      throw error;
    }
    this.#targetReferenceKey = targetReferenceKey;
    this.#activeKeyId = options.activeKeyId;
  }

  seal(
    payloadInput: ActualUpdateInternalEnvelopePayloadV2,
  ): SealedActualUpdateIntentEnvelopeV2 {
    this.#assertAvailable();
    const payload = parseActualUpdateInternalPayload(payloadInput);
    const unsigned = {
      schemaVersion: 'actual-update-envelope.v2' as const,
      keyId: this.#activeKeyId,
      payload,
    };
    const key = this.#keys.get(this.#activeKeyId);
    if (key === undefined) {
      throw new Error('Active Actual update signing key disappeared');
    }
    const observed = payload.writerRequest.observed;
    if (
      observed.importedId === null ||
      payload.publicProposal.targetRef !==
        targetRefWithKey(
          this.#targetReferenceKey,
          observed.transactionId,
          observed.importedId,
        )
    ) {
      throw new TypeError(
        'Opaque Actual target reference does not match the internal selection',
      );
    }
    return {
      ...structuredClone(unsigned),
      signatureSha256: sign(key, unsigned),
    };
  }

  verify(
    envelopeInput: SealedActualUpdateIntentEnvelopeV2,
  ): ActualUpdateInternalEnvelopePayloadV2 {
    try {
      this.#assertAvailable();
      const envelope = parseSealedActualUpdateEnvelope(envelopeInput);
      const key = this.#keys.get(envelope.keyId);
      if (key === undefined) {
        throw new Error('Envelope key is unknown or retired');
      }
      const expected = Buffer.from(
        sign(key, {
          schemaVersion: envelope.schemaVersion,
          keyId: envelope.keyId,
          payload: envelope.payload,
        }),
        'hex',
      );
      const actual = Buffer.from(envelope.signatureSha256, 'hex');
      if (
        actual.byteLength !== expected.byteLength ||
        !timingSafeEqual(actual, expected)
      ) {
        throw new Error('Envelope signature does not match its payload');
      }
      const observed = envelope.payload.writerRequest.observed;
      if (
        observed.importedId === null ||
        envelope.payload.publicProposal.targetRef !==
          targetRefWithKey(
            this.#targetReferenceKey,
            observed.transactionId,
            observed.importedId,
          )
      ) {
        throw new Error(
          'Envelope target reference does not match its internal selection',
        );
      }
      return structuredClone(envelope.payload);
    } catch (error) {
      if (error instanceof ActualUpdateEnvelopeAuthenticationError) {
        throw error;
      }
      throw new ActualUpdateEnvelopeAuthenticationError(
        'Actual update envelope authentication failed',
        { cause: error },
      );
    }
  }

  /**
   * Generates the only target handle safe to expose in Talk. HMAC rather than
   * a plain hash prevents enumeration when an Actual ID is guessed.
   */
  createTargetRef(input: {
    readonly transactionId: string;
    readonly importedId: string;
  }): string {
    this.#assertAvailable();
    if (
      input.transactionId.length === 0 ||
      input.importedId.length === 0 ||
      input.transactionId.includes('\0') ||
      input.importedId.includes('\0')
    ) {
      throw new TypeError('Actual target identity is invalid');
    }
    return targetRefWithKey(
      this.#targetReferenceKey,
      input.transactionId,
      input.importedId,
    );
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#targetReferenceKey.fill(0);
    for (const key of this.#keys.values()) {
      key.fill(0);
    }
    this.#keys.clear();
  }

  #assertAvailable(): void {
    if (this.#destroyed) {
      throw new Error('Actual update authenticator has been destroyed');
    }
  }
}

/**
 * The workflow can execute only through this narrow, CAS/idempotency-enforcing
 * boundary. ActualExistingTransactionWriter is the production implementation.
 */
export interface SafeActualUpdateWriter {
  update(
    request: UpdateExistingActualTransactionRequest,
  ): Promise<UpdateExistingActualTransactionResult>;
  undo(
    intent: ActualUpdateUndoIntentV1,
  ): Promise<UndoExistingActualTransactionResult>;
}

export type ActualUpdateWorkflowStepResult =
  | { readonly status: 'none'; readonly operation: 'apply' | 'undo' }
  | {
      readonly status: 'applied';
      readonly operation: 'apply';
      readonly intentId: string;
      readonly resultStatus: UpdateExistingActualTransactionResult['status'];
      readonly reconciliation: boolean;
    }
  | {
      readonly status: 'undone';
      readonly operation: 'undo';
      readonly intentId: string;
      readonly resultStatus: UndoExistingActualTransactionResult['status'];
      readonly reconciliation: boolean;
    }
  | {
      readonly status: 'ambiguous' | 'failed';
      readonly operation: 'apply' | 'undo';
      readonly intentId: string;
      readonly errorCode: string;
    };

export interface ActualUpdateReconciliationRunResult {
  readonly recovered: ActualUpdateLeaseRecoveryResult;
  readonly processed: readonly ActualUpdateWorkflowStepResult[];
}

export interface ActualUpdateWorkflowOptions {
  readonly store: ActualUpdateIntentStore;
  readonly writer: SafeActualUpdateWriter;
  readonly authenticator: ActualUpdateEnvelopeAuthenticator;
  readonly now?: () => Date;
}

export class ActualUpdateWorkflow {
  readonly #store: ActualUpdateIntentStore;
  readonly #writer: SafeActualUpdateWriter;
  readonly #authenticator: ActualUpdateEnvelopeAuthenticator;
  readonly #now: () => Date;

  constructor(options: ActualUpdateWorkflowOptions) {
    this.#store = options.store;
    this.#writer = options.writer;
    this.#authenticator = options.authenticator;
    this.#now = options.now ?? (() => new Date());
  }

  enqueue(payload: ActualUpdateInternalEnvelopePayloadV2): {
    readonly inserted: boolean;
    readonly intent: ActualUpdatePublicIntent;
  } {
    return this.#store.createSealedIntent(this.#authenticator.seal(payload));
  }

  approve(input: ActualUpdateApprovalInput): {
    readonly outcome: 'recorded' | 'duplicate';
    readonly intent: ActualUpdatePublicIntent;
  } {
    return this.#store.approve(input);
  }

  reject(input: ActualUpdateRejectionInput): {
    readonly outcome: 'recorded' | 'duplicate';
    readonly intent: ActualUpdatePublicIntent;
  } {
    return this.#store.reject(input);
  }

  requestUndo(input: ActualUpdateUndoRequestInput): {
    readonly outcome: 'recorded' | 'duplicate';
    readonly intent: ActualUpdatePublicIntent;
  } {
    return this.#store.requestUndo(input);
  }

  processNextApply(): Promise<ActualUpdateWorkflowStepResult> {
    const claim = this.#store.claimNextApply(currentInstant(this.#now));
    if (claim === undefined) {
      return Promise.resolve({ status: 'none', operation: 'apply' });
    }
    return this.#processApplyClaim(claim);
  }

  processNextUndo(): Promise<ActualUpdateWorkflowStepResult> {
    const claim = this.#store.claimNextUndo(currentInstant(this.#now));
    if (claim === undefined) {
      return Promise.resolve({ status: 'none', operation: 'undo' });
    }
    return this.#processUndoClaim(claim);
  }

  /**
   * Restarts expired work, then consumes due initial and ambiguous jobs.
   * Outcome-unknown retries re-enter only the SafeActualUpdateWriter, whose
   * exact snapshot/CAS checks distinguish original, applied, and drifted
   * states before any retry write.
   */
  async reconcileAvailable(
    maximumOperations = 20,
  ): Promise<ActualUpdateReconciliationRunResult> {
    if (
      !Number.isSafeInteger(maximumOperations) ||
      maximumOperations < 0 ||
      maximumOperations > 1_000
    ) {
      throw new RangeError('maximumOperations must be from 0 to 1000');
    }
    const recovered = this.#store.recoverExpiredLeases(
      currentInstant(this.#now),
    );
    const processed: ActualUpdateWorkflowStepResult[] = [];
    while (processed.length < maximumOperations) {
      const apply = await this.processNextApply();
      if (apply.status !== 'none') {
        processed.push(apply);
      }
      if (processed.length >= maximumOperations) {
        break;
      }
      const undo = await this.processNextUndo();
      if (undo.status !== 'none') {
        processed.push(undo);
      }
      if (apply.status === 'none' && undo.status === 'none') {
        break;
      }
    }
    return { recovered, processed };
  }

  #verifyApplyClaim(
    claim: Pick<
      ActualUpdateApplyClaim,
      | 'intentId'
      | 'targetRef'
      | 'targetTransactionId'
      | 'targetImportedId'
      | 'expectedFingerprint'
      | 'envelope'
    >,
  ): ActualUpdateInternalEnvelopePayloadV2 {
    const payload = this.#authenticator.verify(claim.envelope);
    const proposal = payload.publicProposal;
    const observed = payload.writerRequest.observed;
    if (
      proposal.intentId !== claim.intentId ||
      proposal.targetRef !== claim.targetRef ||
      proposal.idempotencyKey !== payload.writerRequest.idempotencyKey ||
      observed.transactionId !== claim.targetTransactionId ||
      observed.importedId !== claim.targetImportedId ||
      observed.fullFingerprint !== claim.expectedFingerprint
    ) {
      throw new ActualUpdateEnvelopeAuthenticationError(
        'Signed update envelope does not match its durable target guards',
      );
    }
    return payload;
  }

  #verifyUndoClaim(
    claim: ActualUpdateUndoClaim,
  ): ActualUpdateInternalEnvelopePayloadV2 {
    const payload = this.#verifyApplyClaim(claim);
    if (
      claim.undoIntent.transactionId !== claim.targetTransactionId ||
      claim.undoIntent.importedId !== claim.targetImportedId ||
      claim.undoIntent.original.fullFingerprint !== claim.expectedFingerprint
    ) {
      throw new ActualUpdateEnvelopeAuthenticationError(
        'Durable undo intent does not match the authenticated original target',
      );
    }
    return payload;
  }

  async #processApplyClaim(
    claim: ActualUpdateApplyClaim,
  ): Promise<ActualUpdateWorkflowStepResult> {
    let applying = false;
    try {
      const payload = this.#verifyApplyClaim(claim);
      this.#store.markApplyApplying(
        claim.intentId,
        claim.leaseToken,
        currentInstant(this.#now),
      );
      applying = true;
      const result = await this.#writer.update(payload.writerRequest);
      this.#store.completeApply(
        claim.intentId,
        claim.leaseToken,
        result,
        currentInstant(this.#now),
      );
      return {
        status: 'applied',
        operation: 'apply',
        intentId: claim.intentId,
        resultStatus: result.status,
        reconciliation: claim.mode === 'reconcile',
      };
    } catch (error) {
      if (error instanceof ActualUpdateLeaseError) {
        throw error;
      }
      if (!applying) {
        this.#store.failApply(
          claim.intentId,
          claim.leaseToken,
          'invalid-authenticated-envelope',
          currentInstant(this.#now),
        );
        return {
          status: 'failed',
          operation: 'apply',
          intentId: claim.intentId,
          errorCode: 'invalid-authenticated-envelope',
        };
      }
      if (error instanceof ActualUpdateRefusedError) {
        const code = `actual-${error.code}`;
        this.#store.failApply(
          claim.intentId,
          claim.leaseToken,
          code,
          currentInstant(this.#now),
        );
        return {
          status: 'failed',
          operation: 'apply',
          intentId: claim.intentId,
          errorCode: code,
        };
      }
      const code =
        error instanceof ActualUpdateOutcomeUnknownError
          ? 'actual-outcome-unknown'
          : 'writer-outcome-unknown';
      this.#store.markApplyAmbiguous(
        claim.intentId,
        claim.leaseToken,
        code,
        currentInstant(this.#now),
      );
      return {
        status: 'ambiguous',
        operation: 'apply',
        intentId: claim.intentId,
        errorCode: code,
      };
    }
  }

  async #processUndoClaim(
    claim: ActualUpdateUndoClaim,
  ): Promise<ActualUpdateWorkflowStepResult> {
    let applying = false;
    try {
      this.#verifyUndoClaim(claim);
      this.#store.markUndoApplying(
        claim.intentId,
        claim.leaseToken,
        currentInstant(this.#now),
      );
      applying = true;
      const result = await this.#writer.undo(claim.undoIntent);
      this.#store.completeUndo(
        claim.intentId,
        claim.leaseToken,
        result,
        currentInstant(this.#now),
      );
      return {
        status: 'undone',
        operation: 'undo',
        intentId: claim.intentId,
        resultStatus: result.status,
        reconciliation: claim.mode === 'undo-reconcile',
      };
    } catch (error) {
      if (error instanceof ActualUpdateLeaseError) {
        throw error;
      }
      if (!applying) {
        this.#store.failUndo(
          claim.intentId,
          claim.leaseToken,
          'invalid-authenticated-envelope',
          currentInstant(this.#now),
        );
        return {
          status: 'failed',
          operation: 'undo',
          intentId: claim.intentId,
          errorCode: 'invalid-authenticated-envelope',
        };
      }
      if (error instanceof ActualUpdateRefusedError) {
        const code = `actual-${error.code}`;
        this.#store.failUndo(
          claim.intentId,
          claim.leaseToken,
          code,
          currentInstant(this.#now),
        );
        return {
          status: 'failed',
          operation: 'undo',
          intentId: claim.intentId,
          errorCode: code,
        };
      }
      const code =
        error instanceof ActualUpdateOutcomeUnknownError
          ? 'actual-undo-outcome-unknown'
          : 'undo-writer-outcome-unknown';
      this.#store.markUndoAmbiguous(
        claim.intentId,
        claim.leaseToken,
        code,
        currentInstant(this.#now),
      );
      return {
        status: 'ambiguous',
        operation: 'undo',
        intentId: claim.intentId,
        errorCode: code,
      };
    }
  }
}

/**
 * Explicit scheduler-facing name for the durable reconciler.
 */
export class ActualUpdateReconciler {
  constructor(private readonly workflow: ActualUpdateWorkflow) {}

  run(maximumOperations = 20): Promise<ActualUpdateReconciliationRunResult> {
    return this.workflow.reconcileAvailable(maximumOperations);
  }
}
