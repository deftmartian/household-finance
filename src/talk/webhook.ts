import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const talkMessageContentSchema = z.object({
  message: z.string(),
  parameters: z
    .union([z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional(),
});

const talkActivityTypeSchema = z.object({
  type: z.string(),
});

const talkActivitySchema = z.object({
  type: z.enum(['Create', 'Activity']),
  actor: z.object({
    type: z.literal('Person'),
    id: z.string().regex(/^users\/[^/]+$/),
  }),
  object: z.object({
    type: z.literal('Note'),
    id: z.union([z.string(), z.number().int()]).transform(String),
    name: z.string(),
    content: z.string(),
    inReplyTo: z.unknown().optional(),
  }),
  target: z.object({
    type: z.literal('Collection'),
    id: z.string().min(1),
  }),
});

const talkBotReplyParentSchema = z.object({
  actor: z.object({
    type: z.literal('Application'),
    id: z.string().regex(/^bots\/bot-[a-f0-9]{40}$/),
  }),
  object: z.object({
    type: z.literal('Note'),
    id: z.union([z.string(), z.number().int()]).transform(String),
    content: z.string(),
  }),
});

export interface TalkWebhookPolicy {
  secret: string;
  backendUrl: string;
  roomToken: string;
  allowedUserIds: ReadonlySet<string>;
}

export interface TalkWebhookHeaders {
  signature?: string | undefined;
  random?: string | undefined;
  backend?: string | undefined;
}

interface TalkReceiptMessageCommon {
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  actorId: string;
  messageId: string;
}

export type TalkReceiptMessage = TalkReceiptMessageCommon & {
  kind: 'nextcloud-file';
  attachment: TalkAttachmentReference;
  captionHint?: string;
};

export type TalkVoiceMessage = TalkReceiptMessageCommon & {
  kind: 'nextcloud-voice';
  attachment: TalkVoiceAttachmentReference;
};

export type TalkHouseholdMessage = TalkReceiptMessageCommon & {
  kind: 'household-message';
  message: string;
};

export type TalkBotReply = TalkReceiptMessageCommon & {
  kind: 'bot-reply';
  message: string;
  parentBotId: string;
  parentMessageId: string;
  parentMessageText: string;
};

export type TalkWebhookEvent =
  TalkReceiptMessage | TalkVoiceMessage | TalkHouseholdMessage | TalkBotReply;

export const MAX_TALK_RECEIPT_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export const talkAttachmentMediaTypes = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;

export type TalkAttachmentMediaType = (typeof talkAttachmentMediaTypes)[number];

export const talkVoiceAttachmentMediaTypes = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
] as const;

export type TalkVoiceAttachmentMediaType =
  (typeof talkVoiceAttachmentMediaTypes)[number];

export interface TalkAttachmentReference {
  fileId: string;
  etag: string;
  sizeBytes: number;
  mediaType: TalkAttachmentMediaType;
}

export interface TalkVoiceAttachmentReference {
  fileId: string;
  etag: string;
  sizeBytes: number;
  mediaType: TalkVoiceAttachmentMediaType;
}

export type TalkWebhookRejectionCode =
  | 'missing-signature'
  | 'invalid-signature'
  | 'invalid-backend'
  | 'invalid-payload'
  | 'room-not-allowed'
  | 'user-not-allowed';

export class TalkWebhookRejectedError extends Error {
  constructor(readonly code: TalkWebhookRejectionCode) {
    super(`Talk webhook rejected: ${code}`);
    this.name = 'TalkWebhookRejectedError';
  }
}

const talkFileParameterSchema = z.object({
  type: z.literal('file'),
  id: z
    .union([
      z.string().regex(/^[1-9]\d{0,19}$/),
      z.number().int().safe().positive(),
    ])
    .transform(String),
  etag: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !value.includes('\r') && !value.includes('\n')),
  size: z
    .union([
      z.string().regex(/^[1-9]\d{0,15}$/),
      z.number().int().safe().positive(),
    ])
    .transform(Number)
    .refine(Number.isSafeInteger),
  mimetype: z.string().min(1).max(200),
  'hide-download': z.enum(['yes', 'no']).optional(),
});

const supportedAttachmentMediaTypes: ReadonlySet<string> = new Set([
  ...talkAttachmentMediaTypes,
  ...talkVoiceAttachmentMediaTypes,
]);

