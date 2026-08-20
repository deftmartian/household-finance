import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  ActualUpdateTalkDecisionError,
  createActualUpdateUndoDecision,
  isActualUpdateApprovalPrompt,
  isActualUpdateUndoPrompt,
  parseActualUpdateUndoDecisionText,
  type ActualUpdateTalkDecisionHandler,
} from './actual-update/index.js';
import {
  createApprovalDecision,
  parseApprovalDecisionText,
} from './approval/index.js';
import type { TalkClarificationHandler } from './categorization/index.js';
import type { AppConfig } from './config.js';
import type {
  ActualUpdateIntentStore,
  AttachmentShadowStore,
  HouseholdContextStore,
  QuestionStore,
  ReceiptCategorizationStore,
  ReceiptMatchStore,
  TransactionCategorizationStore,
  ActualUpdateTalkStore,
} from './storage/index.js';
import {
  parseTalkWebhook,
  TalkWebhookRejectedError,
  type TalkWebhookRejectionCode,
} from './talk/index.js';

const jsonHeaders = {
  'cache-control': 'no-store',
  connection: 'close',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};
const metricsHeaders = {
  'cache-control': 'no-store',
  connection: 'close',
  'content-type': 'text/plain; version=0.0.4; charset=utf-8',
  'x-content-type-options': 'nosniff',
};
const maxWebhookBytes = 1_000_000;
const requestTimeoutMs = 30_000;
const headersTimeoutMs = 10_000;
const maxHeaderBytes = 16 * 1024;

export interface HttpWorker {
  kick(): Promise<unknown>;
}

export interface OperationalHttpMetrics {
  status(): Readonly<Record<string, unknown>>;
  prometheus(): string;
}

export interface ProductionHttpDependencies {
  attachmentStore: AttachmentShadowStore;
  attachmentWorker: HttpWorker;
  questionStore: QuestionStore;
  questionWorker: HttpWorker;
  householdContextStore: HouseholdContextStore;
  householdContextWorker: HttpWorker;
  transactionCategorizationStore: TransactionCategorizationStore;
  transactionCategorizationWorker: HttpWorker;
  receiptCategorizationStore: ReceiptCategorizationStore;
  receiptCategorizationWorker: HttpWorker;
  receiptMatchStore: ReceiptMatchStore;
  receiptPipelineReconciler: HttpWorker;
  receiptMatchAmbiguityTalkWorker: HttpWorker;
  actualUpdateIntentStore: ActualUpdateIntentStore;
  actualUpdateTalkStore: ActualUpdateTalkStore;
  actualUpdateTalkInteractionWorker: HttpWorker;
  actualUpdateTalkDecisionHandler: ActualUpdateTalkDecisionHandler;
  talkClarificationHandler: Pick<TalkClarificationHandler, 'handle'>;
  operationalMetrics: OperationalHttpMetrics;
}

export interface HttpDependencies extends Partial<ProductionHttpDependencies> {
  now?: () => Date;
  reportTalkWebhookRejection?: (code: TalkWebhookRejectionCode) => void;
}

const productionDependencyNames = [
  'attachmentStore',
  'attachmentWorker',
  'questionStore',
  'questionWorker',
  'householdContextStore',
  'householdContextWorker',
  'transactionCategorizationStore',
  'transactionCategorizationWorker',
  'receiptCategorizationStore',
  'receiptCategorizationWorker',
  'receiptMatchStore',
  'receiptPipelineReconciler',
  'receiptMatchAmbiguityTalkWorker',
  'actualUpdateIntentStore',
  'actualUpdateTalkStore',
  'actualUpdateTalkInteractionWorker',
  'actualUpdateTalkDecisionHandler',
  'talkClarificationHandler',
  'operationalMetrics',
] as const satisfies readonly (keyof ProductionHttpDependencies)[];

function requireProductionDependencies(
  dependencies: HttpDependencies,
): ProductionHttpDependencies {
  const missing = productionDependencyNames.filter(
    (name) => dependencies[name] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `Production HTTP runtime is incomplete: ${missing.join(', ')}`,
    );
  }
  return dependencies as ProductionHttpDependencies;
}

class RequestBodyTooLargeError extends Error {}

function isMissingActualUpdateParent(error: unknown): boolean {
  return (
    error instanceof ActualUpdateTalkDecisionError &&
    error.code === 'parent-not-delivered'
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    ...jsonHeaders,
    'content-length': String(payload.byteLength),
  });
  const wipe = (): void => {
    payload.fill(0);
  };
  response.once('close', wipe);
  response.end(payload, wipe);
}

