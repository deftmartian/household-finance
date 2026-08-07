import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_TALK_RECEIPT_ATTACHMENT_BYTES,
  parseTalkBotReplyWebhook,
  parseTalkReceiptWebhook,
  parseTalkWebhook,
  TalkWebhookRejectedError,
} from '../../src/talk/index.js';

const secret = 'test-shared-secret';
const random = 'a'.repeat(64);
const backendUrl = 'https://cloud.example.test';

function body(message = 'How much did I spend on groceries?'): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'Create',
      actor: {
        type: 'Person',
        id: 'users/alex',
        name: 'Alex',
      },
      object: {
        type: 'Note',
        id: '1567',
        name: 'message',
        content: JSON.stringify({ message, parameters: [] }),
        mediaType: 'text/markdown',
      },
      target: {
        type: 'Collection',
        id: 'private-finance-room',
        name: 'Finance Test',
      },
    }),
  );
}

function attachmentBody(
  overrides: Record<string, unknown> = {},
  message = '{file}',
  parameters: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'Activity',
      actor: {
        type: 'Person',
        id: 'users/alex',
        name: 'Alex',
      },
      object: {
        type: 'Note',
        id: '1568',
        name: 'file_shared',
        content: JSON.stringify({
          message,
          parameters: {
            'mention-user1': {
              type: 'user',
              id: 'someone',
              name: 'Someone',
            },
            file: {
              type: 'file',
              id: '12345',
              name: 'private-name-must-not-be-retained.jpg',
              size: '8',
              path: 'private/path/must-not-be-retained.jpg',
              link: 'https://attacker.invalid/must-not-be-used',
              etag: 'synthetic-etag',
              permissions: 'RGDNVW',
              mimetype: 'image/jpeg',
              'preview-available': 'yes',
              'hide-download': 'no',
              ...overrides,
            },
            ...parameters,
          },
        }),
        mediaType: 'text/markdown',
      },
      target: {
        type: 'Collection',
        id: 'private-finance-room',
        name: 'Finance Test',
      },
    }),
  );
}

function approvalBody(
  message = 'approve',
  parentOverrides: Record<string, unknown> = {},
): Buffer {
  const payload = JSON.parse(body(message).toString('utf8')) as {
    object: Record<string, unknown>;
  };
  payload.object.id = '1702';
  payload.object.inReplyTo = {
    actor: {
      type: 'Application',
      id: `bots/bot-${'a'.repeat(40)}`,
      name: 'Household Finance Bot',
    },
    object: {
      type: 'Note',
      id: '1701',
      name: 'message',
      content: JSON.stringify({
        message: 'Example Market — CAD 17.25\nReply approve or reject.',
        parameters: {
          irrelevant: {
            type: 'user',
            id: 'must-not-be-exposed',
          },
        },
      }),
      mediaType: 'text/markdown',
    },
    ...parentOverrides,
  };
  return Buffer.from(JSON.stringify(payload));
}

function headers(rawBody: Buffer, overrideSecret = secret) {
  return {
    signature: createHmac('sha256', overrideSecret)
      .update(random)
      .update(rawBody)
      .digest('hex'),
    random,
    backend: backendUrl,
  };
}

const policy = {
  secret,
  backendUrl,
  roomToken: 'private-finance-room',
  allowedUserIds: new Set(['alex']),
};