const supportedAttachmentActivityNames: ReadonlySet<string> = new Set([
  'file_shared',
  // Nextcloud can clear the raw system-message name while parsing mentions in
  // a file caption, causing BotService to emit its fallback name.
  'message',
]);

function isFileParameter(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'file'
  );
}

function parseTalkAttachment(
  parameters: z.infer<typeof talkMessageContentSchema>['parameters'],
): TalkAttachmentReference | TalkVoiceAttachmentReference | undefined {
  if (parameters === undefined || Array.isArray(parameters)) {
    throw new TalkWebhookRejectedError('invalid-payload');
  }

  const fileParameters = Object.values(parameters).filter(isFileParameter);
  if (fileParameters.length !== 1) {
    throw new TalkWebhookRejectedError('invalid-payload');
  }

  const parsed = talkFileParameterSchema.safeParse(fileParameters[0]);
  if (!parsed.success) {
    throw new TalkWebhookRejectedError('invalid-payload');
  }

  const mediaType = parsed.data.mimetype.toLowerCase();
  if (
    parsed.data['hide-download'] === 'yes' ||
    !supportedAttachmentMediaTypes.has(mediaType) ||
    parsed.data.size > MAX_TALK_RECEIPT_ATTACHMENT_BYTES
  ) {
    return undefined;
  }

  return {
    fileId: parsed.data.id,
    etag: parsed.data.etag,
    sizeBytes: parsed.data.size,
    mediaType: mediaType as
      TalkAttachmentMediaType | TalkVoiceAttachmentMediaType,
  };
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export function verifyTalkWebhookSignature(
  rawBody: Buffer,
  headers: TalkWebhookHeaders,
  secret: string,
): void {
  const { signature, random } = headers;
  if (
    signature === undefined ||
    random === undefined ||
    !/^[a-fA-F0-9]{64}$/.test(signature) ||
    random.length === 0 ||
    random.length > 256
  ) {
    throw new TalkWebhookRejectedError('missing-signature');
  }

  const expected = createHmac('sha256', secret)
    .update(random)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(signature, 'hex');

  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    throw new TalkWebhookRejectedError('invalid-signature');
  }
}

interface AuthenticatedTalkMessage {
  expectedBackend: string;
  activity: z.infer<typeof talkActivitySchema>;
  content: z.infer<typeof talkMessageContentSchema>;
  roomToken: string;
  actorId: string;
  messageId: string;
}

function parseAuthenticatedTalkMessage(
  rawBody: Buffer,
  headers: TalkWebhookHeaders,
  policy: TalkWebhookPolicy,
): AuthenticatedTalkMessage | undefined {
  verifyTalkWebhookSignature(rawBody, headers, policy.secret);

  let expectedBackend: string;
  let suppliedBackend: string;
  try {
    expectedBackend = normalizedBaseUrl(policy.backendUrl);
    suppliedBackend = normalizedBaseUrl(headers.backend ?? '');
  } catch {
    throw new TalkWebhookRejectedError('invalid-backend');
  }

  if (expectedBackend !== suppliedBackend) {
    throw new TalkWebhookRejectedError('invalid-backend');
  }

  const json = (() => {
    try {
      return JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      throw new TalkWebhookRejectedError('invalid-payload');
    }
  })();
  const activityType = talkActivityTypeSchema.safeParse(json);
  if (!activityType.success) {
    throw new TalkWebhookRejectedError('invalid-payload');
  }
  if (
    activityType.data.type !== 'Create' &&
    activityType.data.type !== 'Activity'
  ) {
    return undefined;
  }

  const parsed = talkActivitySchema.safeParse(json);
  if (!parsed.success) {
    throw new TalkWebhookRejectedError('invalid-payload');
  }

  const actorId = parsed.data.actor.id.slice('users/'.length);
  const roomToken = parsed.data.target.id;
  if (policy.roomToken !== roomToken) {
    throw new TalkWebhookRejectedError('room-not-allowed');
  }
  if (!policy.allowedUserIds.has(actorId)) {
    throw new TalkWebhookRejectedError('user-not-allowed');
  }

  const content = (() => {
    try {
      return talkMessageContentSchema.parse(
        JSON.parse(parsed.data.object.content) as unknown,
      );
    } catch {
      throw new TalkWebhookRejectedError('invalid-payload');
    }
  })();

  const messageId = parsed.data.object.id;

  return {
    expectedBackend,
    activity: parsed.data,
    content,
    roomToken,
    actorId,
    messageId,
  };
}

