import { createHash } from 'node:crypto';

import type { ApprovalDecision } from '../approval/decision.js';
import type {
  ActualUpdateConversationalOrigin,
  ActualUpdateIntentStore,
  ActualUpdateOperationalStatus,
  ActualUpdatePublicIntent,
} from '../storage/actual-update-store.js';
import {
  actualUpdateTalkMessageSha256,
  type ActualUpdateTalkOutcomeStatus,
} from '../storage/actual-update-talk-store.js';
import type { ActualUpdateTalkStore } from '../storage/actual-update-talk-store.js';
import type {
  TalkBotClient,
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/client.js';
import type { ActualUpdateWorkflow } from './workflow.js';

function sha256(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
  }
  return hash.digest('hex');
}

function identifier(value: string, name: string): string {
  if (
    value.length < 1 ||
    value.length > 500 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function canonicalInstant(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError('Actual update Talk clock returned an invalid Date');
  }
  return value.toISOString();
}

function normalizedBackendUrl(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('Actual update Talk backend URL is invalid');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function categoryLines(intent: ActualUpdatePublicIntent): readonly string[] {
  const categorization = intent.proposal.categorization;
  if (categorization.kind === 'single') {
    return [`Category: ${friendlyLabel(categorization.categoryAlias)}`];
  }
  return [
    'Split between:',
    ...categorization.splits.map(
      (split) =>
        `- ${friendlyLabel(split.categoryAlias)}: ${money(split.amountMinorUnits)}`,
    ),
  ];
}

function friendlyLabel(value: string): string {
  const label = value.replaceAll(/[-_]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
  return label.length === 0
    ? 'Unknown'
    : `${label[0]!.toLocaleUpperCase('en-CA')}${label.slice(1)}`;
}

function money(valueMinorUnits: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
  }).format(Math.abs(valueMinorUnits) / 100);
}

function reviewSummaryLines(
  intent: ActualUpdatePublicIntent,
): readonly string[] {
  const summary = intent.proposal.summary;
  return [
    `Date: ${summary.date}`,
    `Merchant: ${summary.payeeName ?? 'Unknown'}`,
    `Amount: ${money(summary.amountMinorUnits)}`,
  ];
}

function editSummary(intent: ActualUpdatePublicIntent): readonly string[] {
  const proposal = intent.proposal;
  return [
    ...reviewSummaryLines(intent),
    `Account: ${friendlyLabel(proposal.accountAlias)}`,
    ...categoryLines(intent),
  ];
}

const APPROVAL_REPLY_INSTRUCTION =
  'Reply approve to make the change, or reject to leave it alone.';
const UNDO_REPLY_INSTRUCTION =
  "If it doesn't look right, reply undo and I'll restore the previous category.";

export function isActualUpdateApprovalPrompt(message: string): boolean {
  const normalized = message.normalize('NFC').trim();
  return (
    normalized.startsWith(
      "I'm ready to categorize this transaction in Actual:",
    ) && normalized.endsWith(APPROVAL_REPLY_INSTRUCTION)
  );
}

export function isActualUpdateUndoPrompt(message: string): boolean {
  return message.normalize('NFC').trim().endsWith(UNDO_REPLY_INSTRUCTION);
}

/**
 * Deliberately renders only the alias-based public proposal. Intent, source,
 * audit, Actual transaction/import/category/account IDs, and the opaque target
 * reference never enter Talk.
 */
export function renderActualUpdateApprovalMessage(
  intent: ActualUpdatePublicIntent,
): string {
  return [
    "I'm ready to categorize this transaction in Actual:",
    '',
    ...editSummary(intent),
    '',
    APPROVAL_REPLY_INSTRUCTION,
  ].join('\n');
}

export function renderActualUpdateOutcomeMessage(
  intent: ActualUpdatePublicIntent,
  outcomeStatus: ActualUpdateTalkOutcomeStatus,
): string {
  const heading =
    intent.status === 'ambiguous'
      ? "I couldn't verify whether this change reached Actual after retrying safely, so it needs review before any further change."
      : outcomeStatus === 'applied'
        ? 'Done — I updated this transaction in Actual.'
        : outcomeStatus === 'rejected'
          ? 'Okay — I left this transaction unchanged.'
          : "I couldn't confirm the change, so I left this transaction for review.";
  return [
    heading,
    '',
    ...editSummary(intent),
    ...(outcomeStatus === 'applied' ? ['', UNDO_REPLY_INSTRUCTION] : []),
  ].join('\n');
}

export function renderActualUpdateAutoOutcomeMessage(
  intent: ActualUpdatePublicIntent,
  outcomeStatus: Extract<ActualUpdateTalkOutcomeStatus, 'applied' | 'failed'>,
): string {
  const summary = intent.proposal.summary;
  const transaction = `${money(summary.amountMinorUnits)} transaction from ${summary.payeeName ?? 'an unknown payee'}`;
  if (intent.status === 'ambiguous') {
    return `I couldn't verify whether the ${transaction} was categorized in Actual after retrying safely, so it needs review before any further change.`;
  }
  if (outcomeStatus === 'failed') {
    return `I couldn't safely categorize the ${transaction}, so I left it for review.`;
  }
  const category = intent.proposal.categorization;
  const label =
    category.kind === 'single'
      ? friendlyLabel(category.categoryAlias)
      : 'the requested split';
  const verb =
    intent.applyOutcome?.status === 'already-applied' ? 'Confirmed' : 'Done';
  return `${verb} — I categorized the ${transaction} as ${label} in Actual.\n\n${UNDO_REPLY_INSTRUCTION}`;
}

export function renderActualUpdateProgressMessage(
  intent: ActualUpdatePublicIntent,
): string {
  const summary = intent.proposal.summary;
  return `I’m still safely applying the categorization for the ${money(summary.amountMinorUnits)} transaction from ${summary.payeeName ?? 'an unknown payee'}. I’ll confirm the result here.`;
}

export function actualUpdateTalkReferenceId(input: {
  readonly backendUrl: string;
  readonly roomToken: string;
  readonly proposalIdempotencyKey: string;
}): string {
  return sha256(
    'household-finance.actual-update-talk-reference.v1\0',
    normalizedBackendUrl(input.backendUrl),
    '\0',
    identifier(input.roomToken, 'roomToken'),
    '\0',
    identifier(input.proposalIdempotencyKey, 'proposalIdempotencyKey'),
  );
}

function deliveryIdempotencyKey(input: {
  readonly referenceId: string;
  readonly proposalIdempotencyKey: string;
}): string {
  return sha256(
    'household-finance.actual-update-talk-delivery.v1\0',
    input.referenceId,
    '\0',
    input.proposalIdempotencyKey,
  );
}

function progressDeliveryIdentity(intentId: string): {
  readonly referenceId: string;
  readonly idempotencyKey: string;
} {
  const referenceId = sha256(
    'household-finance.actual-update-talk-progress-reference.v1\0',
    intentId,
  );
  return {
    referenceId,
    idempotencyKey: sha256(
      'household-finance.actual-update-talk-progress-delivery.v1\0',
      referenceId,
      '\0',
      intentId,
    ),
  };
}

function outcomeDeliveryIdentity(input: {
  readonly backendUrl: string;
  readonly roomToken: string;
  readonly proposalIdempotencyKey: string;
  readonly outcomeStatus: ActualUpdateTalkOutcomeStatus;
}): { readonly referenceId: string; readonly idempotencyKey: string } {
  const referenceId = sha256(
    'household-finance.actual-update-talk-outcome-reference.v1\0',
    normalizedBackendUrl(input.backendUrl),
    '\0',
    identifier(input.roomToken, 'roomToken'),
    '\0',
    identifier(input.proposalIdempotencyKey, 'proposalIdempotencyKey'),
    '\0',
    input.outcomeStatus,
  );
  return {
    referenceId,
    idempotencyKey: sha256(
      'household-finance.actual-update-talk-outcome-delivery.v1\0',
      referenceId,
      '\0',
      input.proposalIdempotencyKey,
      '\0',
      input.outcomeStatus,
    ),
  };
}

export interface ActualUpdateTalkIntentSource {
  getPublicIntent(intentId: string): ActualUpdatePublicIntent | undefined;
  listPublicIntentsByStatus(
    status: ActualUpdateOperationalStatus,
    maximum?: number,
    order?: 'oldest' | 'newest',
    offset?: number,
  ): readonly ActualUpdatePublicIntent[];
  getConversationalOrigin?(
    intentId: string,
  ): ActualUpdateConversationalOrigin | undefined;
  isApplyReconciliationExhausted?(intentId: string): boolean;
}

type InteractionWorkflow = Pick<
  ActualUpdateWorkflow,
  'approve' | 'reject' | 'requestUndo'
>;

type ApprovalWorkflow = Pick<ActualUpdateWorkflow, 'approve'>;

export type ActualUpdateTalkWorkerStep =
  | {
      readonly intentId: string;
      readonly status: 'approval-delivered' | 'already-delivered';
      readonly referenceId: string;
    }
  | {
      readonly intentId: string;
      readonly status: 'auto-approved';
    }
  | {
      readonly intentId: string;
      readonly status:
        | 'outcome-delivered'
        | 'outcome-already-delivered'
        | 'outcome-delivery-deferred'
        | 'outcome-delivery-failed';
    }
  | {
      readonly intentId: string;
      readonly status:
        | 'progress-delivered'
        | 'progress-delivery-deferred'
        | 'progress-delivery-failed'
        | 'progress-suppressed';
    }
  | {
      readonly intentId: string;
      readonly status: 'delivery-deferred' | 'delivery-failed';
    };

export interface ActualUpdateTalkWorkerRun {
  readonly steps: readonly ActualUpdateTalkWorkerStep[];
}

export interface ActualUpdateTalkInteractionWorkerOptions {
  readonly store: ActualUpdateTalkStore;
  readonly intents: ActualUpdateTalkIntentSource;
  readonly workflow: ApprovalWorkflow;
  readonly talk: Pick<TalkBotClient, 'sendReplyWithIdentity'>;
  readonly backendUrl: string;
  readonly roomToken: string;
  readonly autoApprovalEnabled: boolean;
  readonly automationActorId?: string;
  readonly deliveryRetryDelayMs?: number;
  readonly now?: () => Date;
}

/**
 * Pollable worker: observes awaiting public intents and either sends one
 * idempotent Talk approval request or durably records an automatic approval.
 */
export class ActualUpdateTalkInteractionWorker {
  readonly #store: ActualUpdateTalkStore;
  readonly #intents: ActualUpdateTalkIntentSource;
  readonly #workflow: ApprovalWorkflow;
  readonly #talk: Pick<TalkBotClient, 'sendReplyWithIdentity'>;
  readonly #backendUrl: string;
  readonly #roomToken: string;
  readonly #autoApprovalEnabled: boolean;
  readonly #automationActorId: string;
  readonly #deliveryRetryDelayMs: number;
  readonly #now: () => Date;
  #running: Promise<ActualUpdateTalkWorkerRun> | undefined;

  constructor(options: ActualUpdateTalkInteractionWorkerOptions) {
    this.#store = options.store;
    this.#intents = options.intents;
    this.#workflow = options.workflow;
    this.#talk = options.talk;
    this.#backendUrl = normalizedBackendUrl(options.backendUrl);
    this.#roomToken = identifier(options.roomToken, 'roomToken');
    if (typeof options.autoApprovalEnabled !== 'boolean') {
      throw new TypeError('Actual update auto-approval flag must be boolean');
    }
    this.#autoApprovalEnabled = options.autoApprovalEnabled;
    this.#automationActorId = identifier(
      options.automationActorId ?? 'household-finance-automation',
      'automationActorId',
    );
    this.#deliveryRetryDelayMs = options.deliveryRetryDelayMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#deliveryRetryDelayMs) ||
      this.#deliveryRetryDelayMs < 1_000 ||
      this.#deliveryRetryDelayMs > 24 * 60 * 60_000
    ) {
      throw new RangeError(
        'Actual update Talk retry delay must be from 1 second to 1 day',
      );
    }
    this.#now = options.now ?? (() => new Date());
  }

  kick(maximum = 20): Promise<ActualUpdateTalkWorkerRun> {
    this.#running ??= this.reconcileAvailable(maximum).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async reconcileAvailable(maximum = 20): Promise<ActualUpdateTalkWorkerRun> {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1_000) {
      throw new RangeError('maximum must be from 0 to 1000');
    }
    const steps: ActualUpdateTalkWorkerStep[] =
      await this.#reconcileOutcomeDeliveries(maximum);
    steps.push(...(await this.#reconcileProgressDeliveries(maximum)));
    const intents = [
      ...this.#intents.listPublicIntentsByStatus('awaiting-approval', maximum),
    ].sort((left, right) => {
      const instantOrder = left.proposal.createdAt.localeCompare(
        right.proposal.createdAt,
      );
      return instantOrder === 0
        ? left.proposal.intentId.localeCompare(right.proposal.intentId)
        : instantOrder;
    });
    for (const intent of intents) {
      /*
       * Once an explicit request has been planned, keep that intent on the
       * explicit path. This avoids repurposing a delivery after an uncertain
       * Talk send and makes every auto-approved intent delivery-free until its
       * verified outcome is ready to report.
       */
      if (this.#store.getDelivery(intent.proposal.intentId) !== undefined) {
        steps.push(await this.#deliverApprovalRequest(intent));
        continue;
      }
      if (this.#autoApprovalEnabled) {
        const plan = this.#store.planAutoApproval({
          intentId: intent.proposal.intentId,
          actorId: this.#automationActorId,
          approvedAt: canonicalInstant(this.#now),
        });
        this.#workflow.approve({
          intentId: plan.intentId,
          decisionId: plan.decisionId,
          actorId: plan.actorId,
          approvedAt: plan.approvedAt,
        });
        const origin = this.#origin(intent.proposal.intentId);
        if (origin !== undefined) {
          const identity = progressDeliveryIdentity(intent.proposal.intentId);
          this.#store.planProgressDelivery({
            intentId: intent.proposal.intentId,
            deliveryIdempotencyKey: identity.idempotencyKey,
            roomToken: origin.roomToken,
            replyTo: origin.sourceMessageId,
            referenceId: identity.referenceId,
            message: renderActualUpdateProgressMessage(intent),
            createdAt: plan.approvedAt,
            availableAt: new Date(
              Date.parse(plan.approvedAt) + 5_000,
            ).toISOString(),
          });
        }
        steps.push({
          intentId: intent.proposal.intentId,
          status: 'auto-approved',
        });
        continue;
      }
      steps.push(await this.#deliverApprovalRequest(intent));
    }
    return { steps };
  }

  async #reconcileOutcomeDeliveries(
    maximum: number,
  ): Promise<ActualUpdateTalkWorkerStep[]> {
    const outcomeStatuses = [
      'applied',
      'rejected',
      'failed',
      'ambiguous',
    ] as const;
    const intents = outcomeStatuses
      .flatMap((status) => this.#outcomeCandidates(status, maximum))
      .sort((left, right) => {
        const instantOrder = left.updatedAt.localeCompare(right.updatedAt);
        return instantOrder === 0
          ? left.proposal.intentId.localeCompare(right.proposal.intentId)
          : instantOrder;
      })
      .slice(0, maximum);
    const steps: ActualUpdateTalkWorkerStep[] = [];
    for (const intent of intents) {
      if (this.#eligibleAutoOutcome(intent)) {
        steps.push(await this.#deliverAutoOutcome(intent));
        continue;
      }
      if (
        this.#store.getDelivery(intent.proposal.intentId)?.state !== 'delivered'
      ) {
        continue;
      }
      steps.push(await this.#deliverOutcome(intent));
    }
    return steps;
  }

  #outcomeCandidates(
    status: Extract<
      ActualUpdateOperationalStatus,
      'applied' | 'rejected' | 'failed' | 'ambiguous'
    >,
    maximum: number,
  ): ActualUpdatePublicIntent[] {
    const candidates: ActualUpdatePublicIntent[] = [];
    let offset = 0;
    const pageSize = 1_000;
    while (candidates.length < maximum) {
      const page = this.#intents.listPublicIntentsByStatus(
        status,
        pageSize,
        'newest',
        offset,
      );
      candidates.push(
        ...page
          .filter((intent) => this.#needsOutcomeDelivery(intent))
          .slice(0, maximum - candidates.length),
      );
      if (page.length < pageSize) {
        break;
      }
      offset += page.length;
    }
    return candidates;
  }

  #needsOutcomeDelivery(intent: ActualUpdatePublicIntent): boolean {
    if (this.#eligibleAutoOutcome(intent)) {
      return (
        this.#store.getDelivery(intent.proposal.intentId)?.state !== 'delivered'
      );
    }
    if (
      this.#store.getOutcomeDelivery(intent.proposal.intentId)?.state ===
      'delivered'
    ) {
      return false;
    }
    if (intent.status === 'ambiguous') {
      return (
        this.#origin(intent.proposal.intentId) !== undefined &&
        this.#intents.isApplyReconciliationExhausted?.(
          intent.proposal.intentId,
        ) === true &&
        this.#store.getDelivery(intent.proposal.intentId)?.state === 'delivered'
      );
    }
    return (
      this.#store.getDelivery(intent.proposal.intentId)?.state === 'delivered'
    );
  }

  #eligibleAutoOutcome(intent: ActualUpdatePublicIntent): boolean {
    if (
      intent.status !== 'applied' &&
      intent.status !== 'failed' &&
      !(
        intent.status === 'ambiguous' &&
        this.#origin(intent.proposal.intentId) !== undefined &&
        this.#intents.isApplyReconciliationExhausted?.(
          intent.proposal.intentId,
        ) === true
      )
    ) {
      return false;
    }
    if (
      intent.status === 'applied' &&
      intent.applyOutcome?.status !== 'updated' &&
      intent.applyOutcome?.status !== 'already-applied'
    ) {
      return false;
    }
    const autoApproval = this.#store.getAutoApproval(intent.proposal.intentId);
    const marker = this.#store.getAutoOutcomeStatus(intent.proposal.intentId);
    const delivery = this.#store.getDelivery(intent.proposal.intentId);
    return (
      autoApproval !== undefined &&
      (marker !== undefined || delivery === undefined)
    );
  }

  #origin(intentId: string): ActualUpdateConversationalOrigin | undefined {
    const origin = this.#intents.getConversationalOrigin?.(intentId);
    if (
      origin === undefined ||
      origin.backendUrl !== this.#backendUrl ||
      origin.roomToken !== this.#roomToken
    ) {
      return undefined;
    }
    return origin;
  }

  async #reconcileProgressDeliveries(
    maximum: number,
  ): Promise<ActualUpdateTalkWorkerStep[]> {
    const now = canonicalInstant(this.#now);
    const steps: ActualUpdateTalkWorkerStep[] = [];
    for (const intentId of this.#store.listDueProgressIntentIds(now, maximum)) {
      const intent = this.#intents.getPublicIntent(intentId);
      if (
        intent === undefined ||
        intent.status === 'applied' ||
        intent.status === 'failed' ||
        intent.status === 'rejected' ||
        (intent.status === 'ambiguous' &&
          this.#intents.isApplyReconciliationExhausted?.(intentId) === true)
      ) {
        this.#store.suppressProgressDelivery(intentId);
        steps.push({ intentId, status: 'progress-suppressed' });
        continue;
      }
      const claim = this.#store.claimProgressDelivery(intentId, now);
      if (claim === undefined) {
        steps.push({ intentId, status: 'progress-delivery-deferred' });
        continue;
      }
      try {
        const identity = await this.#talk.sendReplyWithIdentity({
          roomToken: claim.roomToken,
          message: claim.message,
          replyTo: claim.replyTo,
          referenceId: claim.referenceId,
        });
        this.#store.completeProgressDelivery(
          intentId,
          claim.leaseToken,
          identity,
          canonicalInstant(this.#now),
        );
        steps.push({ intentId, status: 'progress-delivered' });
      } catch {
        this.#store.retryProgressDelivery(
          intentId,
          claim.leaseToken,
          'talk-progress-delivery-failed',
          new Date(
            Date.parse(canonicalInstant(this.#now)) +
              this.#deliveryRetryDelayMs,
          ).toISOString(),
        );
        steps.push({ intentId, status: 'progress-delivery-failed' });
      }
    }
    return steps;
  }

  async #deliverApprovalRequest(
    intent: ActualUpdatePublicIntent,
  ): Promise<ActualUpdateTalkWorkerStep> {
    const intentId = intent.proposal.intentId;
    let delivery = this.#store.getDelivery(intentId);
    if (delivery === undefined) {
      const referenceId = actualUpdateTalkReferenceId({
        backendUrl: this.#backendUrl,
        roomToken: this.#roomToken,
        proposalIdempotencyKey: intent.proposal.idempotencyKey,
      });
      delivery = this.#store.planDelivery({
        intentId,
        deliveryIdempotencyKey: deliveryIdempotencyKey({
          referenceId,
          proposalIdempotencyKey: intent.proposal.idempotencyKey,
        }),
        backendUrl: this.#backendUrl,
        roomToken: this.#roomToken,
        referenceId,
        message: renderActualUpdateApprovalMessage(intent),
        createdAt: intent.proposal.createdAt,
      }).delivery;
    } else if (
      delivery.backendUrl !== this.#backendUrl ||
      delivery.roomToken !== this.#roomToken
    ) {
      throw new Error(
        'Persisted Actual update Talk delivery conflicts with runtime configuration',
      );
    }
    if (delivery.state === 'delivered') {
      return {
        intentId,
        status: 'already-delivered',
        referenceId: delivery.referenceId,
      };
    }
    const now = canonicalInstant(this.#now);
    const claim = this.#store.claimDelivery(intentId, now);
    if (claim === undefined) {
      return { intentId, status: 'delivery-deferred' };
    }
    try {
      const origin = this.#origin(intentId);
      const identity = await this.#talk.sendReplyWithIdentity({
        roomToken: claim.roomToken,
        message: claim.message,
        ...(origin === undefined ? {} : { replyTo: origin.sourceMessageId }),
        referenceId: claim.referenceId,
      });
      this.#store.completeDelivery(
        claim.intentId,
        claim.leaseToken,
        identity,
        canonicalInstant(this.#now),
      );
      return {
        intentId,
        status: 'approval-delivered',
        referenceId: claim.referenceId,
      };
    } catch {
      const retryAt = new Date(
        new Date(canonicalInstant(this.#now)).valueOf() +
          this.#deliveryRetryDelayMs,
      ).toISOString();
      this.#store.retryDelivery(
        claim.intentId,
        claim.leaseToken,
        'talk-delivery-failed',
        retryAt,
      );
      return { intentId, status: 'delivery-failed' };
    }
  }

  async #deliverAutoOutcome(
    intent: ActualUpdatePublicIntent,
  ): Promise<ActualUpdateTalkWorkerStep> {
    const outcomeStatus = intent.status;
    if (
      outcomeStatus !== 'applied' &&
      outcomeStatus !== 'failed' &&
      outcomeStatus !== 'ambiguous'
    ) {
      throw new Error('Standalone Actual update outcome is not terminal');
    }
    const deliveryOutcomeStatus =
      outcomeStatus === 'applied' ? 'applied' : 'failed';
    const intentId = intent.proposal.intentId;
    this.#store.suppressProgressDelivery(intentId);
    let delivery = this.#store.getDelivery(intentId);
    const marker = this.#store.getAutoOutcomeStatus(intentId);
    if (delivery === undefined || marker === undefined) {
      const referenceId = actualUpdateTalkReferenceId({
        backendUrl: this.#backendUrl,
        roomToken: this.#roomToken,
        proposalIdempotencyKey: intent.proposal.idempotencyKey,
      });
      delivery = this.#store.planAutoOutcomeDelivery({
        intentId,
        outcomeStatus: deliveryOutcomeStatus,
        deliveryIdempotencyKey: deliveryIdempotencyKey({
          referenceId,
          proposalIdempotencyKey: intent.proposal.idempotencyKey,
        }),
        backendUrl: this.#backendUrl,
        roomToken: this.#roomToken,
        referenceId,
        message: renderActualUpdateAutoOutcomeMessage(
          intent,
          deliveryOutcomeStatus,
        ),
        createdAt: intent.updatedAt,
      }).delivery;
    } else if (
      marker !== deliveryOutcomeStatus ||
      delivery.backendUrl !== this.#backendUrl ||
      delivery.roomToken !== this.#roomToken
    ) {
      throw new Error(
        'Persisted standalone Actual update outcome conflicts with terminal intent state',
      );
    }
    if (delivery.state === 'delivered') {
      return { intentId, status: 'outcome-already-delivered' };
    }
    const now = canonicalInstant(this.#now);
    const claim = this.#store.claimDelivery(intentId, now);
    if (claim === undefined) {
      return { intentId, status: 'outcome-delivery-deferred' };
    }
    try {
      const origin = this.#origin(intentId);
      const identity = await this.#talk.sendReplyWithIdentity({
        roomToken: claim.roomToken,
        message: claim.message,
        ...(origin === undefined ? {} : { replyTo: origin.sourceMessageId }),
        referenceId: claim.referenceId,
      });
      this.#store.completeDelivery(
        claim.intentId,
        claim.leaseToken,
        identity,
        canonicalInstant(this.#now),
      );
      return { intentId, status: 'outcome-delivered' };
    } catch {
      const retryAt = new Date(
        new Date(canonicalInstant(this.#now)).valueOf() +
          this.#deliveryRetryDelayMs,
      ).toISOString();
      this.#store.retryDelivery(
        claim.intentId,
        claim.leaseToken,
        'talk-outcome-delivery-failed',
        retryAt,
      );
      return { intentId, status: 'outcome-delivery-failed' };
    }
  }

  async #deliverOutcome(
    intent: ActualUpdatePublicIntent,
  ): Promise<ActualUpdateTalkWorkerStep> {
    const outcomeStatus = intent.status;
    if (
      outcomeStatus !== 'applied' &&
      outcomeStatus !== 'rejected' &&
      outcomeStatus !== 'failed' &&
      outcomeStatus !== 'ambiguous'
    ) {
      throw new Error('Actual update outcome delivery received a live intent');
    }
    const deliveryOutcomeStatus =
      outcomeStatus === 'ambiguous' ? 'failed' : outcomeStatus;
    const intentId = intent.proposal.intentId;
    let delivery = this.#store.getOutcomeDelivery(intentId);
    if (delivery === undefined) {
      const identity = outcomeDeliveryIdentity({
        backendUrl: this.#backendUrl,
        roomToken: this.#roomToken,
        proposalIdempotencyKey: intent.proposal.idempotencyKey,
        outcomeStatus: deliveryOutcomeStatus,
      });
      delivery = this.#store.planOutcomeDelivery({
        intentId,
        outcomeStatus: deliveryOutcomeStatus,
        deliveryIdempotencyKey: identity.idempotencyKey,
        referenceId: identity.referenceId,
        message: renderActualUpdateOutcomeMessage(
          intent,
          deliveryOutcomeStatus,
        ),
        createdAt: intent.updatedAt,
      }).delivery;
    } else if (delivery.outcomeStatus !== deliveryOutcomeStatus) {
      throw new Error(
        'Persisted Actual update Talk outcome conflicts with intent state',
      );
    }
    if (delivery.state === 'delivered') {
      return { intentId, status: 'outcome-already-delivered' };
    }
    const now = canonicalInstant(this.#now);
    const claim = this.#store.claimOutcomeDelivery(intentId, now);
    if (claim === undefined) {
      return { intentId, status: 'outcome-delivery-deferred' };
    }
    try {
      const identity = await this.#talk.sendReplyWithIdentity({
        roomToken: claim.roomToken,
        message: claim.message,
        replyTo: claim.replyTo,
        referenceId: claim.referenceId,
      });
      this.#store.completeOutcomeDelivery(
        claim.intentId,
        claim.leaseToken,
        identity,
        canonicalInstant(this.#now),
      );
      return { intentId, status: 'outcome-delivered' };
    } catch {
      const retryAt = new Date(
        new Date(canonicalInstant(this.#now)).valueOf() +
          this.#deliveryRetryDelayMs,
      ).toISOString();
      this.#store.retryOutcomeDelivery(
        claim.intentId,
        claim.leaseToken,
        'talk-outcome-delivery-failed',
        retryAt,
      );
      return { intentId, status: 'outcome-delivery-failed' };
    }
  }
}

