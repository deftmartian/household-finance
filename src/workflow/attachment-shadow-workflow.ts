import { z } from 'zod';

import {
  createAttachmentTalkReplyReferenceId,
  createReceiptDocumentIdempotencyKey,
} from '../domain/idempotency.js';
import { ReceiptDocumentPreparationError } from '../documents/document-preparation-error.js';
import { RemoteReceiptDocumentPreparationError } from '../documents/remote-receipt-document-preparer.js';
import {
  receiptModelProposalV1Schema,
  XaiResponsesAdapterError,
  type PreparedReceiptDocument,
  type ReceiptModelAdapter,
} from '../model/index.js';
import {
  type PreserveBinaryOriginalInput,
  type PreservedOriginal,
  type RetrievedNextcloudFile,
  WebDavFileSourceError,
} from '../nextcloud/index.js';
import {
  type AttachmentDeliveryPayload,
  type AttachmentInboundEvent,
  type AttachmentOutboxJob,
  type AttachmentShadowStore,
} from '../storage/index.js';
import type {
  TalkAttachmentReference,
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/index.js';
const replyPayloadSchema = z.strictObject({
  roomToken: z.string().min(1),
  message: z.string().min(1).max(32_000),
  replyTo: z.string().regex(/^\d+$/),
  referenceId: z.string().regex(/^[a-f0-9]{64}$/),
  silent: z.boolean(),
});
const deliveryPayloadSchema: z.ZodType<AttachmentDeliveryPayload> =
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('conversation-handoff'),
      fallbackReply: replyPayloadSchema,
    }),
    z.strictObject({
      type: z.literal('talk-reply'),
      reply: replyPayloadSchema,
    }),
  ]);

export interface AttachmentFileSource {
  retrieve(
    reference: TalkAttachmentReference,
    signal?: AbortSignal,
  ): Promise<RetrievedNextcloudFile>;
}

export interface BinaryOriginalArchive {
  preserveBinaryOriginal(
    input: PreserveBinaryOriginalInput,
    signal?: AbortSignal,
  ): Promise<PreservedOriginal>;
}

export interface AttachmentDocumentPreparer {
  prepare(
    source: RetrievedNextcloudFile,
    signal?: AbortSignal,
  ): Promise<PreparedReceiptDocument>;
}

export interface AttachmentTalkReplySender {
  sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity>;
}

export interface AttachmentConversationSink {
  enqueueCompletedAttachment(event: AttachmentInboundEvent): Promise<void>;
}

export interface AttachmentShadowWorkflowOptions {
  store: AttachmentShadowStore;
  source: AttachmentFileSource;
  archive: BinaryOriginalArchive;
  preparer: AttachmentDocumentPreparer;
  model: ReceiptModelAdapter;
  talk: AttachmentTalkReplySender;
  conversation: AttachmentConversationSink;
  signal?: AbortSignal;
  now?: () => Date;
}

class TerminalAttachmentShadowError extends Error {
  constructor(readonly code: string) {
    super(`Attachment shadow processing stopped: ${code}`);
    this.name = 'TerminalAttachmentShadowError';
  }
}

class AttachmentShadowShutdownError extends Error {
  constructor() {
    super('Attachment shadow processing paused for shutdown');
    this.name = 'AttachmentShadowShutdownError';
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AttachmentShadowShutdownError) {
    return 'shutdown-requested';
  }
  if (error instanceof TerminalAttachmentShadowError) {
    return error.code;
  }
  if (error instanceof WebDavFileSourceError) {
    return `nextcloud-${error.code}`;
  }
  if (error instanceof ReceiptDocumentPreparationError) {
    return `document-${error.code}`;
  }
  if (error instanceof RemoteReceiptDocumentPreparationError) {
    return `document-remote-${error.code}`;
  }
  if (error instanceof XaiResponsesAdapterError) {
    return `model-${error.code}`;
  }
  return 'attachment-processing-error';
}

function isTerminalError(error: unknown): boolean {
  if (error instanceof AttachmentShadowShutdownError) {
    return false;
  }
  if (error instanceof RemoteReceiptDocumentPreparationError) {
    return !error.retryable;
  }
  if (
    error instanceof TerminalAttachmentShadowError ||
    error instanceof ReceiptDocumentPreparationError ||
    error instanceof XaiResponsesAdapterError
  ) {
    return true;
  }
  return (
    error instanceof WebDavFileSourceError &&
    error.code !== 'search-failed' &&
    error.code !== 'download-failed' &&
    error.code !== 'file-not-found'
  );
}