export function parseTalkWebhook(
  rawBody: Buffer,
  headers: TalkWebhookHeaders,
  policy: TalkWebhookPolicy,
): TalkWebhookEvent | undefined {
  const authenticated = parseAuthenticatedTalkMessage(rawBody, headers, policy);
  if (authenticated === undefined) {
    return undefined;
  }

  const { expectedBackend, activity, content, roomToken, actorId, messageId } =
    authenticated;

  const idempotencyKey = createHash('sha256')
    .update('nextcloud-talk-receipt-v1\0')
    .update(expectedBackend)
    .update('\0')
    .update(roomToken)
    .update('\0')
    .update(messageId)
    .digest('hex');

  const common = {
    idempotencyKey,
    backendUrl: expectedBackend,
    roomToken,
    actorId,
    messageId,
  };

  if (activity.type === 'Create') {
    const parent = talkBotReplyParentSchema.safeParse(
      activity.object.inReplyTo,
    );
    if (parent.success) {
      const normalizedReply = content.message.normalize('NFC').trim();
      if (normalizedReply.length === 0 || normalizedReply.length > 2_000) {
        return undefined;
      }

      const parentJson = (() => {
        try {
          return JSON.parse(parent.data.object.content) as unknown;
        } catch {
          return undefined;
        }
      })();
      const parentContent = talkMessageContentSchema.safeParse(parentJson);
      if (!parentContent.success) {
        return undefined;
      }

      return {
        ...common,
        kind: 'bot-reply',
        message: normalizedReply,
        parentBotId: parent.data.actor.id,
        parentMessageId: parent.data.object.id,
        parentMessageText: parentContent.data.message,
      };
    }
  }

  const message = content.message;

  if (activity.type === 'Activity') {
    if (!supportedAttachmentActivityNames.has(activity.object.name)) {
      return undefined;
    }
    const attachment = parseTalkAttachment(content.parameters);
    if (attachment === undefined) {
      return undefined;
    }
    const attachmentIdempotencyKey = createHash('sha256')
      .update('nextcloud-talk-attachment-v1\0')
      .update(expectedBackend)
      .update('\0')
      .update(roomToken)
      .update('\0')
      .update(messageId)
      .update('\0')
      .update(attachment.fileId)
      .digest('hex');
    if (
      talkVoiceAttachmentMediaTypes.some(
        (mediaType) => mediaType === attachment.mediaType,
      )
    ) {
      return {
        ...common,
        idempotencyKey: attachmentIdempotencyKey,
        kind: 'nextcloud-voice',
        attachment: attachment as TalkVoiceAttachmentReference,
      };
    }

    const normalizedCaption = message.normalize('NFC').trim();
    const captionHint =
      normalizedCaption.length === 0 ? undefined : normalizedCaption;
    if (captionHint !== undefined && captionHint.length > 2_000) {
      throw new TalkWebhookRejectedError('invalid-payload');
    }

    return {
      ...common,
      idempotencyKey: attachmentIdempotencyKey,
      kind: 'nextcloud-file',
      attachment: attachment as TalkAttachmentReference,
      ...(captionHint === undefined ? {} : { captionHint }),
    };
  }

  if (message.trim().length === 0 || message.length > 2_000) {
    return undefined;
  }
  return {
    ...common,
    kind: 'household-message',
    message,
  };
}

export function parseTalkReceiptWebhook(
  rawBody: Buffer,
  headers: TalkWebhookHeaders,
  policy: TalkWebhookPolicy,
): TalkReceiptMessage | undefined {
  const event = parseTalkWebhook(rawBody, headers, policy);
  return event?.kind === 'nextcloud-file' ? event : undefined;
}

export function parseTalkBotReplyWebhook(
  rawBody: Buffer,
  headers: TalkWebhookHeaders,
  policy: TalkWebhookPolicy,
): TalkBotReply | undefined {
  const event = parseTalkWebhook(rawBody, headers, policy);
  return event?.kind === 'bot-reply' ? event : undefined;
}