export type ActualUpdateTalkDecisionErrorCode =
  | 'backend-mismatch'
  | 'approver-not-allowed'
  | 'parent-not-delivered'
  | 'parent-content-mismatch'
  | 'intent-not-found'
  | 'intent-delivery-mismatch';

export class ActualUpdateTalkDecisionError extends Error {
  constructor(readonly code: ActualUpdateTalkDecisionErrorCode) {
    super(`Actual update Talk decision stopped safely: ${code}`);
    this.name = 'ActualUpdateTalkDecisionError';
  }
}

export interface ActualUpdateUndoDecision {
  readonly kind: 'actual-update-undo-decision';
  readonly idempotencyKey: string;
  readonly backendUrl: string;
  readonly roomToken: string;
  readonly actorId: string;
  readonly inboundMessageId: string;
  readonly proposalBotId: string;
  readonly proposalMessageId: string;
  readonly proposalMessageText: string;
}

export function parseActualUpdateUndoDecisionText(
  message: string,
): 'undo' | undefined {
  return message.trim().toLowerCase() === 'undo' ? 'undo' : undefined;
}

export function createActualUpdateUndoDecision(
  input: Omit<ActualUpdateUndoDecision, 'kind' | 'idempotencyKey'>,
): ActualUpdateUndoDecision {
  return {
    kind: 'actual-update-undo-decision',
    idempotencyKey: sha256(
      'household-finance.actual-update-talk-undo.v1\0',
      input.backendUrl,
      '\0',
      input.roomToken,
      '\0',
      input.actorId,
      '\0',
      input.inboundMessageId,
      '\0',
      input.proposalBotId,
      '\0',
      input.proposalMessageId,
      '\0',
      input.proposalMessageText,
    ),
    ...input,
  };
}

