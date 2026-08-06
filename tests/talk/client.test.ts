import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { TalkBotClient, TalkReplyIdentityError } from '../../src/talk/index.js';

const botActorId = `bots/bot-${'a'.repeat(40)}`;
const referenceId = 'b'.repeat(64);

function ocsResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      ocs: {
        meta: { status: 'ok', statuscode: status },
        data,
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function deliveredMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    token: 'room-token',
    actorType: 'bots',
    actorId: botActorId.slice('bots/'.length),
    actorDisplayName: 'Household Finance Bot',
    referenceId,
    message: 'Reviewed proposal.',
    messageType: 'comment',
    systemMessage: '',
    parent: { id: 42 },
    ...overrides,
  };
}

describe('TalkBotClient', () => {
  it('signs the exact JSON body sent to Talk', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const secret = 'test-shared-secret';
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test/',
      secret,
      fetchImplementation,
    });

    await client.sendReply({
      roomToken: 'room-token',
      message: 'Recorded synthetic receipt.',
      replyTo: '42',
      referenceId: 'reference-id',
    });

    const [, request] = fetchImplementation.mock.calls[0] ?? [];
    const headers = request?.headers as Record<string, string>;
    const body = request?.body as string;
    const expected = createHmac('sha256', secret)
      .update(headers['x-nextcloud-talk-bot-random'] ?? '')
      .update('Recorded synthetic receipt.')
      .digest('hex');

    expect(headers['x-nextcloud-talk-bot-signature']).toBe(expected);
    expect(request).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(body)).toMatchObject({
      message: 'Recorded synthetic receipt.',
      replyTo: 42,
      referenceId: 'reference-id',
      silent: false,
    });
  });

  it('uses a configurable finite request timeout and refuses redirects', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutSignal);
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      const client = new TalkBotClient({
        baseUrl: 'https://cloud.example.test',
        secret: 'test-shared-secret',
        requestTimeoutMs: 2_345,
        fetchImplementation,
      });

      await client.sendReply({
        roomToken: 'room-token',
        message: 'Recorded synthetic receipt.',
        referenceId: 'reference-id',
      });

      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(2_345);
      expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
        redirect: 'error',
        signal: timeoutSignal,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it('defaults Talk requests to a finite ten-second timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 201 })),
    });

    try {
      await client.sendReply({
        roomToken: 'room-token',
        message: 'Recorded synthetic receipt.',
        referenceId: 'reference-id',
      });

      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('binds a delivered bot reply through the official OCS chat response', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ocsResponse([]))
      .mockResolvedValueOnce(ocsResponse(null, 201))
      .mockResolvedValueOnce(ocsResponse([deliveredMessage()]));
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(
      client.sendReplyWithIdentity({
        roomToken: 'room-token',
        message: 'Reviewed proposal.',
        replyTo: '42',
        referenceId,
      }),
    ).resolves.toEqual({
      roomToken: 'room-token',
      botActorId,
      messageId: '101',
      referenceId,
      replyTo: '42',
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    const [historyUrl, historyRequest] =
      fetchImplementation.mock.calls[0] ?? [];
    expect(String(historyUrl)).toContain(
      '/ocs/v2.php/apps/spreed/api/v1/chat/room-token?',
    );
    expect(historyRequest).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(
          'finance-bot:must-not-leak',
        ).toString('base64')}`,
        'ocs-apirequest': 'true',
      },
    });
  });

  it('reconciles an accepted prior send by exact reference without posting again', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ocsResponse([deliveredMessage()]));
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(
      client.sendReplyWithIdentity({
        roomToken: 'room-token',
        message: 'Reviewed proposal.',
        replyTo: '42',
        referenceId,
      }),
    ).resolves.toMatchObject({ messageId: '101', referenceId });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('returns bounded recent Talk context without internal finance markers', async () => {
    const receiptReference = 'c'.repeat(64);
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      ocsResponse([
        deliveredMessage({
          id: 99,
          actorType: 'bots',
          actorId: botActorId.slice('bots/'.length),
          referenceId: null,
          message: `Which category best fits this SimpleFIN receipt?\n\nReply directly to this message.\nFinance reference: receipt-category/${receiptReference}`,
          parent: null,
        }),
        deliveredMessage({
          id: 100,
          actorType: 'users',
          actorId: 'alex',
          actorDisplayName: 'Alex',
          referenceId: null,
          message: 'This is the service that links to my bank accounts.',
          parent: {
            id: 99,
            actorType: 'bots',
            actorId: botActorId.slice('bots/'.length),
            actorDisplayName: 'Household Finance Bot',
            message:
              `Which category best fits this SimpleFIN receipt?\n\n` +
              `Reply directly to this message.\nFinance reference: receipt-category/${receiptReference}`,
            messageType: 'comment',
            systemMessage: '',
          },
        }),
        deliveredMessage({
          id: 101,
          actorType: 'users',
          actorId: 'alex',
          actorDisplayName: 'Alex',
          referenceId: null,
          message: 'must be ignored',
          messageType: 'system',
          systemMessage: 'user_added',
          parent: null,
        }),
        deliveredMessage({
          id: 102,
          actorType: 'guests',
          actorId: 'guest',
          actorDisplayName: 'Guest',
          referenceId: null,
          message: 'must also be ignored',
          parent: null,
        }),
        deliveredMessage({
          id: 103,
          actorType: 'users',
          actorId: 'sam',
          actorDisplayName: 'Sam',
          referenceId: null,
          message: 'This later message must not affect message 100.',
          parent: null,
        }),
      ]),
    );
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(
      client.recentConversation('room-token', 2, '100'),
    ).resolves.toEqual([
      {
        messageId: '99',
        actor: 'assistant',
        actorId: botActorId.slice('bots/'.length),
        actorDisplayName: 'Household Finance Bot',
        speaker: {
          kind: 'finance-assistant',
          actorId: botActorId.slice('bots/'.length),
          displayName: 'Household Finance Bot',
        },
        message: 'Which category best fits this SimpleFIN receipt?',
      },
      {
        messageId: '100',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
        speaker: {
          kind: 'household-member',
          actorId: 'alex',
          displayName: 'Alex',
        },
        message: 'This is the service that links to my bank accounts.',
        parentMessageId: '99',
        replyTo: {
          messageId: '99',
          speaker: {
            kind: 'finance-assistant',
            actorId: botActorId.slice('bots/'.length),
            displayName: 'Household Finance Bot',
          },
          message: 'Which category best fits this SimpleFIN receipt?',
        },
      },
    ]);

    const [historyUrl, historyRequest] =
      fetchImplementation.mock.calls[0] ?? [];
    expect(String(historyUrl)).toContain('limit=200');
    expect(historyRequest).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        authorization: `Basic ${Buffer.from(
          'finance-bot:must-not-leak',
        ).toString('base64')}`,
      },
    });
  });

  it('sorts descending Nextcloud history numerically before taking the latest turns', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      ocsResponse([
        deliveredMessage({
          id: 1003,
          actorType: 'users',
          actorId: 'alex',
          actorDisplayName: 'Alex',
          referenceId: null,
          message: 'Newest message.',
          parent: null,
        }),
        deliveredMessage({
          id: 1002,
          actorType: 'bots',
          actorId: botActorId.slice('bots/'.length),
          actorDisplayName: 'Household Finance Bot',
          referenceId: null,
          message: 'Middle message.',
          parent: null,
        }),
        deliveredMessage({
          id: 999,
          actorType: 'users',
          actorId: 'sam',
          actorDisplayName: 'Sam',
          referenceId: null,
          message: 'Oldest message.',
          parent: null,
        }),
      ]),
    );
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(client.recentConversation('room-token', 2)).resolves.toEqual([
      {
        messageId: '1002',
        actor: 'assistant',
        actorId: botActorId.slice('bots/'.length),
        actorDisplayName: 'Household Finance Bot',
        speaker: {
          kind: 'finance-assistant',
          actorId: botActorId.slice('bots/'.length),
          displayName: 'Household Finance Bot',
        },
        message: 'Middle message.',
      },
      {
        messageId: '1003',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
        speaker: {
          kind: 'household-member',
          actorId: 'alex',
          displayName: 'Alex',
        },
        message: 'Newest message.',
      },
    ]);
  });

  it('does not present an unrelated Talk bot as the finance assistant', async () => {
    const otherBotActorId = `bot-${'c'.repeat(40)}`;
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      ocsResponse([
        deliveredMessage({
          id: 200,
          actorType: 'bots',
          actorId: otherBotActorId,
          actorDisplayName: 'Generic Summary Assistant',
          referenceId: null,
          message: 'A generic summary that must not become finance context.',
          parent: null,
        }),
        deliveredMessage({
          id: 201,
          actorType: 'users',
          actorId: 'sam',
          actorDisplayName: 'Sam',
          referenceId: null,
          message: 'How much did we spend there?',
          parent: {
            id: 200,
            actorType: 'bots',
            actorId: otherBotActorId,
            actorDisplayName: 'Generic Summary Assistant',
            message: 'A generic summary that must not become finance context.',
            messageType: 'comment',
            systemMessage: '',
          },
        }),
      ]),
    );
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(client.recentConversation('room-token')).resolves.toEqual([
      {
        messageId: '201',
        actor: 'household',
        actorId: 'sam',
        actorDisplayName: 'Sam',
        speaker: {
          kind: 'household-member',
          actorId: 'sam',
          displayName: 'Sam',
        },
        message: 'How much did we spend there?',
        parentMessageId: '200',
        replyTo: {
          messageId: '200',
          speaker: {
            kind: 'other-bot',
            actorId: otherBotActorId,
            displayName: 'Generic Summary Assistant',
          },
          message: 'A generic summary that must not become finance context.',
        },
      },
    ]);
  });

  it('keeps unapproved Talk users and their quoted text out of household context', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(
      ocsResponse([
        deliveredMessage({
          id: 300,
          actorType: 'users',
          actorId: 'unapproved-user',
          actorDisplayName: 'Unapproved user',
          referenceId: null,
          message: 'Private text that must not enter finance context.',
          parent: null,
        }),
        deliveredMessage({
          id: 301,
          actorType: 'users',
          actorId: 'alex',
          actorDisplayName: 'Alex',
          referenceId: null,
          message: 'What did we spend?',
          parent: {
            id: 300,
            actorType: 'users',
            actorId: 'unapproved-user',
            actorDisplayName: 'Unapproved user',
            message: 'Private text that must not enter finance context.',
            messageType: 'comment',
            systemMessage: '',
          },
        }),
      ]),
    );
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(client.recentConversation('room-token')).resolves.toEqual([
      {
        messageId: '301',
        actor: 'household',
        actorId: 'alex',
        actorDisplayName: 'Alex',
        speaker: {
          kind: 'household-member',
          actorId: 'alex',
          displayName: 'Alex',
        },
        message: 'What did we spend?',
        parentMessageId: '300',
        replyTo: {
          messageId: '300',
        },
      },
    ]);
  });

  it('rejects a successful POST whose official OCS payload is not null', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ocsResponse([]))
      .mockResolvedValueOnce(ocsResponse({}, 201));
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(
      client.sendReplyWithIdentity({
        roomToken: 'room-token',
        message: 'Reviewed proposal.',
        replyTo: '42',
        referenceId,
      }),
    ).rejects.toMatchObject({ code: 'post-response-invalid' });
  });

  it.each([
    ['missing identity', []],
    [
      'other bot copy',
      [deliveredMessage({ actorId: `bot-${'c'.repeat(40)}` })],
    ],
    [
      'duplicate reference',
      [deliveredMessage(), deliveredMessage({ id: 102 })],
    ],
    ['altered text', [deliveredMessage({ message: 'Altered proposal.' })]],
    ['wrong parent', [deliveredMessage({ parent: { id: 999 } })]],
  ])('fails closed for %s after a successful post', async (_name, history) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ocsResponse([]))
      .mockResolvedValueOnce(ocsResponse(null, 201))
      .mockResolvedValueOnce(ocsResponse(history));
    const client = new TalkBotClient({
      baseUrl: 'https://cloud.example.test',
      secret: 'test-shared-secret',
      identityLookup: {
        userId: 'finance-bot',
        appPassword: 'must-not-leak',
        botActorId,
        allowedUserIds: ['alex', 'sam'],
      },
      fetchImplementation,
    });

    await expect(
      client.sendReplyWithIdentity({
        roomToken: 'room-token',
        message: 'Reviewed proposal.',
        replyTo: '42',
        referenceId,
      }),
    ).rejects.toBeInstanceOf(TalkReplyIdentityError);
  });
});