function wipeDocument(document: PreparedReceiptDocument | undefined): void {
  if (document === undefined) {
    return;
  }
  for (const page of document.pages) {
    page.bytes.fill(0);
  }
}

function failedReply(event: AttachmentInboundEvent, code: string): TalkReply {
  const message =
    code === 'nextcloud-ambiguous-file'
      ? 'I found more than one attached file. Please send one receipt at a time.'
      : code.startsWith('nextcloud-')
        ? "I couldn't open that attachment. Please send it again."
        : code.startsWith('document-')
          ? "I couldn't read that file. Please send a clear JPEG, PNG, or PDF."
          : "I couldn't finish reading that receipt right now. I didn't change the budget; please try again in a few minutes.";
  return {
    roomToken: event.roomToken,
    message,
    replyTo: event.messageId,
    referenceId: createAttachmentTalkReplyReferenceId(
      event.idempotencyKey,
      'shadow-failed',
    ),
    silent: false,
  };
}

export class AttachmentShadowWorkflow {
  readonly #store: AttachmentShadowStore;
  readonly #source: AttachmentFileSource;
  readonly #archive: BinaryOriginalArchive;
  readonly #preparer: AttachmentDocumentPreparer;
  readonly #model: ReceiptModelAdapter;
  readonly #talk: AttachmentTalkReplySender;
  readonly #conversation: AttachmentConversationSink;
  readonly #signal: AbortSignal | undefined;
  readonly #now: () => Date;

  constructor(options: AttachmentShadowWorkflowOptions) {
    this.#store = options.store;
    this.#source = options.source;
    this.#archive = options.archive;
    this.#preparer = options.preparer;
    this.#model = options.model;
    this.#talk = options.talk;
    this.#conversation = options.conversation;
    this.#signal = options.signal;
    this.#now = options.now ?? (() => new Date());
  }

  async processAvailable(maxJobs = 25): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      if (this.#signal?.aborted === true) {
        break;
      }
      const now = this.#now().toISOString();
      const job = this.#store.claimNextOutbox(now);
      if (job === undefined) {
        break;
      }