describe('Talk webhook intake', () => {
  it('never turns a plain-text receipt command into transaction intake', () => {
    const rawBody = body('!receipt\nSYNTHETIC RECEIPT V1');

    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('accepts one signed supported file share without a command or retaining supplied location data', () => {
    const rawBody = attachmentBody();

    expect(parseTalkReceiptWebhook(rawBody, headers(rawBody), policy)).toEqual({
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      backendUrl,
      roomToken: 'private-finance-room',
      actorId: 'alex',
      messageId: '1568',
      kind: 'nextcloud-file',
      attachment: {
        fileId: '12345',
        etag: 'synthetic-etag',
        sizeBytes: 8,
        mediaType: 'image/jpeg',
      },
    });
    const parsed = parseTalkReceiptWebhook(rawBody, headers(rawBody), policy);
    expect(JSON.stringify(parsed)).not.toContain('attacker.invalid');
    expect(JSON.stringify(parsed)).not.toContain('private/path');
    expect(JSON.stringify(parsed)).not.toContain('private-name');
  });

  it.each(['{file}', '  {FiLe}  '])(
    'does not treat the Talk file placeholder as a household caption',
    (message) => {
      const rawBody = attachmentBody({}, message);

      expect(
        parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
      ).not.toHaveProperty('captionHint');
    },
  );

  it('routes a Talk voice message to transcription', () => {
    const rawBody = attachmentBody({ mimetype: 'audio/mpeg' });

    expect(parseTalkWebhook(rawBody, headers(rawBody), policy)).toEqual({
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      backendUrl,
      roomToken: 'private-finance-room',
      actorId: 'alex',
      messageId: '1568',
      kind: 'nextcloud-voice',
      attachment: {
        fileId: '12345',
        etag: 'synthetic-etag',
        sizeBytes: 8,
        mediaType: 'audio/mpeg',
      },
    });
  });

  it('parses Nextcloud file shares whose raw system-message name was normalized away', () => {
    const payload = JSON.parse(attachmentBody().toString('utf8')) as {
      object: { name: string };
    };
    payload.object.name = 'message';
    const rawBody = Buffer.from(JSON.stringify(payload));

    expect(parseTalkReceiptWebhook(rawBody, headers(rawBody), policy)).toEqual({
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      backendUrl,
      roomToken: 'private-finance-room',
      actorId: 'alex',
      messageId: '1568',
      kind: 'nextcloud-file',
      attachment: {
        fileId: '12345',
        etag: 'synthetic-etag',
        sizeBytes: 8,
        mediaType: 'image/jpeg',
      },
    });
  });

  it('gives different files in the same Talk message distinct identities', () => {
    const firstBody = attachmentBody({ id: '12345', etag: 'first-etag' });
    const secondBody = attachmentBody({ id: '12346', etag: 'second-etag' });

    const first = parseTalkReceiptWebhook(
      firstBody,
      headers(firstBody),
      policy,
    );
    const second = parseTalkReceiptWebhook(
      secondBody,
      headers(secondBody),
      policy,
    );

    expect(first).toMatchObject({
      messageId: '1568',
      attachment: { fileId: '12345' },
    });
    expect(second).toMatchObject({
      messageId: '1568',
      attachment: { fileId: '12346' },
    });
    expect(first?.idempotencyKey).not.toBe(second?.idempotencyKey);
  });

  it('passes an attachment caption only as an authenticated receipt hint', () => {
    const rawBody = attachmentBody(
      {},
      'Weekly groceries; paid with the household Mastercard.',
    );

    expect(parseTalkReceiptWebhook(rawBody, headers(rawBody), policy)).toEqual({
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      backendUrl,
      roomToken: 'private-finance-room',
      actorId: 'alex',
      messageId: '1568',
      kind: 'nextcloud-file',
      attachment: {
        fileId: '12345',
        etag: 'synthetic-etag',
        sizeBytes: 8,
        mediaType: 'image/jpeg',
      },
      captionHint: 'Weekly groceries; paid with the household Mastercard.',
    });
  });

  it('ignores hidden, unsupported, and oversized attachments', () => {
    for (const override of [
      { 'hide-download': 'yes' },
      { mimetype: 'image/gif' },
      { size: String(MAX_TALK_RECEIPT_ATTACHMENT_BYTES + 1) },
    ]) {
      const rawBody = attachmentBody(override);
      expect(
        parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
      ).toBeUndefined();
    }
  });

  it('rejects multiple file parameters and malformed file metadata', () => {
    const secondFile = {
      type: 'file',
      id: '67890',
      size: '8',
      etag: 'another-etag',
      mimetype: 'image/png',
      'hide-download': 'no',
    };
    const multiple = attachmentBody({}, '', {
      anotherFile: secondFile,
    });
    expect(() =>
      parseTalkReceiptWebhook(multiple, headers(multiple), policy),
    ).toThrow(/invalid-payload/);

    for (const override of [{ etag: '' }, { size: '0' }]) {
      const malformed = attachmentBody(override);
      expect(() =>
        parseTalkReceiptWebhook(malformed, headers(malformed), policy),
      ).toThrow(/invalid-payload/);
    }
  });

  it('ignores authenticated Activity payloads that are not file shares', () => {
    const parsed = JSON.parse(attachmentBody().toString('utf8')) as {
      object: { name: string };
    };
    parsed.object.name = 'object_shared';
    const rawBody = Buffer.from(JSON.stringify(parsed));

    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('rejects a normalized attachment Activity without exactly one valid file', () => {
    const parsed = JSON.parse(attachmentBody().toString('utf8')) as {
      object: { name: string; content: string };
    };
    parsed.object.name = 'message';
    const content = JSON.parse(parsed.object.content) as {
      parameters: Record<string, unknown>;
    };
    delete content.parameters.file;
    parsed.object.content = JSON.stringify(content);
    const rawBody = Buffer.from(JSON.stringify(parsed));

    expect(() =>
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toThrow(/invalid-payload/);
  });

  it('does not route a file-looking Create payload into attachment intake', () => {
    const parsed = JSON.parse(attachmentBody().toString('utf8')) as {
      type: string;
      object: { name: string };
    };
    parsed.type = 'Create';
    parsed.object.name = 'message';
    const rawBody = Buffer.from(JSON.stringify(parsed));

    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('ignores non-receipt messages after authenticating them', () => {
    const rawBody = body('hello');

    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('routes an ordinary message to the household agent', () => {
    const rawBody = body('How much did I spend on groceries this month?');

    expect(parseTalkWebhook(rawBody, headers(rawBody), policy)).toEqual({
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      backendUrl,
      roomToken: 'private-finance-room',
      actorId: 'alex',
      messageId: '1567',
      kind: 'household-message',
      message: 'How much did I spend on groceries this month?',
    });
    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('preserves an exact approval word as an authenticated bot reply', () => {
    const rawBody = approvalBody('  APPROVE\n');

    expect(parseTalkBotReplyWebhook(rawBody, headers(rawBody), policy)).toEqual(
      {
        kind: 'bot-reply',
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        backendUrl,
        roomToken: 'private-finance-room',
        actorId: 'alex',
        messageId: '1702',
        message: 'APPROVE',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '1701',
        parentMessageText:
          'Example Market — CAD 17.25\nReply approve or reject.',
      },
    );
    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('emits the same bot reply when a webhook delivery is replayed', () => {
    const rawBody = approvalBody('reject');

    const first = parseTalkWebhook(rawBody, headers(rawBody), policy);
    const replayHeaders = {
      ...headers(rawBody),
      random: 'b'.repeat(64),
    };
    replayHeaders.signature = createHmac('sha256', secret)
      .update(replayHeaders.random)
      .update(rawBody)
      .digest('hex');
    const replay = parseTalkWebhook(rawBody, replayHeaders, policy);

    expect(replay).toEqual(first);
    expect(replay).toEqual(
      expect.objectContaining({
        kind: 'bot-reply',
        message: 'reject',
      }),
    );
  });

  it('parses an authenticated non-approval direct reply with exact parent identity', () => {
    const rawBody = approvalBody('  Groceries  ');

    expect(parseTalkBotReplyWebhook(rawBody, headers(rawBody), policy)).toEqual(
      {
        kind: 'bot-reply',
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        backendUrl,
        roomToken: 'private-finance-room',
        actorId: 'alex',
        messageId: '1702',
        message: 'Groceries',
        parentBotId: `bots/bot-${'a'.repeat(40)}`,
        parentMessageId: '1701',
        parentMessageText:
          'Example Market — CAD 17.25\nReply approve or reject.',
      },
    );
  });

  it('does not manufacture bot-reply context for standalone words', () => {
    for (const rawBody of [body('approve'), body('reject')]) {
      expect(
        parseTalkBotReplyWebhook(rawBody, headers(rawBody), policy),
      ).toBeUndefined();
    }
    for (const message of ['approve please', '!approve', 'yes']) {
      const rawBody = approvalBody(message);
      expect(
        parseTalkBotReplyWebhook(rawBody, headers(rawBody), policy),
      ).toEqual(expect.objectContaining({ kind: 'bot-reply', message }));
    }
  });

  it('ignores replies whose parent is not a valid bot-authored message', () => {
    const humanParent = approvalBody('approve', {
      actor: {
        type: 'Person',
        id: 'users/alex',
      },
    });
    const malformedBotId = approvalBody('approve', {
      actor: {
        type: 'Application',
        id: 'bots/not-the-finance-bot',
      },
    });
    const malformedParentContent = approvalBody('approve', {
      object: {
        type: 'Note',
        id: '1701',
        content: 'not-json',
      },
    });

    for (const rawBody of [
      humanParent,
      malformedBotId,
      malformedParentContent,
    ]) {
      expect(
        parseTalkBotReplyWebhook(rawBody, headers(rawBody), policy),
      ).toBeUndefined();
    }
  });

  it('authenticates and allowlists bot replies before recognizing them', () => {
    const rawBody = approvalBody();

    expect(() =>
      parseTalkBotReplyWebhook(rawBody, headers(rawBody, 'wrong'), policy),
    ).toThrow(TalkWebhookRejectedError);
    expect(() =>
      parseTalkBotReplyWebhook(rawBody, headers(rawBody), {
        ...policy,
        allowedUserIds: new Set(['sam']),
      }),
    ).toThrow(/user-not-allowed/);
  });

  it('ignores an authenticated non-Create Talk activity', () => {
    const rawBody = Buffer.from(
      JSON.stringify({
        type: 'Join',
        actor: { type: 'Person', id: 'users/alex' },
        target: { type: 'Collection', id: 'private-finance-room' },
      }),
    );

    expect(
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toBeUndefined();
  });

  it('rejects a malformed Create activity', () => {
    const rawBody = Buffer.from(JSON.stringify({ type: 'Create' }));

    expect(() =>
      parseTalkReceiptWebhook(rawBody, headers(rawBody), policy),
    ).toThrow(/invalid-payload/);
  });

  it('rejects a signature made with another secret', () => {
    const rawBody = body();

    expect(() =>
      parseTalkReceiptWebhook(rawBody, headers(rawBody, 'wrong'), policy),
    ).toThrow(TalkWebhookRejectedError);
  });

  it('rejects a valid signature from an unallowlisted room', () => {
    const rawBody = body();

    expect(() =>
      parseTalkReceiptWebhook(rawBody, headers(rawBody), {
        ...policy,
        roomToken: 'another-room',
      }),
    ).toThrow(/room-not-allowed/);
  });

  it('rejects a valid signed attachment from an unallowlisted user', () => {
    const rawBody = attachmentBody();

    expect(() =>
      parseTalkReceiptWebhook(rawBody, headers(rawBody), {
        ...policy,
        allowedUserIds: new Set(['sam']),
      }),
    ).toThrow(/user-not-allowed/);
  });
});
