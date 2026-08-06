import { createHmac, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { stripFinanceInteractionReference } from './interaction-reference.js';

export interface TalkReply {
  roomToken: string;
  message: string;
  replyTo?: string;
  referenceId: string;
  silent?: boolean;
}

export interface TalkDeliveredMessageIdentity {
  roomToken: string;
  botActorId: string;
  messageId: string;
  referenceId: string;
  replyTo?: string;
}

export interface TalkMessageIdentityLookup {
  userId: string;
  appPassword: string;
  botActorId: string;
  allowedUserIds: readonly string[];
}

export interface TalkConversationTurn {
  readonly messageId: string;
  readonly actor: 'household' | 'assistant';
  readonly actorId: string;
  readonly actorDisplayName?: string;
  readonly speaker?: TalkConversationSpeaker;
  readonly message: string;
  readonly parentMessageId?: string;
  readonly replyTo?: TalkConversationReplyParent;
}

export interface TalkConversationSpeaker {
  readonly kind: 'household-member' | 'finance-assistant' | 'other-bot';
  readonly actorId: string;
  readonly displayName: string;
}

export interface TalkConversationReplyParent {
  readonly messageId: string;
  readonly speaker?: TalkConversationSpeaker;
  readonly message?: string;
}

export interface TalkBotClientOptions {
  baseUrl: string;
  secret: string;
  identityLookup?: TalkMessageIdentityLookup;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const fullBotActorIdSchema = z.string().regex(/^bots\/bot-[a-f0-9]{40}$/);
const messageIdSchema = z
  .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
  .transform(String);
const talkPostResponseSchema = z.object({
  ocs: z.object({
    data: z.null(),
  }),
});
const talkChatMessageSchema = z
  .object({
    id: messageIdSchema,
    token: z.string(),
    actorType: z.string(),
    actorId: z.string(),
    actorDisplayName: z.string().max(500).optional(),
    referenceId: z.string().nullable().optional(),
    message: z.string(),
    messageType: z.string(),
    systemMessage: z.string(),
    parent: z
      .object({
        id: messageIdSchema,
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const talkChatParentContextSchema = z
  .object({
    id: messageIdSchema,
    actorType: z.string(),
    actorId: z.string(),
    actorDisplayName: z.string().max(500).optional(),
    message: z.string(),
    messageType: z.string(),
    systemMessage: z.string(),
  })
  .passthrough();
const talkChatResponseSchema = z.object({
  ocs: z.object({
    data: z.array(talkChatMessageSchema),
  }),
});

function requestTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Talk request timeout must be a positive integer');
  }
  return timeoutMs;
}

function conversationSpeaker(
  message: {
    readonly actorType: string;
    readonly actorId: string;
    readonly actorDisplayName?: string | undefined;
  },
  financeBotActorId: string,
  allowedUserIds: ReadonlySet<string>,
): TalkConversationSpeaker | undefined {
  const displayName = message.actorDisplayName?.trim() || message.actorId;
  if (message.actorType === 'users') {
    if (!allowedUserIds.has(message.actorId)) {
      return undefined;
    }
    return {
      kind: 'household-member',
      actorId: message.actorId,
      displayName,
    };
  }
  if (message.actorType !== 'bots') {
    return undefined;
  }
  return {
    kind:
      message.actorId === financeBotActorId ? 'finance-assistant' : 'other-bot',
    actorId: message.actorId,
    displayName,
  };
}

function visibleConversationMessage(message: string): string | undefined {
  const visible = stripFinanceInteractionReference(message);
  if (visible.length === 0 || visible.length > 2_000) {
    return undefined;
  }
  return visible;
}

function replyParent(
  parent: unknown,
  financeBotActorId: string,
  allowedUserIds: ReadonlySet<string>,
): TalkConversationReplyParent | undefined {
  const identity = z
    .object({ id: messageIdSchema })
    .passthrough()
    .safeParse(parent);
  if (!identity.success) {
    return undefined;
  }
  const result: TalkConversationReplyParent = {
    messageId: identity.data.id,
  };
  const context = talkChatParentContextSchema.safeParse(parent);
  if (
    !context.success ||
    context.data.messageType !== 'comment' ||
    context.data.systemMessage !== ''
  ) {
    return result;
  }
  const speaker = conversationSpeaker(
    context.data,
    financeBotActorId,
    allowedUserIds,
  );
  if (speaker === undefined) {
    return result;
  }
  const message = visibleConversationMessage(context.data.message);
  return {
    ...result,
    speaker,
    ...(message === undefined ? {} : { message }),
  };
}

export type TalkReplyIdentityErrorCode =
  | 'identity-lookup-not-configured'
  | 'reference-id-invalid'
  | 'post-response-invalid'
  | 'history-request-failed'
  | 'history-response-invalid'
  | 'reference-collision'
  | 'identity-not-found';

export class TalkReplyIdentityError extends Error {
  constructor(readonly code: TalkReplyIdentityErrorCode) {
    super(`Talk reply identity resolution failed: ${code}`);
    this.name = 'TalkReplyIdentityError';
  }
}

export class TalkBotClient {
  readonly #baseUrl: string;
  readonly #secret: string;
  readonly #identityLookup: TalkMessageIdentityLookup | undefined;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: TalkBotClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#secret = options.secret;
    this.#identityLookup =
      options.identityLookup === undefined
        ? undefined
        : {
            ...options.identityLookup,
            botActorId: fullBotActorIdSchema.parse(
              options.identityLookup.botActorId,
            ),
            allowedUserIds: [...options.identityLookup.allowedUserIds],
          };
    this.#allowedUserIds = new Set(
      options.identityLookup?.allowedUserIds.map((actorId) =>
        z.string().min(1).max(200).parse(actorId),
      ) ?? [],
    );
    if (
      options.identityLookup !== undefined &&
      this.#allowedUserIds.size === 0
    ) {
      throw new Error('Talk conversation allowed user IDs cannot be empty');
    }
    this.#requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async sendReply(reply: TalkReply): Promise<void> {
    await this.#postReply(reply);
  }

  async sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity> {
    const lookup = this.#identityLookup;
    if (lookup === undefined) {
      throw new TalkReplyIdentityError('identity-lookup-not-configured');
    }
    if (!sha256Schema.safeParse(reply.referenceId).success) {
      throw new TalkReplyIdentityError('reference-id-invalid');
    }

    const beforeSend = await this.#resolveReplyIdentity(reply, lookup);
    if (beforeSend !== undefined) {
      return beforeSend;
    }

    const response = await this.#postReply(reply);
    try {
      talkPostResponseSchema.parse(await response.json());
    } catch {
      throw new TalkReplyIdentityError('post-response-invalid');
    }

    const delivered = await this.#resolveReplyIdentity(reply, lookup);
    if (delivered === undefined) {
      throw new TalkReplyIdentityError('identity-not-found');
    }
    return delivered;
  }

  async recentConversation(
    roomToken: string,
    limit = 16,
    throughMessageId?: string,
  ): Promise<readonly TalkConversationTurn[]> {
    const lookup = this.#identityLookup;
    if (lookup === undefined) {
      throw new TalkReplyIdentityError('identity-lookup-not-configured');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError('Talk conversation limit must be between 1 and 50');
    }
    const through =
      throughMessageId === undefined
        ? undefined
        : messageIdSchema.parse(throughMessageId);
    // Receipt and workflow messages can be dense. Read a wider raw window so
    // the bounded household/assistant history is not accidentally starved by
    // system and unrelated-bot traffic.
    const messages = await this.#history(roomToken, lookup, 200);
    const financeBotActorId = lookup.botActorId.slice('bots/'.length);
    return messages
      .filter(
        (message) =>
          (through === undefined || BigInt(message.id) <= BigInt(through)) &&
          message.messageType === 'comment' &&
          message.systemMessage === '' &&
          (message.actorType === 'users' || message.actorType === 'bots'),
      )
      .map((message): TalkConversationTurn | undefined => {
        const speaker = conversationSpeaker(
          message,
          financeBotActorId,
          this.#allowedUserIds,
        );
        // Only this configured finance bot may occupy the assistant role.
        // Other Talk bots are unrelated automation, not conversation history
        // for the household finance controller.
        if (speaker === undefined || speaker.kind === 'other-bot') {
          return undefined;
        }
        const visible = visibleConversationMessage(message.message);
        if (visible === undefined) {
          return undefined;
        }
        const parent = replyParent(
          message.parent,
          financeBotActorId,
          this.#allowedUserIds,
        );
        return {
          messageId: message.id,
          actor:
            speaker.kind === 'finance-assistant' ? 'assistant' : 'household',
          actorId: message.actorId,
          actorDisplayName: speaker.displayName,
          speaker,
          message: visible,
          ...(message.parent?.id === undefined
            ? {}
            : { parentMessageId: message.parent.id }),
          ...(parent === undefined ? {} : { replyTo: parent }),
        };
      })
      .filter((turn): turn is TalkConversationTurn => turn !== undefined)
      .sort((left, right) => {
        const leftId = BigInt(left.messageId);
        const rightId = BigInt(right.messageId);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      })
      .slice(-limit);
  }

  async #postReply(reply: TalkReply): Promise<Response> {
    const body = JSON.stringify({
      message: reply.message,
      ...(reply.replyTo === undefined
        ? {}
        : { replyTo: Number.parseInt(reply.replyTo, 10) }),
      referenceId: reply.referenceId,
      silent: reply.silent ?? false,
    });
    const random = randomBytes(32).toString('hex');
    const signature = createHmac('sha256', this.#secret)
      .update(random)
      .update(reply.message)
      .digest('hex');
    const endpoint = `${this.#baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(reply.roomToken)}/message`;
    const response = await this.#fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'ocs-apirequest': 'true',
        'x-nextcloud-talk-bot-random': random,
        'x-nextcloud-talk-bot-signature': signature,
      },
      body,
    });

    if (response.status !== 201) {
      throw new Error(`Talk reply failed with HTTP ${String(response.status)}`);
    }
    return response;
  }

  async #resolveReplyIdentity(
    reply: TalkReply,
    lookup: TalkMessageIdentityLookup,
  ): Promise<TalkDeliveredMessageIdentity | undefined> {
    const messages = await this.#history(reply.roomToken, lookup, 200);

    const sameReference = messages.filter(
      (message) => message.referenceId === reply.referenceId,
    );
    if (sameReference.length === 0) {
      return undefined;
    }

    const expectedActorId = lookup.botActorId.slice('bots/'.length);
    const matches = sameReference.filter(
      (message) =>
        message.token === reply.roomToken &&
        message.actorType === 'bots' &&
        message.actorId === expectedActorId &&
        message.messageType === 'comment' &&
        message.systemMessage === '' &&
        message.message === reply.message &&
        (reply.replyTo === undefined
          ? message.parent === undefined || message.parent === null
          : message.parent?.id === reply.replyTo),
    );
    if (sameReference.length !== 1 || matches.length !== 1) {
      throw new TalkReplyIdentityError('reference-collision');
    }

    const match = matches[0]!;
    return {
      roomToken: match.token,
      botActorId: lookup.botActorId,
      messageId: match.id,
      referenceId: reply.referenceId,
      ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    };
  }

  async #history(
    roomToken: string,
    lookup: TalkMessageIdentityLookup,
    limit: number,
  ): Promise<z.infer<typeof talkChatMessageSchema>[]> {
    const endpoint = new URL(
      `${this.#baseUrl}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(roomToken)}`,
    );
    endpoint.search = new URLSearchParams({
      lookIntoFuture: '0',
      limit: String(limit),
      setReadMarker: '0',
      noStatusUpdate: '1',
      markNotificationsAsRead: '0',
      format: 'json',
    }).toString();

    const response = await this.#fetch(endpoint, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(
          `${lookup.userId}:${lookup.appPassword}`,
        ).toString('base64')}`,
        'ocs-apirequest': 'true',
      },
    });
    if (response.status !== 200) {
      throw new TalkReplyIdentityError('history-request-failed');
    }
    try {
      return talkChatResponseSchema.parse(await response.json()).ocs.data;
    } catch {
      throw new TalkReplyIdentityError('history-response-invalid');
    }
  }
}