      try {
        const replyReferenceId = await this.#processJob(job);
        const completedAt = this.#now().toISOString();
        if (replyReferenceId === undefined) {
          this.#store.completeOutbox(job.id, completedAt);
        } else {
          this.#store.completeTalkReplyOutbox(
            job.id,
            job.eventId,
            replyReferenceId,
            completedAt,
          );
        }
      } catch (error) {
        const code = safeErrorCode(error);
        const terminal =
          !(error instanceof AttachmentShadowShutdownError) &&
          (isTerminalError(error) || job.attemptCount >= 3);
        if (terminal && job.kind === 'process-attachment-shadow') {
          const event = this.#store.getInbound(job.eventId);
          if (event === undefined) {
            this.#store.failOutbox(job.id, code);
          } else {
            const reply = failedReply(event, code);
            this.#store.failProcessingAndEnqueueReply(
              job.id,
              job.eventId,
              code,
              reply,
              `attachment-talk-reply:${event.idempotencyKey}:failed`,
              this.#now().toISOString(),
            );
          }
        } else if (terminal && job.kind === 'deliver-attachment-result') {
          this.#store.deadLetterTalkReplyOutbox(
            job.id,
            job.eventId,
            code,
            this.#now().toISOString(),
          );
        } else if (terminal) {
          this.#store.failOutbox(job.id, code);
        } else {
          const availableAt = new Date(
            this.#now().valueOf() + job.attemptCount * 1_000,
          ).toISOString();
          this.#store.retryOutbox(job.id, code, availableAt);
        }
      }
      processed += 1;
    }
    return processed;
  }

  async #processJob(job: AttachmentOutboxJob): Promise<string | undefined> {
    this.#throwIfShuttingDown();
    if (job.kind === 'deliver-attachment-result') {
      const delivery = deliveryPayloadSchema.parse(job.payload);
      if (delivery.type === 'conversation-handoff') {
        const event = this.#store.getInbound(job.eventId);
        const shadow = this.#store.getShadowItem(job.eventId);
        if (event === undefined || shadow?.status !== 'completed') {
          throw new TerminalAttachmentShadowError(
            'attachment-conversation-not-ready',
          );
        }
        try {
          await this.#conversation.enqueueCompletedAttachment(event);
          return undefined;
        } catch (error) {
          if (job.attemptCount < 2) {
            throw error;
          }
        }
      }
      const reply =
        delivery.type === 'conversation-handoff'
          ? delivery.fallbackReply
          : delivery.reply;
      const delivered = await this.#talk.sendReplyWithIdentity(reply);
      return delivered.referenceId;
    }

    await this.#processAttachment(job.eventId);
    return undefined;
  }

  async #processAttachment(eventId: string): Promise<void> {
    const event = this.#store.getInbound(eventId);
    const shadow = this.#store.getShadowItem(eventId);
    if (event === undefined || shadow === undefined) {
      throw new TerminalAttachmentShadowError('unknown-attachment-event');
    }
    if (shadow.status === 'completed' || shadow.status === 'failed') {
      return;
    }

    let source: RetrievedNextcloudFile | undefined;
    let prepared: PreparedReceiptDocument | undefined;
    try {
      const retrieved = await this.#runBeforeTransmission(() =>
        this.#source.retrieve(event.attachment, this.#signal),
      );
      source = retrieved;
      const archived = await this.#runBeforeTransmission(() =>
        this.#archive.preserveBinaryOriginal(
          {
            idempotencyKey: createReceiptDocumentIdempotencyKey(
              retrieved.sourceSha256,
            ),
            sourceBytes: retrieved.bytes,
            mediaType: retrieved.mediaType,
            receivedAt: event.receivedAt,
          },
          this.#signal,
        ),
      );
      this.#store.markPreserved(
        event.id,
        archived.path,
        source.sourceSha256,
        this.#now().toISOString(),
      );
      const reusable = this.#store.findCompletedBySourceSha256(
        source.sourceSha256,
        event.id,
      );
      const reusableProposal =
        reusable === undefined
          ? undefined
          : receiptModelProposalV1Schema.safeParse(reusable.proposal);
      if (reusable !== undefined && reusableProposal?.success === true) {
        this.#throwIfShuttingDown();
        this.#store.completeReusedShadowAndEnqueueConversation(
          event.id,
          reusableProposal.data,
          reusable.modelMetadata,
          reusable.eventId,
          this.#now().toISOString(),
        );
        return;
      }
      prepared = await this.#runBeforeTransmission(() =>
        this.#preparer.prepare(retrieved, this.#signal),
      );

      this.#throwIfShuttingDown();
      this.#store.startProviderCall(event.id, this.#now().toISOString());
      let run;
      try {
        run = await this.#model.extract(
          prepared,
          this.#signal,
          event.captionHint,
        );
      } catch (error) {
        if (
          error instanceof XaiResponsesAdapterError &&
          error.code === 'request-aborted-before-send' &&
          error.phase === 'preflight'
        ) {
          this.#store.clearProviderCallBeforeSend(
            event.id,
            this.#now().toISOString(),
          );
          throw new AttachmentShadowShutdownError();
        }
        throw error;
      }

      this.#store.completeShadowAndEnqueueConversation(
        event.id,
        run.proposal,
        run.metadata,
        this.#now().toISOString(),
      );
    } finally {
      wipeDocument(prepared);
      source?.bytes.fill(0);
    }
  }

  #throwIfShuttingDown(): void {
    if (this.#signal?.aborted === true) {
      throw new AttachmentShadowShutdownError();
    }
  }

  async #runBeforeTransmission<T>(operation: () => Promise<T>): Promise<T> {
    this.#throwIfShuttingDown();
    try {
      const result = await operation();
      this.#throwIfShuttingDown();
      return result;
    } catch (error) {
      this.#throwIfShuttingDown();
      throw error;
    }
  }
}

export class AttachmentShadowOutboxWorker {
  readonly #workflow: AttachmentShadowWorkflow;
  #running: Promise<number> | undefined;

  constructor(workflow: AttachmentShadowWorkflow) {
    this.#workflow = workflow;
  }

  kick(): Promise<number> {
    this.#running ??= this.#workflow.processAvailable().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }
}