export interface ActualUpdateTalkDecisionHandlerOptions {
  readonly store: ActualUpdateTalkStore;
  readonly intents: Pick<ActualUpdateIntentStore, 'getPublicIntent'>;
  readonly workflow: InteractionWorkflow;
  readonly expectedBackendUrl: string;
  readonly allowedApproverIds: ReadonlySet<string>;
  readonly now?: () => Date;
}

export type ActualUpdateTalkDecisionResult = ReturnType<
  InteractionWorkflow['approve']
>;

/**
 * Consumes only already-authenticated webhook events. Authority is derived
 * from the persisted outbound parent, never an intent ID supplied by Talk.
 */
export class ActualUpdateTalkDecisionHandler {
  readonly #store: ActualUpdateTalkStore;
  readonly #intents: Pick<ActualUpdateIntentStore, 'getPublicIntent'>;
  readonly #workflow: InteractionWorkflow;
  readonly #expectedBackendUrl: string;
  readonly #allowedApproverIds: ReadonlySet<string>;
  readonly #now: () => Date;

  constructor(options: ActualUpdateTalkDecisionHandlerOptions) {
    this.#store = options.store;
    this.#intents = options.intents;
    this.#workflow = options.workflow;
    this.#expectedBackendUrl = normalizedBackendUrl(options.expectedBackendUrl);
    this.#allowedApproverIds = new Set(
      [...options.allowedApproverIds].map((actorId) =>
        identifier(actorId, 'allowedApproverId'),
      ),
    );
    if (this.#allowedApproverIds.size === 0) {
      throw new TypeError('At least one Actual update approver is required');
    }
    this.#now = options.now ?? (() => new Date());
  }

  handleApproval(decision: ApprovalDecision): ActualUpdateTalkDecisionResult {
    const resolved = this.#resolveParent({
      idempotencyKey: decision.idempotencyKey,
      backendUrl: decision.backendUrl,
      roomToken: decision.roomToken,
      actorId: decision.approverId,
      proposalBotId: decision.proposalBotId,
      proposalMessageId: decision.proposalMessageId,
      proposalMessageText: decision.proposalMessageText,
      action: decision.decision,
    });
    if (decision.decision === 'approve') {
      return this.#workflow.approve({
        intentId: resolved.intent.proposal.intentId,
        decisionId: resolved.action.idempotencyKey,
        actorId: resolved.action.actorId,
        approvedAt: resolved.action.occurredAt,
      });
    }
    return this.#workflow.reject({
      intentId: resolved.intent.proposal.intentId,
      decisionId: resolved.action.idempotencyKey,
      actorId: resolved.action.actorId,
      reasonCode: 'talk-rejected',
      rejectedAt: resolved.action.occurredAt,
    });
  }

  handleUndo(
    decision: ActualUpdateUndoDecision,
  ): ReturnType<InteractionWorkflow['requestUndo']> {
    const resolved = this.#resolveParent({
      idempotencyKey: decision.idempotencyKey,
      backendUrl: decision.backendUrl,
      roomToken: decision.roomToken,
      actorId: decision.actorId,
      proposalBotId: decision.proposalBotId,
      proposalMessageId: decision.proposalMessageId,
      proposalMessageText: decision.proposalMessageText,
      action: 'undo',
    });
    return this.#workflow.requestUndo({
      intentId: resolved.intent.proposal.intentId,
      requestId: resolved.action.idempotencyKey,
      actorId: resolved.action.actorId,
      requestedAt: resolved.action.occurredAt,
    });
  }

  #resolveParent(input: {
    readonly idempotencyKey: string;
    readonly backendUrl: string;
    readonly roomToken: string;
    readonly actorId: string;
    readonly proposalBotId: string;
    readonly proposalMessageId: string;
    readonly proposalMessageText: string;
    readonly action: 'approve' | 'reject' | 'undo';
  }): {
    readonly intent: ActualUpdatePublicIntent;
    readonly action: ReturnType<
      ActualUpdateTalkStore['recordInboundAction']
    >['action'];
  } {
    if (normalizedBackendUrl(input.backendUrl) !== this.#expectedBackendUrl) {
      throw new ActualUpdateTalkDecisionError('backend-mismatch');
    }
    if (!this.#allowedApproverIds.has(input.actorId)) {
      throw new ActualUpdateTalkDecisionError('approver-not-allowed');
    }
    const parentIdentity = {
      roomToken: input.roomToken,
      botActorId: input.proposalBotId,
      botMessageId: input.proposalMessageId,
    };
    const proposalParent = this.#store.findDeliveredParent(parentIdentity);
    const autoOutcomeStatus =
      proposalParent === undefined
        ? undefined
        : this.#store.getAutoOutcomeStatus(proposalParent.intentId);
    const outcomeParent =
      proposalParent === undefined && input.action === 'undo'
        ? this.#store.findDeliveredOutcomeParent(parentIdentity)
        : undefined;
    if (
      autoOutcomeStatus !== undefined &&
      (input.action !== 'undo' || autoOutcomeStatus !== 'applied')
    ) {
      throw new ActualUpdateTalkDecisionError('parent-not-delivered');
    }
    if (
      proposalParent === undefined &&
      (outcomeParent === undefined || outcomeParent.outcomeStatus !== 'applied')
    ) {
      throw new ActualUpdateTalkDecisionError('parent-not-delivered');
    }
    const parentMessageSha256 = actualUpdateTalkMessageSha256(
      input.proposalMessageText,
    );
    const expectedMessageSha256 =
      proposalParent?.messageSha256 ?? outcomeParent!.messageSha256;
    if (expectedMessageSha256 !== parentMessageSha256) {
      throw new ActualUpdateTalkDecisionError('parent-content-mismatch');
    }
    const intentId = proposalParent?.intentId ?? outcomeParent!.intentId;
    const delivery = proposalParent ?? this.#store.getDelivery(intentId);
    if (delivery === undefined) {
      throw new ActualUpdateTalkDecisionError('parent-not-delivered');
    }
    const intent = this.#intents.getPublicIntent(intentId);
    if (intent === undefined) {
      throw new ActualUpdateTalkDecisionError('intent-not-found');
    }
    const expectedReferenceId = actualUpdateTalkReferenceId({
      backendUrl: delivery.backendUrl,
      roomToken: delivery.roomToken,
      proposalIdempotencyKey: intent.proposal.idempotencyKey,
    });
    if (expectedReferenceId !== delivery.referenceId) {
      throw new ActualUpdateTalkDecisionError('intent-delivery-mismatch');
    }
    const action = this.#store.recordInboundAction({
      idempotencyKey: input.idempotencyKey,
      intentId: delivery.intentId,
      action: input.action,
      actorId: input.actorId,
      roomToken: input.roomToken,
      botActorId: input.proposalBotId,
      botMessageId: input.proposalMessageId,
      parentMessageSha256,
      occurredAt: canonicalInstant(this.#now),
    }).action;
    return { intent, action };
  }
}

/**
 * Narrow structural adapter for an ActualUpdateIntentStore. Kept exported so
 * runtime wiring does not need a second persistence layer or raw SQL.
 */
export function actualUpdateTalkIntentSource(
  store: Pick<
    ActualUpdateIntentStore,
    'getPublicIntent' | 'listPublicIntentsByStatus'
  >,
): ActualUpdateTalkIntentSource {
  return store;
}

export type ActualUpdateTalkSender = (
  reply: TalkReply,
) => Promise<TalkDeliveredMessageIdentity>;
