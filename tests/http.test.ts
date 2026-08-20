import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ActualUpdateTalkDecisionError,
  type ActualUpdateTalkDecisionHandler,
} from '../src/actual-update/index.js';
import type { AppConfig, ProductionAppConfig } from '../src/config.js';
import {
  createHttpServer,
  type HttpDependencies,
  readRequestBody,
  withWipedRequestBody,
} from '../src/http.js';
import { AttachmentShadowStore, QuestionStore } from '../src/storage/index.js';

const servers: ReturnType<typeof createHttpServer>[] = [];

type TestConfigOverrides = Partial<Omit<ProductionAppConfig, 'intakeMode'>> & {
  intakeMode?: AppConfig['intakeMode'];
};

function testConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const common = {
    host: '127.0.0.1',
    port: 0,
    dataDirectory: '/tmp/test',
  } as const;
  if (overrides.intakeMode !== 'production') {
    return {
      ...common,
      intakeMode: 'disabled',
    };
  }

  return {
    ...common,
    intakeMode: 'production',
    model: {
      name: 'grok-4.6',
      reasoningEffort: 'high',
      apiKey: 'must-not-leak',
    },
    questionAnswering: {
      readerUrl: 'http://actual-reader:4370',
      bankSyncIntervalMs: 14_400_000,
      timeZone: 'America/Halifax',
    },
    contextManagement: {
      profilePath: 'Finance/Context/household-profile.json',
    },
    householdFinanceRoomToken: 'finance-room',
    categoryTaxonomyPath: 'Finance/Context/category-taxonomy.json',
    transactionCategorization: {
      rollingWindowDays: 45,
      scanIntervalMs: 60_000,
      minimumAutoApplyConfidence: 0.8,
    },
    actualUpdateIntents: {
      signingKeys: { 'production-v1': 's'.repeat(64) },
      targetReferenceKey: 't'.repeat(64),
      signingKeyId: 'production-v1',
    },
    actualUpdateTalk: { autoApprovalEnabled: false },
    talk: {
      baseUrl: 'https://cloud.example.test',
      secret: 'test-talk-secret',
      botActorId: `bots/bot-${'b'.repeat(40)}`,
      roomToken: 'finance-room',
      allowedUserIds: ['alex'],
    },
    archive: {
      baseUrl: 'https://cloud.example.test',
      serviceUser: 'finance-bot',
      appPassword: 'test-app-password',
      rootPath: 'Finance/Receipts',
    },
    ...overrides,
  };
}

function completeProductionDependencies(
  overrides: HttpDependencies = {},
): HttpDependencies {
  const worker = { kick: vi.fn(async () => 0) };
  const placeholder = {};
  return {
    attachmentStore: placeholder as NonNullable<
      HttpDependencies['attachmentStore']
    >,
    attachmentWorker: worker,
    questionStore: placeholder as NonNullable<
      HttpDependencies['questionStore']
    >,
    questionWorker: worker,
    householdContextStore: placeholder as NonNullable<
      HttpDependencies['householdContextStore']
    >,
    householdContextWorker: worker,
    transactionCategorizationStore: placeholder as NonNullable<
      HttpDependencies['transactionCategorizationStore']
    >,
    transactionCategorizationWorker: worker,
    receiptCategorizationStore: placeholder as NonNullable<
      HttpDependencies['receiptCategorizationStore']
    >,
    receiptCategorizationWorker: worker,
    receiptMatchStore: placeholder as NonNullable<
      HttpDependencies['receiptMatchStore']
    >,
    receiptPipelineReconciler: worker,
    receiptMatchAmbiguityTalkWorker: worker,
    actualUpdateIntentStore: placeholder as NonNullable<
      HttpDependencies['actualUpdateIntentStore']
    >,
    actualUpdateTalkStore: placeholder as NonNullable<
      HttpDependencies['actualUpdateTalkStore']
    >,
    actualUpdateTalkInteractionWorker: worker,
    actualUpdateTalkDecisionHandler: placeholder as NonNullable<
      HttpDependencies['actualUpdateTalkDecisionHandler']
    >,
    talkClarificationHandler: {
      handle: vi.fn(async () => ({
        handled: false as const,
        reason: 'not-a-finance-interaction' as const,
      })),
    },
    operationalMetrics: {
      status: vi.fn(() => ({ status: 'ok', queues: [] })),
      prometheus: vi.fn(() => 'household_finance_build_info 1\n'),
    },
    ...overrides,
  };
}