function sendMetrics(response: ServerResponse, body: string): void {
  const payload = Buffer.from(body, 'utf8');
  response.shouldKeepAlive = false;
  response.writeHead(200, {
    ...metricsHeaders,
    'content-length': String(payload.byteLength),
  });
  response.end(payload);
}

export async function readRequestBody(
  request: IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buffer.length > maxWebhookBytes - size) {
        buffer.fill(0);
        throw new RequestBodyTooLargeError();
      }
      size += buffer.length;
      chunks.push(buffer);
    }

    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

export async function withWipedRequestBody<T>(
  rawBody: Buffer,
  operation: (body: Buffer) => T | Promise<T>,
): Promise<T> {
  try {
    return await operation(rawBody);
  } finally {
    rawBody.fill(0);
  }
}

export function createHttpServer(
  config: AppConfig,
  dependencies: HttpDependencies = {},
): Server {
  const now = dependencies.now ?? (() => new Date());
  const productionRuntime =
    config.intakeMode === 'production'
      ? requireProductionDependencies(dependencies)
      : undefined;
  const reportTalkWebhookRejection =
    dependencies.reportTalkWebhookRejection ??
    ((code: TalkWebhookRejectionCode): void => {
      process.stderr.write(`Talk webhook rejected: ${code}\n`);
    });

  const requestListener = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    const handle = async (): Promise<void> => {
      const requestPath = new URL(
        request.url ?? '/',
        'http://finance-bot.invalid',
      ).pathname;

      if (request.method === 'GET' && requestPath === '/health/live') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && requestPath === '/health/ready') {
        sendJson(response, 200, {
          status: 'ready',
          intakeMode: config.intakeMode,
        });
        return;
      }

      if (
        request.method === 'GET' &&
        requestPath === '/health/status' &&
        config.intakeMode === 'production'
      ) {
        sendJson(
          response,
          200,
          (
            productionRuntime as ProductionHttpDependencies
          ).operationalMetrics.status(),
        );
        return;
      }

      if (
        request.method === 'GET' &&
        requestPath === '/metrics' &&
        config.intakeMode === 'production'
      ) {
        sendMetrics(
          response,
          (
            productionRuntime as ProductionHttpDependencies
          ).operationalMetrics.prometheus(),
        );
        return;
      }

      if (
        request.method === 'POST' &&
        requestPath === '/talk/webhook' &&
        config.intakeMode === 'production'
      ) {
        const runtime = productionRuntime as ProductionHttpDependencies;
        const talk = config.talk;
        const rawBody = await readRequestBody(request);
        await withWipedRequestBody(rawBody, async (body) => {
          const event = parseTalkWebhook(
            body,
            {
              signature: request.headers['x-nextcloud-talk-signature'] as
                string | undefined,
              random: request.headers['x-nextcloud-talk-random'] as
                string | undefined,
              backend: request.headers['x-nextcloud-talk-backend'] as
                string | undefined,
            },
            {
              secret: talk.secret,
              backendUrl: talk.baseUrl,
              roomToken: talk.roomToken,
              allowedUserIds: new Set(talk.allowedUserIds),
            },
          );

          if (event === undefined) {
            sendJson(response, 202, { status: 'ignored' });
            return;
          }

          const receivedAt = now().toISOString();
          if (event.kind === 'nextcloud-voice') {
            const recorded = runtime.questionStore.recordVoiceInbound({
              idempotencyKey: event.idempotencyKey,
              backendUrl: event.backendUrl,
              roomToken: event.roomToken,
              actorId: event.actorId,
              messageId: event.messageId,
              attachment: event.attachment,
              receivedAt,
            });
            void runtime.questionWorker.kick().catch(() => undefined);
            sendJson(response, 202, {
              status: recorded.inserted ? 'accepted' : 'duplicate',
              auditId: recorded.event.id,
            });
            return;
          }

          if (event.kind === 'bot-reply') {
            const approvalDecision = parseApprovalDecisionText(event.message);
            if (approvalDecision !== undefined) {
              try {
                const recorded =
                  runtime.actualUpdateTalkDecisionHandler.handleApproval(
                    createApprovalDecision({
                      backendUrl: event.backendUrl,
                      roomToken: event.roomToken,
                      approverId: event.actorId,
                      inboundMessageId: event.messageId,
                      proposalBotId: event.parentBotId,
                      proposalMessageId: event.parentMessageId,
                      proposalMessageText: event.parentMessageText,
                      decision: approvalDecision,
                    }),
                  );
                void runtime.actualUpdateTalkInteractionWorker
                  .kick()
                  .catch(() => undefined);
                sendJson(response, 202, { status: recorded.outcome });
                return;
              } catch (error) {
                if (!isMissingActualUpdateParent(error)) {
                  throw error;
                }
                if (
                  event.parentBotId === talk.botActorId &&
                  isActualUpdateApprovalPrompt(event.parentMessageText)
                ) {
                  throw error;
                }
              }
            }

            if (
              parseActualUpdateUndoDecisionText(event.message) !== undefined
            ) {
              try {
                const recorded =
                  runtime.actualUpdateTalkDecisionHandler.handleUndo(
                    createActualUpdateUndoDecision({
                      backendUrl: event.backendUrl,
                      roomToken: event.roomToken,
                      actorId: event.actorId,
                      inboundMessageId: event.messageId,
                      proposalBotId: event.parentBotId,
                      proposalMessageId: event.parentMessageId,
                      proposalMessageText: event.parentMessageText,
                    }),
                  );
                void runtime.actualUpdateTalkInteractionWorker
                  .kick()
                  .catch(() => undefined);
                sendJson(response, 202, { status: recorded.outcome });
                return;
              } catch (error) {
                if (!isMissingActualUpdateParent(error)) {
                  throw error;
                }
                if (
                  event.parentBotId === talk.botActorId &&
                  isActualUpdateUndoPrompt(event.parentMessageText)
                ) {
                  throw error;
                }
              }
            }

            if (event.parentBotId === talk.botActorId) {
              const clarification =
                await runtime.talkClarificationHandler.handle(event);
              if (
                clarification.handled &&
                clarification.outcome === 'resolved'
              ) {
                for (const worker of [
                  runtime.transactionCategorizationWorker,
                  runtime.receiptCategorizationWorker,
                  runtime.receiptPipelineReconciler,
                ]) {
                  void Promise.resolve()
                    .then(() => worker.kick())
                    .catch(() => undefined);
                }
                sendJson(response, 202, {
                  status: clarification.outcome,
                });
                return;
              }
            }

            const recorded = runtime.questionStore.recordInbound(
              {
                idempotencyKey: event.idempotencyKey,
                backendUrl: event.backendUrl,
                roomToken: event.roomToken,
                actorId: event.actorId,
                messageId: event.messageId,
                question: event.message,
                receivedAt,
              },
              { enqueueAcknowledgement: false },
            );
            void runtime.questionWorker.kick().catch(() => undefined);
            sendJson(response, 202, {
              status: recorded.inserted ? 'accepted' : 'duplicate',
              auditId: recorded.event.id,
            });
            return;
          }

          if (event.kind === 'household-message') {
            const recorded = runtime.questionStore.recordInbound(
              {
                idempotencyKey: event.idempotencyKey,
                backendUrl: event.backendUrl,
                roomToken: event.roomToken,
                actorId: event.actorId,
                messageId: event.messageId,
                question: event.message,
                receivedAt,
              },
              { enqueueAcknowledgement: false },
            );
            void runtime.questionWorker.kick().catch(() => undefined);
            sendJson(response, 202, {
              status: recorded.inserted ? 'accepted' : 'duplicate',
              auditId: recorded.event.id,
            });
            return;
          }

          const recorded = runtime.attachmentStore.recordInbound({
            idempotencyKey: event.idempotencyKey,
            backendUrl: event.backendUrl,
            roomToken: event.roomToken,
            actorId: event.actorId,
            messageId: event.messageId,
            attachment: event.attachment,
            ...(event.captionHint === undefined
              ? {}
              : { captionHint: event.captionHint }),
            receivedAt,
          });
          void runtime.attachmentWorker.kick().catch(() => undefined);
          sendJson(response, 202, {
            status: recorded.inserted ? 'accepted' : 'duplicate',
            auditId: recorded.event.id,
          });
        });
        return;
      }

      sendJson(response, 404, { error: 'not_found' });
    };

    void handle().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        sendJson(response, 413, { error: 'payload_too_large' });
        return;
      }
      if (error instanceof TalkWebhookRejectedError) {
        reportTalkWebhookRejection(error.code);
        sendJson(response, 401, { error: 'webhook_rejected' });
        return;
      }
      sendJson(response, 500, { error: 'internal_error' });
    });
  };
  const server = createServer(
    { maxHeaderSize: maxHeaderBytes },
    requestListener,
  );
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1_000;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    }
  });
  return server;
}
