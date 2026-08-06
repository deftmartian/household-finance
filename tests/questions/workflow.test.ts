import { describe, expect, it, vi } from 'vitest';

import {
  createEmptyHouseholdProfile,
  householdProfileSchema,
  type HouseholdProfile,
} from '../../src/context/profile.js';
import { XaiSpeechToTextError } from '../../src/model/xai-speech-to-text.js';
import { XaiStructuredClientError } from '../../src/model/xai-structured-client.js';
import { WebDavFileSourceError } from '../../src/nextcloud/index.js';
import {
  FinanceQuestionToolReplyHandledError,
  type FinanceQuestionAgent,
  type FinanceQuestionAgentInput,
} from '../../src/questions/xai-finance-agent.js';
import {
  FinanceQuestionWorkflow,
  type FinanceQuestionVoiceTranscriber,
} from '../../src/questions/workflow.js';
import { QuestionStore } from '../../src/storage/question-store.js';
import type {
  TalkConversationTurn,
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../../src/talk/client.js';

const now = '2026-07-28T12:00:00.000Z';
const allowedUserIds = ['alex', 'sam'] as const;

function deliveredReply(reply: TalkReply): TalkDeliveredMessageIdentity {
  return {
    roomToken: reply.roomToken,
    botActorId: `bots/bot-${'a'.repeat(40)}`,
    messageId: reply.replyTo ?? '1',
    referenceId: reply.referenceId,
    ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
  };
}
const confirmedProvenance = {
  source: 'operator' as const,
  actorId: 'alex',
  recordedAt: now,
};

function configuredProfile(): HouseholdProfile {
  const profile = createEmptyHouseholdProfile(now);
  profile.policies.minimumCashBufferMinorUnits = {
    value: 20_000,
    status: 'confirmed',
    provenance: confirmedProvenance,
  };
  profile.members.push(
    {
      id: 'alex',
      displayName: 'Alex',
      kind: 'adult',
      talkActorIds: ['alex'],
      access: 'shared-adult',
      status: 'confirmed',
      provenance: confirmedProvenance,
    },
    {
      id: 'sam',
      displayName: 'Sam',
      kind: 'adult',
      talkActorIds: ['sam'],
      access: 'shared-adult',
      status: 'confirmed',
      provenance: confirmedProvenance,
    },
  );
  profile.merchantRules.push({
    id: 'traders-insurance',
    merchantPattern: 'Traders Insurance',
    categoryAlias: 'home-insurance',
    applicationCount: 2,
    correctionCount: 0,
    status: 'confirmed',
    provenance: confirmedProvenance,
  });
  profile.transactionRules.push({
    id: 'pine-mortgage',
    payeePattern: 'Pine',
    specialKind: 'debt-payment',
    status: 'confirmed',
    provenance: confirmedProvenance,
  });
  profile.obligations.push({
    id: 'pine-mortgage-payment',
    name: 'Pine mortgage',
    amountMinorUnits: 146_842,
    amountCertain: true,
    cadence: 'monthly',
    priority: 'required',
    status: 'confirmed',
    provenance: confirmedProvenance,
  });
  for (let index = 1; index < 250; index += 1) {
    profile.merchantRules.push({
      id: `merchant-${String(index)}`,
      merchantPattern: `Merchant ${String(index)} ${'x'.repeat(120)}`,
      categoryAlias: 'general',
      applicationCount: 1,
      correctionCount: 0,
      status: 'confirmed',
      provenance: confirmedProvenance,
    });
    profile.transactionRules.push({
      id: `transaction-${String(index)}`,
      payeePattern: `Transaction ${String(index)} ${'x'.repeat(120)}`,
      specialKind: 'transfer',
      status: 'confirmed',
      provenance: confirmedProvenance,
    });
    profile.obligations.push({
      id: `obligation-${String(index)}`,
      name: `Obligation ${String(index)} ${'x'.repeat(120)}`,
      amountCertain: false,
      cadence: 'irregular',
      priority: 'discretionary',
      status: 'confirmed',
      provenance: confirmedProvenance,
    });
  }
  return householdProfileSchema.parse(profile);
}

function metadata(toolCalls: readonly string[] = []) {
  return {
    provider: 'xai' as const,
    requestedModel: 'grok-4.5',
    resolvedModel: 'grok-4.5',
    preflightAttempts: 1,
    requestAttempts: 2,
    durationMs: 20,
    zeroDataRetention: true as const,
    usage: { costInUsdTicks: 3 },
    turns: 2,
    toolCalls,
  };
}

class ReconcilingTalk {
  readonly deliveries = new Map<string, TalkReply>();
  calls = 0;

  async sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity> {
    this.calls += 1;
    if (!this.deliveries.has(reply.referenceId)) {
      this.deliveries.set(reply.referenceId, structuredClone(reply));
    }
    return deliveredReply(reply);
  }
}

describe('FinanceQuestionWorkflow', () => {
  it('uses the required finance agent with bounded Talk history and household context', async () => {
    const store = new QuestionStore(':memory:');
    const prior = store.recordInbound(
      {
        idempotencyKey: 'question:prior-voice',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '38',
        question: 'Was the larger Traders payment the house insurance?',
        receivedAt: '2026-07-28T00:59:00.000Z',
      },
      { enqueueAcknowledgement: false },
    ).event;
    const priorJob = store.claimNextOutbox(now);
    store.completeQuestionWithoutReply(
      priorJob?.id ?? -1,
      prior.id,
      {},
      {},
      {},
      'Yes, the larger Traders payment was home insurance.',
      now,
    );
    const revoked = store.recordInbound(
      {
        idempotencyKey: 'question:revoked-user',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'former-household-user',
        messageId: '40',
        question: 'Revoked user text must not return from SQLite.',
        receivedAt: '2026-07-28T01:00:00.000Z',
      },
      { enqueueAcknowledgement: false },
    ).event;
    const revokedJob = store.claimNextOutbox(now);
    store.completeQuestionWithoutReply(
      revokedJob?.id ?? -1,
      revoked.id,
      {},
      {},
      {},
      'Historical answer.',
      now,
    );
    const newer = store.recordInbound(
      {
        idempotencyKey: 'question:newer-completed-message',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'sam',
        messageId: '50',
        question: 'This newer message must not affect a retry of message 42.',
        receivedAt: '2026-07-28T12:01:00.000Z',
      },
      { enqueueAcknowledgement: false },
    ).event;
    const newerJob = store.claimNextOutbox('2026-07-28T12:02:00.000Z');
    store.completeQuestionWithoutReply(
      newerJob?.id ?? -1,
      newer.id,
      {},
      {},
      {},
      'Completed after message 42.',
      '2026-07-28T12:02:00.000Z',
    );

    const inputs: FinanceQuestionAgentInput[] = [];
    const agent: FinanceQuestionAgent = {
      answer: async (input) => {
        inputs.push(input);
        return {
          answer: 'The larger Traders payment was $489.66 for home insurance.',
          metadata: metadata(['search_transactions']),
        };
      },
    };
    const sent: string[] = [];
    const financeBotActorId = `bot-${'a'.repeat(40)}`;
    const recentCompletedConversationInputs = vi.spyOn(
      store,
      'recentCompletedConversationInputs',
    );
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent,
      conversationHistorySource: {
        recentConversation: async (roomToken, limit, throughMessageId) => {
          expect({ roomToken, limit, throughMessageId }).toEqual({
            roomToken: 'household-finance',
            limit: 17,
            throughMessageId: '42',
          });
          return Array.from({ length: 18 }, (_, index) => {
            const messageId = String(25 + index);
            const assistant = Number(messageId) % 3 === 0;
            const actor = assistant
              ? ('assistant' as const)
              : ('household' as const);
            const actorId = assistant
              ? financeBotActorId
              : Number(messageId) % 2 === 0
                ? 'alex'
                : 'sam';
            const speaker =
              actor === 'assistant'
                ? ({
                    kind: 'finance-assistant',
                    actorId,
                    displayName: 'Untrusted assistant label',
                  } as const)
                : ({
                    kind: 'household-member',
                    actorId,
                    displayName: 'Untrusted household label',
                  } as const);
            return {
              messageId,
              actor: messageId === '42' ? ('household' as const) : actor,
              actorId: messageId === '42' ? 'alex' : actorId,
              actorDisplayName: 'Untrusted label',
              speaker,
              message:
                messageId === '42'
                  ? 'Which one was the house insurance?'
                  : `Prior message ${messageId}.`,
              ...(messageId === '38'
                ? {
                    parentMessageId: '37',
                    replyTo: {
                      messageId: '37',
                      speaker: {
                        kind: 'other-bot' as const,
                        actorId: 'unrelated-bot',
                        displayName: 'Unrelated bot',
                      },
                      message: 'Unrelated automation output.',
                    },
                  }
                : messageId === '42'
                  ? {
                      parentMessageId: '39',
                      replyTo: {
                        messageId: '39',
                        speaker: {
                          kind: 'finance-assistant' as const,
                          actorId: financeBotActorId,
                          displayName: 'Untrusted assistant label',
                        },
                        message: 'Prior answer.',
                      },
                    }
                  : {}),
            } satisfies TalkConversationTurn;
          }).filter((turn) => turn.messageId !== '40');
        },
      },
      talk: {
        sendReplyWithIdentity: async (reply) => {
          sent.push(reply.message);
          return deliveredReply(reply);
        },
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      profileSource: { read: async () => ({ profile: configuredProfile() }) },
      now: () => new Date(now),
    });
    const event = store.recordInbound(
      {
        idempotencyKey: 'question:agent-workflow',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '42',
        question: 'Which one was the house insurance?',
        receivedAt: now,
      },
      { enqueueAcknowledgement: false },
    ).event;

    await expect(workflow.processAvailable()).resolves.toBe(2);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      question: 'Which one was the house insurance?',
      currentMember: {
        id: 'alex',
        displayName: 'Alex',
        access: 'shared-adult',
      },
      currentReplyTo: {
        messageId: '39',
        actor: 'assistant',
        actorId: 'finance-assistant',
        actorDisplayName: 'Household Finance Bot',
        message: 'Prior answer.',
      },
    });
    expect(inputs[0]?.actionContext?.reserveStateChange).toBeTypeOf('function');
    expect(inputs[0]?.recentConversation).toHaveLength(16);
    expect(inputs[0]?.recentConversation?.[0]).toMatchObject({
      messageId: '25',
    });
    expect(inputs[0]?.recentConversation).toEqual(
      expect.arrayContaining([
        {
          actor: 'household',
          actorId: 'alex',
          actorDisplayName: 'Alex',
          messageId: '38',
          message: 'Was the larger Traders payment the house insurance?',
        },
      ]),
    );
    expect(inputs[0]?.recentConversation).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: 'former-household-user',
        }),
      ]),
    );
    expect(recentCompletedConversationInputs).toHaveBeenCalledWith(
      'household-finance',
      16,
      '42',
    );
    expect(inputs[0]).not.toHaveProperty('dataFreshness');
    expect(inputs[0]).not.toHaveProperty('pendingReceiptSummary');
    const householdContext = JSON.parse(
      inputs[0]?.householdContext ?? '{}',
    ) as Record<string, unknown>;
    expect(inputs[0]?.householdContext?.length).toBeLessThanOrEqual(16_000);
    expect(householdContext).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ displayName: 'Alex' }),
        expect.objectContaining({ displayName: 'Sam' }),
      ]),
      policies: {
        minimumCashBufferMinorUnits: { value: 20_000 },
      },
      obligations: expect.arrayContaining([
        expect.objectContaining({
          id: 'pine-mortgage-payment',
          name: 'Pine mortgage',
          amountMinorUnits: 146_842,
          amountCertain: true,
          cadence: 'monthly',
          priority: 'required',
        }),
      ]),
      merchantRules: expect.arrayContaining([
        expect.objectContaining({
          merchantPattern: 'Traders Insurance',
          categoryAlias: 'home-insurance',
        }),
      ]),
      transactionRules: expect.arrayContaining([
        expect.objectContaining({
          payeePattern: 'Pine',
          specialKind: 'debt-payment',
        }),
      ]),
      contextTruncated: true,
      omittedCounts: {
        obligations: expect.any(Number),
        merchantRules: expect.any(Number),
        transactionRules: expect.any(Number),
      },
    });
    const omittedCounts = householdContext.omittedCounts as Record<
      string,
      number
    >;
    expect(
      (householdContext.obligations as unknown[]).length +
        omittedCounts.obligations!,
    ).toBe(250);
    expect(
      (householdContext.merchantRules as unknown[]).length +
        omittedCounts.merchantRules!,
    ).toBe(250);
    expect(
      (householdContext.transactionRules as unknown[]).length +
        omittedCounts.transactionRules!,
    ).toBe(250);
    expect(inputs[0]?.recentConversation).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: '50',
        }),
      ]),
    );
    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'completed',
      plan: {
        schemaVersion: 'finance-agent-plan.v1',
        kind: 'finance-agent',
      },
      result: {
        schemaVersion: 'finance-agent-result.v1',
        toolCalls: ['search_transactions'],
      },
    });
    expect(sent).toEqual([
      'The larger Traders payment was $489.66 for home insurance.',
    ]);
    store.close();
  });

  it('does not enqueue a second Talk reply when the agent handled it', async () => {
    const store = new QuestionStore(':memory:');
    const talk = {
      sendReplyWithIdentity: vi.fn(async (reply: TalkReply) =>
        deliveredReply(reply),
      ),
    };
    const agent: FinanceQuestionAgent = {
      answer: vi.fn(async () => ({
        answer: 'Your Pine mortgage payment was $1,468.42 on July 10.',
        replyHandled: true,
        metadata: metadata(['read_actual', 'reply_to_talk']),
      })),
    };
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent,
      conversationHistorySource: { recentConversation: async () => [] },
      talk,
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(now),
    });
    const event = store.recordInbound(
      {
        idempotencyKey: 'question:handled-agent-reply',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '44',
        question: 'How much was the Pine payment?',
        receivedAt: now,
      },
      { enqueueAcknowledgement: false },
    ).event;

    await expect(workflow.processAvailable()).resolves.toBe(1);

    expect(agent.answer).toHaveBeenCalledOnce();
    expect(talk.sendReplyWithIdentity).not.toHaveBeenCalled();
    expect(store.claimNextOutbox(now)).toBeUndefined();
    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'completed',
      answer: 'The requested change was handled separately.',
      result: {
        schemaVersion: 'finance-agent-result.v1',
        toolCalls: ['read_actual', 'reply_to_talk'],
      },
    });
    store.close();
  });

  it('reconciles a Talk answer after delivery succeeds but outbox completion crashes', async () => {
    const store = new QuestionStore(':memory:');
    const talk = new ReconcilingTalk();
    let current = new Date(now);
    const complete = store.completeTalkReplyOutbox.bind(store);
    vi.spyOn(store, 'completeTalkReplyOutbox')
      .mockImplementationOnce(() => {
        throw new Error('simulated crash after Talk accepted the reply');
      })
      .mockImplementation((jobId, eventId, referenceId, completedAt) =>
        complete(jobId, eventId, referenceId, completedAt),
      );
    const answer = vi.fn(async () => ({
      answer: 'Your balance is available.',
      metadata: metadata(['read_actual']),
    }));
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent: { answer },
      conversationHistorySource: { recentConversation: async () => [] },
      talk,
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(current),
    });
    store.recordInbound(
      {
        idempotencyKey: 'question:crash-after-talk-delivery',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '46',
        question: 'What is my balance?',
        receivedAt: now,
      },
      { enqueueAcknowledgement: false },
    );

    await expect(workflow.processAvailable()).resolves.toBe(2);
    expect(talk.deliveries.size).toBe(1);

    current = new Date(current.valueOf() + 2_000);
    await expect(workflow.processAvailable()).resolves.toBe(1);
    expect(answer).toHaveBeenCalledOnce();
    expect(talk.calls).toBe(2);
    expect(talk.deliveries.size).toBe(1);
    store.close();
  });

  it('does not send a false failure after a durable tool handled the write', async () => {
    const store = new QuestionStore(':memory:');
    const talk = {
      sendReplyWithIdentity: vi.fn(async (reply: TalkReply) =>
        deliveredReply(reply),
      ),
    };
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent: {
        answer: async () => {
          throw new FinanceQuestionToolReplyHandledError([
            'update_household_context',
          ]);
        },
      },
      conversationHistorySource: { recentConversation: async () => [] },
      talk,
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(now),
    });
    const event = store.recordInbound(
      {
        idempotencyKey: 'question:handled-tool-failure',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '45',
        question: 'Remember that Pine is our mortgage.',
        receivedAt: now,
      },
      { enqueueAcknowledgement: false },
    ).event;

    await expect(workflow.processAvailable()).resolves.toBe(1);

    expect(talk.sendReplyWithIdentity).not.toHaveBeenCalled();
    expect(store.claimNextOutbox(now)).toBeUndefined();
    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'completed',
      answer: 'The requested change was handled separately.',
      result: {
        toolCalls: ['update_household_context'],
        replyOwnedByTool: true,
      },
    });
    store.close();
  });

  it('stops a terminal model failure without retrying or blaming Actual', async () => {
    const store = new QuestionStore(':memory:');
    const answer = vi
      .fn<FinanceQuestionAgent['answer']>()
      .mockRejectedValue(
        new XaiStructuredClientError(
          'response-incomplete',
          'request',
          undefined,
          'response-envelope',
        ),
      );
    const sent: string[] = [];
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent: { answer },
      conversationHistorySource: { recentConversation: async () => [] },
      talk: {
        sendReplyWithIdentity: async (reply) => {
          sent.push(reply.message);
          return deliveredReply(reply);
        },
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(now),
    });
    const event = store.recordInbound(
      {
        idempotencyKey: 'question:response-incomplete',
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '43',
        question: 'How much was the Pine payment?',
        receivedAt: now,
      },
      { enqueueAcknowledgement: false },
    ).event;

    await expect(workflow.processAvailable()).resolves.toBe(2);

    expect(answer).toHaveBeenCalledOnce();
    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'failed',
      errorCode: 'model-response-incomplete',
    });
    expect(store.listAudit(event.id)).toContainEqual(
      expect.objectContaining({
        action: 'question.failed',
        detail: {
          errorCode: 'model-response-incomplete',
          diagnostic: {
            source: 'xai',
            phase: 'request',
            responseStage: 'response-envelope',
          },
        },
      }),
    );
    expect(sent).toEqual([
      'I hit a problem before I could finish that. If you asked for a change, it may already be underway; otherwise nothing needs your attention. Please try again in a moment.',
    ]);
    store.close();
  });

  it('durably transcribes a voice message once and continues through the normal agent lane', async () => {
    const store = new QuestionStore(':memory:');
    const transcribe = vi.fn(async () => 'What bills are coming up?');
    const questions: string[] = [];
    const sent: string[] = [];
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent: {
        answer: async (input) => {
          questions.push(input.question);
          return {
            answer: 'Your next scheduled bill is the power bill on August 2.',
            metadata: metadata(['read_actual']),
          };
        },
      },
      voiceTranscriber: { transcribe },
      conversationHistorySource: { recentConversation: async () => [] },
      talk: {
        sendReplyWithIdentity: async (reply) => {
          sent.push(reply.message);
          return deliveredReply(reply);
        },
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(now),
    });
    const input = {
      idempotencyKey: 'question:voice-success',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '9001',
      attachment: {
        fileId: '7001',
        etag: 'voice-etag',
        sizeBytes: 1_024,
        mediaType: 'audio/mpeg' as const,
      },
      receivedAt: now,
    };
    const source = store.recordVoiceInbound(input).event;

    await expect(workflow.processAvailable()).resolves.toBe(3);

    expect(transcribe).toHaveBeenCalledOnce();
    expect(questions).toEqual(['What bills are coming up?']);
    expect(sent).toEqual([
      'Your next scheduled bill is the power bill on August 2.',
    ]);
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'transcribed',
    });
    expect(store.recordVoiceInbound(input)).toMatchObject({
      inserted: false,
      event: { id: source.id, status: 'transcribed' },
    });
    await expect(workflow.processAvailable()).resolves.toBe(0);
    expect(transcribe).toHaveBeenCalledOnce();
    store.close();
  });

  it('bounds voice transcription retries and sends one calm terminal reply', async () => {
    const store = new QuestionStore(':memory:');
    let current = new Date(now);
    const transcribe = vi.fn(async () => {
      throw new XaiSpeechToTextError('network-error');
    });
    const sent: string[] = [];
    const agent: FinanceQuestionAgent = {
      answer: async () => {
        throw new Error('agent must not run without a transcript');
      },
    };
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent,
      voiceTranscriber: { transcribe },
      talk: {
        sendReplyWithIdentity: async (reply) => {
          sent.push(reply.message);
          return deliveredReply(reply);
        },
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(current),
    });
    const input = {
      idempotencyKey: 'question:voice-failure',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '9002',
      attachment: {
        fileId: '7002',
        etag: 'voice-etag-2',
        sizeBytes: 2_048,
        mediaType: 'audio/mp4' as const,
      },
      receivedAt: now,
    };
    const source = store.recordVoiceInbound(input).event;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(workflow.processAvailable(1)).resolves.toBe(1);
      if (attempt < 5) {
        current = new Date(current.valueOf() + 2 ** attempt * 1_000);
      }
    }
    await expect(workflow.processAvailable(1)).resolves.toBe(1);

    expect(transcribe).toHaveBeenCalledTimes(5);
    expect(sent).toEqual([
      'I couldn’t finish transcribing that voice message. Please send it again or type it out, and I’ll help from there.',
    ]);
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'failed',
      errorCode: 'voice-transcription-failed',
    });
    expect(store.getInbound(source.id)).toBeUndefined();
    expect(store.getQuestionItem(source.id)).toBeUndefined();
    expect(store.listAudit(source.id)).toEqual([]);
    expect(store.recordVoiceInbound(input)).toMatchObject({
      inserted: false,
      event: { id: source.id, status: 'failed' },
    });
    await expect(workflow.processAvailable()).resolves.toBe(0);
    expect(transcribe).toHaveBeenCalledTimes(5);
    store.close();
  });

  it.each([
    [
      'a transient WebDAV search failure',
      new WebDavFileSourceError('search-failed'),
    ],
    [
      'a transient WebDAV download failure',
      new WebDavFileSourceError('download-failed'),
    ],
    [
      'a not-yet-visible WebDAV file',
      new WebDavFileSourceError('file-not-found'),
    ],
    [
      'a transient ZDR preflight network failure',
      new XaiStructuredClientError('network-error', 'preflight'),
    ],
    [
      'a transient ZDR preflight timeout',
      new XaiStructuredClientError('request-timeout', 'preflight'),
    ],
    [
      'a ZDR preflight HTTP 408',
      new XaiStructuredClientError('http-error', 'preflight', 408),
    ],
    [
      'a ZDR preflight HTTP 429',
      new XaiStructuredClientError('http-error', 'preflight', 429),
    ],
    [
      'a ZDR preflight HTTP 503',
      new XaiStructuredClientError('http-error', 'preflight', 503),
    ],
  ])('retries %s and can complete later', async (_description, failure) => {
    const store = new QuestionStore(':memory:');
    let current = new Date(now);
    const transcribe = vi
      .fn<FinanceQuestionVoiceTranscriber['transcribe']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('What bills are coming up?');
    const workflow = new FinanceQuestionWorkflow({
      store,
      agent: {
        answer: async () => {
          throw new Error('agent must not run in this bounded test');
        },
      },
      voiceTranscriber: { transcribe },
      talk: {
        sendReplyWithIdentity: async (reply) => deliveredReply(reply),
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(current),
    });
    const source = store.recordVoiceInbound({
      idempotencyKey: 'question:voice-transient',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '9004',
      attachment: {
        fileId: '7004',
        etag: 'voice-etag-4',
        sizeBytes: 4_096,
        mediaType: 'audio/mpeg',
      },
      receivedAt: now,
    }).event;

    await expect(workflow.processAvailable(1)).resolves.toBe(1);
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'received',
    });

    current = new Date(current.valueOf() + 2_000);
    await expect(workflow.processAvailable(1)).resolves.toBe(1);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'transcribed',
    });
    store.close();
  });

  it('requeues a graceful request abort without consuming an attempt or spinning', async () => {
    const store = new QuestionStore(':memory:');
    const controller = new AbortController();
    const interruptedTranscribe = vi.fn(async () => {
      controller.abort();
      throw new XaiSpeechToTextError('request-aborted');
    });
    const source = store.recordVoiceInbound({
      idempotencyKey: 'question:voice-interrupted',
      backendUrl: 'https://cloud.example.test',
      roomToken: 'household-finance',
      actorId: 'alex',
      messageId: '9005',
      attachment: {
        fileId: '7005',
        etag: 'voice-etag-5',
        sizeBytes: 5_120,
        mediaType: 'audio/mp4',
      },
      receivedAt: now,
    }).event;
    const interruptedWorkflow = new FinanceQuestionWorkflow({
      store,
      agent: {
        answer: async () => {
          throw new Error('agent must not run without a transcript');
        },
      },
      voiceTranscriber: { transcribe: interruptedTranscribe },
      talk: {
        sendReplyWithIdentity: async (reply) => deliveredReply(reply),
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      signal: controller.signal,
      now: () => new Date(now),
    });

    await expect(interruptedWorkflow.processAvailable()).resolves.toBe(0);
    await expect(interruptedWorkflow.processAvailable()).resolves.toBe(0);
    expect(interruptedTranscribe).toHaveBeenCalledOnce();
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'received',
    });

    const resumedTranscribe = vi.fn(async () => 'What bills are coming up?');
    const resumedWorkflow = new FinanceQuestionWorkflow({
      store,
      agent: {
        answer: async () => {
          throw new Error('agent must not run in this bounded test');
        },
      },
      voiceTranscriber: { transcribe: resumedTranscribe },
      talk: {
        sendReplyWithIdentity: async (reply) => deliveredReply(reply),
      },
      timeZone: 'America/Halifax',
      allowedUserIds,
      now: () => new Date(now),
    });
    await expect(resumedWorkflow.processAvailable(1)).resolves.toBe(1);
    expect(resumedTranscribe).toHaveBeenCalledOnce();
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'transcribed',
    });
    store.close();
  });

  it.each([
    [
      'missing zero-data-retention assurance',
      new XaiSpeechToTextError('zdr-required'),
      'voice-zdr-required',
    ],
    [
      'an invalid provider response',
      new XaiSpeechToTextError('invalid-response'),
      'voice-transcription-rejected',
    ],
    [
      'a non-retryable provider request',
      new XaiSpeechToTextError('http-error', 400),
      'voice-transcription-rejected',
    ],
    [
      'an unsafe WebDAV URL',
      new WebDavFileSourceError('unsafe-file-url'),
      'voice-transcription-rejected',
    ],
    [
      'a WebDAV media mismatch',
      new WebDavFileSourceError('media-type-mismatch'),
      'voice-transcription-rejected',
    ],
    [
      'an invalid ZDR preflight configuration',
      new XaiStructuredClientError('invalid-configuration', 'preflight'),
      'voice-transcription-rejected',
    ],
    [
      'an invalid ZDR preflight response',
      new XaiStructuredClientError('invalid-response', 'preflight'),
      'voice-transcription-rejected',
    ],
    [
      'a failed ZDR preflight assurance',
      new XaiStructuredClientError('zdr-required', 'preflight'),
      'voice-zdr-required',
    ],
  ])(
    'does not re-upload private audio after %s',
    async (_description, failure, expectedCode) => {
      const store = new QuestionStore(':memory:');
      const transcribe = vi.fn(async () => {
        throw failure;
      });
      const sent: string[] = [];
      const workflow = new FinanceQuestionWorkflow({
        store,
        agent: {
          answer: async () => {
            throw new Error('agent must not run without a transcript');
          },
        },
        voiceTranscriber: { transcribe },
        talk: {
          sendReplyWithIdentity: async (reply) => {
            sent.push(reply.message);
            return deliveredReply(reply);
          },
        },
        timeZone: 'America/Halifax',
        allowedUserIds,
        now: () => new Date(now),
      });
      const source = store.recordVoiceInbound({
        idempotencyKey: `question:voice-terminal:${expectedCode}`,
        backendUrl: 'https://cloud.example.test',
        roomToken: 'household-finance',
        actorId: 'alex',
        messageId: '9003',
        attachment: {
          fileId: '7003',
          etag: 'voice-etag-3',
          sizeBytes: 3_072,
          mediaType: 'audio/wav',
        },
        receivedAt: now,
      }).event;

      await expect(workflow.processAvailable()).resolves.toBe(2);

      expect(transcribe).toHaveBeenCalledOnce();
      expect(store.getVoiceInbound(source.id)).toMatchObject({
        status: 'failed',
        errorCode: expectedCode,
      });
      expect(sent).toHaveLength(1);
      await expect(workflow.processAvailable()).resolves.toBe(0);
      expect(transcribe).toHaveBeenCalledOnce();
      store.close();
    },
  );
});