function createTestHttpServer(
  config: AppConfig,
  dependencies: HttpDependencies = {},
) {
  return createHttpServer(
    config,
    config.intakeMode === 'production'
      ? completeProductionDependencies(dependencies)
      : dependencies,
  );
}

async function listen(
  server: ReturnType<typeof createHttpServer>,
): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an IP socket address');
  }
  return address.port;
}

function expectOnlyQuestionProcessingJobs(
  store: QuestionStore,
  availableAt: string,
  count = 1,
): void {
  for (let index = 0; index < count; index += 1) {
    expect(store.claimNextOutbox(availableAt)).toMatchObject({
      kind: 'process-finance-question',
    });
  }
  expect(store.claimNextOutbox(availableAt)).toBeUndefined();
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    ),
  );
});

describe('request body memory handling', () => {
  it('returns an owned body while wiping every source chunk', async () => {
    const first = Buffer.from('synthetic-');
    const second = Buffer.from('payload');
    const source = (async function* () {
      yield first;
      yield second;
    })();

    const body = await readRequestBody(
      source as unknown as Parameters<typeof readRequestBody>[0],
    );

    expect(body.toString('utf8')).toBe('synthetic-payload');
    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(second.every((byte) => byte === 0)).toBe(true);
    body.fill(0);
  });

  it('wipes buffered and rejected chunks when the body is oversized', async () => {
    const first = Buffer.from('synthetic-prefix');
    const oversized = Buffer.alloc(1_000_001, 0x61);
    const source = (async function* () {
      yield first;
      yield oversized;
    })();

    await expect(
      readRequestBody(
        source as unknown as Parameters<typeof readRequestBody>[0],
      ),
    ).rejects.toThrow();

    expect(first.every((byte) => byte === 0)).toBe(true);
    expect(oversized.every((byte) => byte === 0)).toBe(true);
  });

  it('wipes accumulated chunks when the request stream fails', async () => {
    const first = Buffer.from('synthetic-prefix');
    const streamError = new Error('synthetic stream failure');
    const source = (async function* () {
      yield first;
      throw streamError;
    })();

    await expect(
      readRequestBody(
        source as unknown as Parameters<typeof readRequestBody>[0],
      ),
    ).rejects.toBe(streamError);
    expect(first.every((byte) => byte === 0)).toBe(true);
  });

  it('wipes the owned request body after success and failure', async () => {
    const successful = Buffer.from('synthetic-success');
    await expect(
      withWipedRequestBody(successful, (body) => body.toString('utf8')),
    ).resolves.toBe('synthetic-success');
    expect(successful.every((byte) => byte === 0)).toBe(true);

    const failed = Buffer.from('synthetic-failure');
    const operationError = new Error('synthetic operation failure');
    await expect(
      withWipedRequestBody(failed, () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    expect(failed.every((byte) => byte === 0)).toBe(true);
  });
});

describe('health endpoints', () => {
  it('reports fail-closed capability state without exposing secrets', async () => {
    const config = testConfig();
    const server = createHttpServer(config);
    servers.push(server);

    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.maxRequestsPerSocket).toBe(1);
    expect(server.keepAliveTimeout).toBe(1_000);

    const port = await listen(server);

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/health/ready`,
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('connection')).toBe('close');
    expect(response.headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body).toContain('"intakeMode":"disabled"');
    expect(body).not.toContain('must-not-leak');
  });

  it('requires the complete production runtime', async () => {
    const config = testConfig({
      intakeMode: 'production',
    });
    const attachmentStore = new AttachmentShadowStore(':memory:');
    const attachmentWorker = { kick: vi.fn(async () => 0) };
    expect(() =>
      createHttpServer(config, {
        attachmentStore,
        attachmentWorker,
      }),
    ).toThrow('Production HTTP runtime is incomplete');

    const server = createTestHttpServer(config, {
      attachmentStore,
      attachmentWorker,
    });
    servers.push(server);
    const port = await listen(server);
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/health/ready`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      intakeMode: 'production',
    });
    attachmentStore.close();
  });

  it('serves privacy-safe production status and Prometheus metrics separately from readiness', async () => {
    const operationalMetrics = {
      status: vi.fn(() => ({
        status: 'degraded',
        build: { model: 'grok-4.6', reasoningEffort: 'high' },
        queues: [{ queue: 'questions', due: 1, processing: 0 }],
      })),
      prometheus: vi.fn(
        () =>
          'household_finance_build_info{model="grok-4.6",reasoning_effort="high"} 1\n',
      ),
    };
    const server = createTestHttpServer(
      testConfig({ intakeMode: 'production' }),
      { operationalMetrics },
    );
    servers.push(server);
    const port = await listen(server);

    const status = await fetch(
      `http://127.0.0.1:${String(port)}/health/status`,
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      status: 'degraded',
      build: { model: 'grok-4.6', reasoningEffort: 'high' },
    });

    const metrics = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(await metrics.text()).toContain(
      'household_finance_build_info{model="grok-4.6"',
    );
  });

  it('routes a normalized signed file share only to the isolated attachment shadow store', async () => {
    const secret = 'test-talk-secret';
    const config = testConfig({
      intakeMode: 'production',
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId: `bots/bot-${'b'.repeat(40)}`,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
      archive: {
        baseUrl: 'https://cloud.example.test',
        serviceUser: 'finance-bot',
        appPassword: 'must-not-leak',
        rootPath: 'Finance/Receipts',
      },
    });
    const attachmentStore = new AttachmentShadowStore(':memory:');
    const attachmentWorker = { kick: vi.fn(async () => 0) };
    const server = createTestHttpServer(config, {
      attachmentStore,
      attachmentWorker,
      now: () => new Date('2026-07-27T01:45:00.000Z'),
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Activity',
      actor: {
        type: 'Person',
        id: 'users/alex',
      },
      object: {
        type: 'Note',
        id: '43',
        name: 'message',
        content: JSON.stringify({
          message: '',
          parameters: {
            file: {
              type: 'file',
              id: '123',
              etag: 'signed-etag',
              size: 1024,
              mimetype: 'image/jpeg',
              'hide-download': 'no',
            },
          },
        }),
      },
      target: {
        type: 'Collection',
        id: 'finance-room',
      },
    });
    const random = 'b'.repeat(64);
    const signature = createHmac('sha256', secret)
      .update(random)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': signature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );
    const result = (await response.json()) as {
      status: string;
      auditId: string;
    };

    expect(response.status).toBe(202);
    expect(result.status).toBe('accepted');
    expect(attachmentStore.getShadowItem(result.auditId)?.status).toBe(
      'received',
    );
    expect(attachmentWorker.kick).toHaveBeenCalledOnce();
    attachmentStore.close();
  });

  it('routes authenticated plain text to the household agent without an acknowledgement', async () => {
    const secret = 'test-talk-secret';
    const questionStore = new QuestionStore(':memory:');
    const questionWorker = { kick: vi.fn(async () => 0) };
    const receivedAt = '2026-07-28T02:00:00.000Z';
    const config = testConfig({
      intakeMode: 'production',
      questionAnswering: {
        readerUrl: 'http://actual-reader:4370',
        bankSyncIntervalMs: 14_400_000,
        timeZone: 'America/Halifax',
      },
      contextManagement: {
        profilePath: 'Finance/Context/household-profile.json',
      },
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId: `bots/bot-${'b'.repeat(40)}`,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
    });
    const server = createTestHttpServer(config, {
      questionStore,
      questionWorker,
      now: () => new Date(receivedAt),
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '201',
        name: 'message',
        content: JSON.stringify({
          message: 'Remember that our minimum cash buffer is $2,000.',
        }),
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const random = 'e'.repeat(64);
    const signature = createHmac('sha256', secret)
      .update(random)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': signature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );
    const result = (await response.json()) as {
      status: string;
      auditId: string;
    };

    expect(response.status).toBe(202);
    expect(result.status).toBe('accepted');
    expect(questionStore.getInbound(result.auditId)).toMatchObject({
      actorId: 'alex',
      messageId: '201',
      question: 'Remember that our minimum cash buffer is $2,000.',
    });
    expect(questionWorker.kick).toHaveBeenCalledOnce();
    expectOnlyQuestionProcessingJobs(questionStore, receivedAt);
    questionStore.close();
  });

  it('records a voice message durably before transcription', async () => {
    const secret = 'test-talk-secret';
    const questionStore = new QuestionStore(':memory:');
    const questionWorker = { kick: vi.fn(async () => 0) };
    const receivedAt = '2026-07-28T02:00:00.000Z';
    const config = testConfig({
      intakeMode: 'production',
      questionAnswering: {
        readerUrl: 'http://actual-reader:4370',
        bankSyncIntervalMs: 14_400_000,
        timeZone: 'America/Halifax',
      },
      contextManagement: {
        profilePath: 'Finance/Context/household-profile.json',
      },
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId: `bots/bot-${'b'.repeat(40)}`,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
    });
    const server = createTestHttpServer(config, {
      questionStore,
      questionWorker,
      now: () => new Date(receivedAt),
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Activity',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '202',
        name: 'file_shared',
        content: JSON.stringify({
          message: '',
          parameters: {
            file: {
              type: 'file',
              id: '124',
              etag: 'voice-etag',
              size: 2048,
              mimetype: 'audio/mpeg',
              'hide-download': 'no',
            },
          },
        }),
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const random = 'd'.repeat(64);
    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': createHmac('sha256', secret)
            .update(random)
            .update(rawBody)
            .digest('hex'),
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );
    const result = (await response.json()) as {
      status: string;
      auditId: string;
    };

    expect(response.status).toBe(202);
    expect(result.status).toBe('accepted');
    expect(questionStore.getVoiceInbound(result.auditId)).toMatchObject({
      actorId: 'alex',
      messageId: '202',
      status: 'received',
      attachment: {
        fileId: '124',
        etag: 'voice-etag',
        sizeBytes: 2048,
        mediaType: 'audio/mpeg',
      },
    });
    expect(questionStore.getInbound(result.auditId)).toBeUndefined();
    expect(questionWorker.kick).toHaveBeenCalledOnce();
    expect(questionStore.claimNextVoiceOutbox(receivedAt)).toMatchObject({
      kind: 'transcribe-finance-question-voice',
      sourceId: result.auditId,
    });
    questionStore.close();
  });

  it('routes an authenticated approval to the production Actual decision handler', async () => {
    const secret = 'test-talk-secret';
    const botActorId = `bots/bot-${'a'.repeat(40)}`;
    const handleApproval = vi.fn(() => ({
      outcome: 'recorded' as const,
      intent: {},
    }));
    const actualUpdateTalkDecisionHandler = {
      handleApproval,
    } as unknown as ActualUpdateTalkDecisionHandler;
    const actualUpdateTalkInteractionWorker = {
      kick: vi.fn(async () => 0),
    };
    const config = testConfig({
      intakeMode: 'production',
      householdFinanceRoomToken: 'finance-room',
      actualUpdateIntents: {
        signingKeys: { 'production-v1': 's'.repeat(64) },
        targetReferenceKey: 't'.repeat(64),
        signingKeyId: 'production-v1',
      },
      actualUpdateTalk: {
        autoApprovalEnabled: true,
      },
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
    });
    const server = createTestHttpServer(config, {
      actualUpdateTalkDecisionHandler,
      actualUpdateTalkInteractionWorker,
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '302',
        name: 'message',
        content: JSON.stringify({ message: 'approve' }),
        inReplyTo: {
          actor: { type: 'Application', id: botActorId },
          object: {
            type: 'Note',
            id: '301',
            content: JSON.stringify({
              message: 'The first production update is ready.',
            }),
          },
        },
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const random = 'f'.repeat(64);
    const signature = createHmac('sha256', secret)
      .update(random)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': signature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );

    await expect(response.json()).resolves.toEqual({ status: 'recorded' });
    expect(handleApproval).toHaveBeenCalledOnce();
    expect(actualUpdateTalkInteractionWorker.kick).toHaveBeenCalledOnce();
  });

  it('lets a conversational approval word reach the agent when no proposal exists', async () => {
    const secret = 'test-talk-secret';
    const botActorId = `bots/bot-${'a'.repeat(40)}`;
    const questionStore = new QuestionStore(':memory:');
    const questionWorker = { kick: vi.fn(async () => 0) };
    const handleApproval = vi.fn<
      ActualUpdateTalkDecisionHandler['handleApproval']
    >(() => {
      throw new ActualUpdateTalkDecisionError('parent-not-delivered');
    });
    const actualUpdateTalkDecisionHandler = {
      handleApproval,
    } as unknown as ActualUpdateTalkDecisionHandler;
    const actualUpdateTalkInteractionWorker = {
      kick: vi.fn(async () => 0),
    };
    const config = testConfig({
      intakeMode: 'production',
      questionAnswering: {
        readerUrl: 'http://actual-reader:4370',
        bankSyncIntervalMs: 14_400_000,
        timeZone: 'America/Halifax',
      },
      actualUpdateTalk: {
        autoApprovalEnabled: true,
      },
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
    });
    const server = createTestHttpServer(config, {
      questionStore,
      questionWorker,
      actualUpdateTalkDecisionHandler,
      actualUpdateTalkInteractionWorker,
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '312',
        name: 'message',
        content: JSON.stringify({ message: 'approve' }),
        inReplyTo: {
          actor: { type: 'Application', id: botActorId },
          object: {
            type: 'Note',
            id: '311',
            content: JSON.stringify({
              message: 'Should I include savings in that total?',
            }),
          },
        },
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const random = 'c'.repeat(64);
    const signature = createHmac('sha256', secret)
      .update(random)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': signature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );
    const result = (await response.json()) as {
      status: string;
      auditId: string;
    };

    expect(result.status).toBe('accepted');
    expect(handleApproval).toHaveBeenCalledOnce();
    expect(actualUpdateTalkInteractionWorker.kick).not.toHaveBeenCalled();
    expect(questionStore.getInbound(result.auditId)).toMatchObject({
      actorId: 'alex',
      messageId: '312',
      question: 'approve',
    });
    expect(questionWorker.kick).toHaveBeenCalledOnce();

    const approvalPrompt = [
      "I'm ready to categorize this transaction in Actual:",
      '',
      'Date: 2026-07-29',
      'Merchant: Example Market',
      'Amount: $17.25',
      'Account: Mastercard',
      'Category: Groceries',
      '',
      'Reply approve to make the change, or reject to leave it alone.',
    ].join('\n');
    const pendingApprovalBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '314',
        name: 'message',
        content: JSON.stringify({ message: 'approve' }),
        inReplyTo: {
          actor: { type: 'Application', id: botActorId },
          object: {
            type: 'Note',
            id: '313',
            content: JSON.stringify({ message: approvalPrompt }),
          },
        },
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const pendingRandom = 'd'.repeat(64);
    const pendingSignature = createHmac('sha256', secret)
      .update(pendingRandom)
      .update(pendingApprovalBody)
      .digest('hex');
    const sendPendingApproval = () =>
      fetch(`http://127.0.0.1:${String(port)}/talk/webhook`, {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': pendingRandom,
          'x-nextcloud-talk-signature': pendingSignature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: pendingApprovalBody,
      });

    await expect(sendPendingApproval()).resolves.toMatchObject({ status: 500 });
    expect(questionWorker.kick).toHaveBeenCalledOnce();
    handleApproval.mockImplementationOnce(
      () =>
        ({
          outcome: 'recorded' as const,
          intent: {},
        }) as ReturnType<ActualUpdateTalkDecisionHandler['handleApproval']>,
    );
    const reconciled = await sendPendingApproval();
    await expect(reconciled.json()).resolves.toEqual({ status: 'recorded' });
    expect(reconciled.status).toBe(202);
    expect(actualUpdateTalkInteractionWorker.kick).toHaveBeenCalledOnce();
    questionStore.close();
  });

  it('consumes an exact resolved clarification and wakes its finance workers', async () => {
    const secret = 'test-talk-secret';
    const botActorId = `bots/bot-${'b'.repeat(40)}`;
    const questionStore = new QuestionStore(':memory:');
    const questionWorker = { kick: vi.fn(async () => 0) };
    const transactionCategorizationWorker = {
      kick: vi.fn(() => new Promise<number>(() => undefined)),
    };
    const receiptCategorizationWorker = {
      kick: vi.fn(async () => 0),
    };
    const receiptPipelineReconciler = {
      kick: vi.fn(async () => 0),
    };
    const handle = vi.fn(async (event: unknown) => {
      void event;
      return {
        handled: true as const,
        outcome: 'resolved' as const,
        interaction: 'transaction-category' as const,
        referenceId: 'c'.repeat(64),
      };
    });
    const config = testConfig({
      intakeMode: 'production',
      questionAnswering: {
        readerUrl: 'http://actual-reader:4370',
        bankSyncIntervalMs: 14_400_000,
        timeZone: 'America/Halifax',
      },
      transactionCategorization: {
        rollingWindowDays: 45,
        scanIntervalMs: 900_000,
        minimumAutoApplyConfidence: 0.8,
      },
      contextManagement: {
        profilePath: 'Finance/Context/household-profile.json',
      },
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
    });
    const server = createTestHttpServer(config, {
      questionStore,
      questionWorker,
      talkClarificationHandler: { handle },
      transactionCategorizationWorker,
      receiptCategorizationWorker,
      receiptPipelineReconciler,
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '402',
        name: 'message',
        content: JSON.stringify({ message: 'Groceries' }),
        inReplyTo: {
          actor: { type: 'Application', id: botActorId },
          object: {
            type: 'Note',
            id: '401',
            content: JSON.stringify({
              message:
                `Which category should I use?\n\nReply directly to this message.\n` +
                `Finance reference: transaction-category/${'c'.repeat(64)}`,
            }),
          },
        },
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const random = 'e'.repeat(64);
    const signature = createHmac('sha256', secret)
      .update(random)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': signature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );

    await expect(response.json()).resolves.toEqual({ status: 'resolved' });
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toMatchObject({
      message: 'Groceries',
      parentBotId: botActorId,
      parentMessageId: '401',
    });
    expect(questionWorker.kick).not.toHaveBeenCalled();
    expect(transactionCategorizationWorker.kick).toHaveBeenCalledOnce();
    expect(receiptCategorizationWorker.kick).toHaveBeenCalledOnce();
    expect(receiptPipelineReconciler.kick).toHaveBeenCalledOnce();
    questionStore.close();
  });

  it('lets invalid and natural clarification replies continue to the finance agent', async () => {
    const secret = 'test-talk-secret';
    const botActorId = `bots/bot-${'b'.repeat(40)}`;
    const referenceId = 'c'.repeat(64);
    const parentMessageText =
      `Which category should I use for this SimpleFIN receipt?\n\n` +
      `Reply directly to this message.\n` +
      `Finance reference: receipt-category/${referenceId}`;
    const questionStore = new QuestionStore(':memory:');
    const questionWorker = { kick: vi.fn(async () => 0) };
    const handle = vi
      .fn()
      .mockResolvedValueOnce({
        handled: true as const,
        outcome: 'invalid-category' as const,
        interaction: 'receipt-category' as const,
      })
      .mockResolvedValueOnce({
        handled: false as const,
        reason: 'not-a-finance-interaction' as const,
      });
    const config = testConfig({
      intakeMode: 'production',
      questionAnswering: {
        readerUrl: 'http://actual-reader:4370',
        bankSyncIntervalMs: 14_400_000,
        timeZone: 'America/Halifax',
      },
      contextManagement: {
        profilePath: 'Finance/Context/household-profile.json',
      },
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
    });
    const server = createTestHttpServer(config, {
      questionStore,
      questionWorker,
      talkClarificationHandler: { handle },
      now: () => new Date('2026-07-28T02:00:00.000Z'),
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '502',
        name: 'message',
        content: JSON.stringify({
          message:
            'This is for SimpleFIN, the service that links to my bank accounts.',
        }),
        inReplyTo: {
          actor: { type: 'Application', id: botActorId },
          object: {
            type: 'Note',
            id: '501',
            content: JSON.stringify({ message: parentMessageText }),
          },
        },
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const random = 'f'.repeat(64);
    const signature = createHmac('sha256', secret)
      .update(random)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': random,
          'x-nextcloud-talk-signature': signature,
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );
    const result = (await response.json()) as {
      status: string;
      auditId: string;
    };

    expect(response.status).toBe(202);
    expect(result.status).toBe('accepted');
    expect(questionStore.getInbound(result.auditId)).toMatchObject({
      question:
        'This is for SimpleFIN, the service that links to my bank accounts.',
    });
    expect(questionWorker.kick).toHaveBeenCalledOnce();

    const naturalParent = 'I found the Pine payment from last month.';
    const followUpBody = JSON.stringify({
      type: 'Create',
      actor: { type: 'Person', id: 'users/alex' },
      object: {
        type: 'Note',
        id: '504',
        name: 'message',
        content: JSON.stringify({
          message: 'Why did you choose that category?',
        }),
        inReplyTo: {
          actor: { type: 'Application', id: botActorId },
          object: {
            type: 'Note',
            id: '503',
            content: JSON.stringify({ message: naturalParent }),
          },
        },
      },
      target: { type: 'Collection', id: 'finance-room' },
    });
    const followUpRandom = 'a'.repeat(64);
    const followUpResponse = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'x-nextcloud-talk-random': followUpRandom,
          'x-nextcloud-talk-signature': createHmac('sha256', secret)
            .update(followUpRandom)
            .update(followUpBody)
            .digest('hex'),
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: followUpBody,
      },
    );
    const followUp = (await followUpResponse.json()) as {
      status: string;
      auditId: string;
    };
    expect(followUp.status).toBe('accepted');
    expect(questionStore.getInbound(followUp.auditId)).toMatchObject({
      question: 'Why did you choose that category?',
    });
    expect(handle).toHaveBeenCalledTimes(2);
    expect(questionWorker.kick).toHaveBeenCalledTimes(2);
    expectOnlyQuestionProcessingJobs(
      questionStore,
      '2026-07-28T02:00:00.000Z',
      2,
    );
    questionStore.close();
  });

  it('reports only a safe rejection code while keeping the HTTP response generic', async () => {
    const secret = 'test-talk-secret';
    const config = testConfig({
      intakeMode: 'production',
      talk: {
        baseUrl: 'https://cloud.example.test',
        secret,
        botActorId: `bots/bot-${'b'.repeat(40)}`,
        roomToken: 'finance-room',
        allowedUserIds: ['alex'],
      },
      archive: {
        baseUrl: 'https://cloud.example.test',
        serviceUser: 'finance-bot',
        appPassword: 'must-not-leak',
        rootPath: 'Finance/Receipts',
      },
    });
    const reportTalkWebhookRejection = vi.fn();
    const server = createTestHttpServer(config, {
      reportTalkWebhookRejection,
    });
    servers.push(server);
    const port = await listen(server);
    const rawBody = JSON.stringify({
      privateReceiptText: 'must-not-leak',
      roomToken: 'must-not-leak',
      userId: 'must-not-leak',
    });

    const response = await fetch(
      `http://127.0.0.1:${String(port)}/talk/webhook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nextcloud-talk-random': 'a'.repeat(64),
          'x-nextcloud-talk-signature': '0'.repeat(64),
          'x-nextcloud-talk-backend': 'https://cloud.example.test',
        },
        body: rawBody,
      },
    );
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe('{"error":"webhook_rejected"}');
    expect(body).not.toContain('invalid-signature');
    expect(body).not.toContain('must-not-leak');
    expect(reportTalkWebhookRejection).toHaveBeenCalledExactlyOnceWith(
      'invalid-signature',
    );
  });
});
