import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { QuestionStore } from '../../src/storage/question-store.js';

const now = '2026-07-28T01:00:00.000Z';

function input(
  idempotencyKey = 'question:test',
  question = 'How much did I spend on groceries?',
  roomToken = 'household-finance',
) {
  return {
    idempotencyKey,
    backendUrl: 'https://cloud.example.test',
    roomToken,
    actorId: 'alex',
    messageId: idempotencyKey,
    question,
    receivedAt: now,
  };
}

function voiceInput(idempotencyKey = 'question:voice-test') {
  return {
    idempotencyKey,
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
}

function reply(message = 'You spent CAD 100.00 on groceries.') {
  return {
    roomToken: 'household-finance',
    message,
    replyTo: 'question:test',
    referenceId: 'a'.repeat(64),
    silent: false,
  };
}

function deliverAcknowledgementAndClaimProcess(
  store: QuestionStore,
  eventId: string,
  at = now,
) {
  const acknowledgement = store.claimNextOutbox(at);
  expect(acknowledgement).toMatchObject({
    kind: 'send-finance-question-acknowledgement',
    eventId,
    attemptCount: 1,
    payload: {
      roomToken: 'household-finance',
      message: 'Got it — I’m checking Actual now.',
      replyTo: 'question:test',
      silent: false,
    },
  });
  const payload = acknowledgement?.payload as
    { referenceId?: unknown } | undefined;
  expect(payload?.referenceId).toMatch(/^[a-f0-9]{64}$/);
  store.completeTalkReplyOutbox(
    acknowledgement?.id ?? -1,
    eventId,
    String(payload?.referenceId),
    at,
  );

  const process = store.claimNextOutbox(at);
  expect(process).toMatchObject({
    kind: 'process-finance-question',
    eventId,
    attemptCount: 1,
  });
  return process;
}

describe('QuestionStore', () => {
  it('records each inbound question once and prioritizes a durable Talk acknowledgement', () => {
    const store = new QuestionStore(':memory:');

    const first = store.recordInbound(input());
    const duplicate = store.recordInbound(input());

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.event.id).toBe(first.event.id);
    expect(store.getInbound(first.event.id)).toMatchObject({
      question: 'How much did I spend on groceries?',
    });
    expect(store.getQuestionItem(first.event.id)).toMatchObject({
      status: 'received',
    });
    const acknowledgement = store.claimNextOutbox(now);
    expect(acknowledgement).toMatchObject({
      kind: 'send-finance-question-acknowledgement',
      eventId: first.event.id,
      attemptCount: 1,
      payload: {
        message: 'Got it — I’m checking Actual now.',
        replyTo: 'question:test',
      },
    });
    store.completeOutbox(acknowledgement?.id ?? -1, now);
    expect(store.claimNextOutbox(now)).toMatchObject({
      kind: 'process-finance-question',
      eventId: first.event.id,
      attemptCount: 1,
    });
    expect(store.claimNextOutbox(now)).toBeUndefined();
    store.close();
  });

  it('does not let a delayed acknowledgement block question processing', () => {
    const store = new QuestionStore(':memory:');
    const event = store.recordInbound(input()).event;
    const acknowledgement = store.claimNextOutbox(now);

    store.retryOutbox(
      acknowledgement?.id ?? -1,
      'talk-temporarily-unavailable',
      '2026-07-28T01:01:00.000Z',
    );

    expect(store.claimNextOutbox(now)).toMatchObject({
      kind: 'process-finance-question',
      eventId: event.id,
    });
    store.close();
  });

  it('durably caps distinct state-changing calls while allowing exact replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'question-write-budget-'));
    const databasePath = join(directory, 'questions.sqlite');
    try {
      const first = new QuestionStore(databasePath);
      const event = first.recordInbound(input()).event;
      expect(
        first.reserveStateChangingToolCall(
          event.id,
          'categorize_transaction',
          { selector: { b: 2, a: 1 } },
          now,
        ),
      ).toBe(true);
      expect(
        first.reserveStateChangingToolCall(
          event.id,
          'categorize_transaction',
          { selector: { a: 1, b: 2 } },
          now,
        ),
      ).toBe(true);
      for (let index = 2; index <= 5; index += 1) {
        expect(
          first.reserveStateChangingToolCall(
            event.id,
            'categorize_transaction',
            { selector: { index } },
            now,
          ),
        ).toBe(true);
      }
      first.close();

      const restarted = new QuestionStore(databasePath);
      expect(
        restarted.reserveStateChangingToolCall(
          event.id,
          'categorize_transaction',
          { selector: { a: 1, b: 2 } },
          now,
        ),
      ).toBe(true);
      expect(
        restarted.reserveStateChangingToolCall(
          event.id,
          'categorize_transaction',
          { selector: { index: 6 } },
          now,
        ),
      ).toBe(false);
      restarted.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts at most 2000 normalized question characters', () => {
    const store = new QuestionStore(':memory:');

    expect(() =>
      store.recordInbound(input('question:maximum', 'x'.repeat(2_000))),
    ).not.toThrow();
    expect(() =>
      store.recordInbound(input('question:too-long', 'x'.repeat(2_001))),
    ).toThrowError(RangeError);
    expect(() =>
      store.recordInbound(input('question:empty', '   ')),
    ).toThrowError(RangeError);
    store.close();
  });

  it('atomically stores a completed turn and enqueues its Talk reply', () => {
    const store = new QuestionStore(':memory:');
    const event = store.recordInbound(input()).event;
    const process = deliverAcknowledgementAndClaimProcess(store, event.id);

    store.completeQuestionAndEnqueueReply(
      event.id,
      {
        kind: 'category-spend',
        categoryQuery: 'Groceries',
        startDate: '2026-07-01',
        endDate: '2026-07-28',
      },
      { totalMinor: 10_000, currency: 'CAD' },
      {
        provider: 'xai',
        requestedModel: 'grok-4.5',
        resolvedModel: 'grok-4.5',
        zeroDataRetention: true,
      },
      'You spent CAD 100.00 on groceries.',
      reply(),
      'question-reply:test',
      now,
    );

    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'completed',
      plan: { kind: 'category-spend' },
      result: { totalMinor: 10_000, currency: 'CAD' },
      modelMetadata: {
        provider: 'xai',
        zeroDataRetention: true,
      },
      answer: 'You spent CAD 100.00 on groceries.',
    });
    store.completeOutbox(process?.id ?? -1, now);
    expect(store.claimNextOutbox(now)).toMatchObject({
      kind: 'send-finance-question-talk-reply',
      eventId: event.id,
    });
    expect(store.listAudit(event.id).map((entry) => entry.action)).toEqual([
      'question.received',
      'question.acknowledgement-queued',
      'question.talk-reply-delivered',
      'question.completed',
    ]);
    store.close();
  });

  it('atomically completes a handled reply without a Talk reply outbox', () => {
    const store = new QuestionStore(':memory:');
    const event = store.recordInbound(input(), {
      enqueueAcknowledgement: false,
    }).event;
    const process = store.claimNextOutbox(now);
    expect(process).toMatchObject({
      kind: 'process-finance-question',
      eventId: event.id,
    });

    store.completeQuestionWithoutReply(
      process?.id ?? -1,
      event.id,
      {
        schemaVersion: 'finance-agent-plan.v1',
        kind: 'finance-agent',
      },
      {
        schemaVersion: 'finance-agent-result.v1',
        toolCalls: ['read_actual', 'reply_to_talk'],
      },
      {
        provider: 'xai',
        zeroDataRetention: true,
      },
      'You spent CAD 100.00 on groceries.',
      now,
    );

    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'completed',
      answer: 'You spent CAD 100.00 on groceries.',
    });
    expect(store.claimNextOutbox(now)).toBeUndefined();
    expect(store.listAudit(event.id).map((entry) => entry.action)).toEqual([
      'question.received',
      'question.completed',
    ]);
    store.close();
  });

  it('rolls handled completion back when its processing job is not claimed', () => {
    const store = new QuestionStore(':memory:');
    const event = store.recordInbound(input(), {
      enqueueAcknowledgement: false,
    }).event;
    const process = store.claimNextOutbox(now);

    expect(() =>
      store.completeQuestionWithoutReply(
        (process?.id ?? 0) + 1,
        event.id,
        {},
        {},
        {},
        'This must roll back.',
        now,
      ),
    ).toThrowError(/processing outbox job is not claimed/);
    const item = store.getQuestionItem(event.id);
    expect(item).toMatchObject({ status: 'received' });
    expect(item?.answer).toBeUndefined();
    store.close();
  });

  it('rolls completion back when the bounded answer cannot be persisted', () => {
    const store = new QuestionStore(':memory:');
    const event = store.recordInbound(input()).event;

    expect(() =>
      store.completeQuestionAndEnqueueReply(
        event.id,
        {},
        {},
        {},
        'x'.repeat(2_001),
        reply(),
        'question-reply:test',
        now,
      ),
    ).toThrowError(RangeError);
    expect(store.getQuestionItem(event.id)).toMatchObject({
      status: 'received',
    });
    store.close();
  });

  it('returns recent completed conversation inputs in conversation order', () => {
    const store = new QuestionStore(':memory:');
    for (let index = 0; index < 8; index += 1) {
      const timestamp = `2026-07-28T01:00:0${String(index)}.000Z`;
      const event = store.recordInbound({
        ...input(`question:${String(index)}`, `Question ${String(index)}`),
        messageId: String(index + 1),
        receivedAt: timestamp,
      }).event;
      store.completeQuestionAndEnqueueReply(
        event.id,
        { kind: 'unsupported', message: 'test' },
        {},
        {},
        `Answer ${String(index)}`,
        reply(`Answer ${String(index)}`),
        `question-reply:${String(index)}`,
        timestamp,
      );
    }
    const otherRoom = store.recordInbound({
      ...input('question:other', 'Other room?', 'other-room'),
      messageId: '6',
    }).event;
    store.completeQuestionAndEnqueueReply(
      otherRoom.id,
      {},
      {},
      {},
      'Other answer',
      { ...reply('Other answer'), roomToken: 'other-room' },
      'question-reply:other',
      now,
    );

    expect(
      store.recentCompletedConversationInputs('household-finance', 2, '7'),
    ).toEqual([
      {
        actorId: 'alex',
        messageId: '6',
        question: 'Question 5',
        receivedAt: '2026-07-28T01:00:05.000Z',
      },
      {
        actorId: 'alex',
        messageId: '7',
        question: 'Question 6',
        receivedAt: '2026-07-28T01:00:06.000Z',
      },
    ]);
    expect(() =>
      store.recentCompletedConversationInputs('household-finance', 17, '7'),
    ).toThrowError(RangeError);
    expect(() =>
      store.recentCompletedConversationInputs(
        'household-finance',
        2,
        'not-a-talk-message',
      ),
    ).toThrowError(RangeError);
    store.close();
  });

  it('retries and records delivery or dead-letter outcomes for Talk replies', () => {
    const store = new QuestionStore(':memory:');
    const event = store.recordInbound(input()).event;
    const process = deliverAcknowledgementAndClaimProcess(store, event.id);
    store.completeQuestionAndEnqueueReply(
      event.id,
      {},
      {},
      {},
      'Answer',
      reply('Answer'),
      'question-reply:test',
      now,
    );
    store.completeOutbox(process?.id ?? -1, now);

    const firstReply = store.claimNextOutbox(now);
    store.retryOutbox(
      firstReply?.id ?? -1,
      'temporary',
      '2026-07-28T01:01:00.000Z',
    );
    expect(store.claimNextOutbox(now)).toBeUndefined();
    const retriedReply = store.claimNextOutbox('2026-07-28T01:01:00.000Z');
    expect(retriedReply?.attemptCount).toBe(2);
    store.completeTalkReplyOutbox(
      retriedReply?.id ?? -1,
      event.id,
      'a'.repeat(64),
      '2026-07-28T01:01:00.000Z',
    );
    expect(store.listAudit(event.id).at(-1)?.action).toBe(
      'question.talk-reply-delivered',
    );
    store.close();
  });

  it('persists queued work and recovers a claimed job after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'question-store-test-'));
    const databasePath = join(directory, 'question.sqlite');
    try {
      const firstStore = new QuestionStore(databasePath);
      const event = firstStore.recordInbound(input()).event;
      const acknowledgement = firstStore.claimNextOutbox(now);
      firstStore.completeOutbox(acknowledgement?.id ?? -1, now);
      expect(firstStore.claimNextOutbox(now)).toMatchObject({
        kind: 'process-finance-question',
        eventId: event.id,
      });
      firstStore.close();

      const restartedStore = new QuestionStore(databasePath);
      expect(restartedStore.recoverInterruptedOutbox(now)).toBe(1);
      expect(restartedStore.claimNextOutbox(now)).toMatchObject({
        kind: 'process-finance-question',
        eventId: event.id,
        attemptCount: 2,
      });
      expect(restartedStore.recordInbound(input())).toMatchObject({
        inserted: false,
        event: { id: event.id },
      });
      restartedStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records a duplicate voice webhook once without a second transcription job', () => {
    const store = new QuestionStore(':memory:');

    const first = store.recordVoiceInbound(voiceInput());
    const duplicate = store.recordVoiceInbound(voiceInput());

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({
      inserted: false,
      event: {
        id: first.event.id,
        status: 'received',
        attachment: {
          fileId: '7001',
          mediaType: 'audio/mpeg',
        },
      },
    });
    expect(store.claimNextVoiceOutbox(now)).toMatchObject({
      kind: 'transcribe-finance-question-voice',
      sourceId: first.event.id,
      attemptCount: 1,
    });
    expect(store.claimNextVoiceOutbox(now)).toBeUndefined();
    store.close();
  });

  it('requeues an interrupted voice job without consuming its attempt', () => {
    const store = new QuestionStore(':memory:');
    const source = store.recordVoiceInbound(voiceInput()).event;
    const first = store.claimNextVoiceOutbox(now);
    expect(first).toMatchObject({
      kind: 'transcribe-finance-question-voice',
      sourceId: source.id,
      attemptCount: 1,
    });

    store.requeueVoiceOutboxWithoutAttempt(
      first?.id ?? -1,
      'voice-transcription-interrupted',
      now,
    );
    expect(store.claimNextVoiceOutbox(now)).toMatchObject({
      id: first?.id,
      kind: 'transcribe-finance-question-voice',
      sourceId: source.id,
      attemptCount: 1,
    });
    store.close();
  });

  it('recovers interrupted voice transcription and atomically opens the normal question lane', () => {
    const directory = mkdtempSync(join(tmpdir(), 'question-voice-store-'));
    const databasePath = join(directory, 'question.sqlite');
    try {
      const firstStore = new QuestionStore(databasePath);
      const source = firstStore.recordVoiceInbound(voiceInput()).event;
      expect(firstStore.claimNextVoiceOutbox(now)).toMatchObject({
        kind: 'transcribe-finance-question-voice',
        sourceId: source.id,
        attemptCount: 1,
      });
      firstStore.close();

      const restartedStore = new QuestionStore(databasePath);
      expect(restartedStore.recoverInterruptedOutbox(now)).toBe(1);
      const recovered = restartedStore.claimNextVoiceOutbox(now);
      expect(recovered).toMatchObject({
        kind: 'transcribe-finance-question-voice',
        sourceId: source.id,
        attemptCount: 2,
      });

      const event = restartedStore.completeVoiceTranscription(
        recovered?.id ?? -1,
        source.id,
        'How much did we spend on groceries?',
        now,
      );

      expect(event).toMatchObject({
        id: source.id,
        question: 'How much did we spend on groceries?',
      });
      expect(restartedStore.getVoiceInbound(source.id)).toMatchObject({
        status: 'transcribed',
        completedAt: now,
      });
      expect(restartedStore.getQuestionItem(source.id)).toMatchObject({
        status: 'received',
      });
      expect(restartedStore.claimNextOutbox(now)).toMatchObject({
        kind: 'process-finance-question',
        eventId: source.id,
      });
      expect(
        restartedStore.listAudit(source.id).map((entry) => ({
          action: entry.action,
          detail: entry.detail,
        })),
      ).toEqual([
        { action: 'question.received', detail: {} },
        { action: 'question.voice-transcribed', detail: {} },
      ]);
      restartedStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically reconciles a voice job transcribed by a rolled-back service', () => {
    const store = new QuestionStore(':memory:');
    const source = store.recordVoiceInbound(voiceInput()).event;
    const voiceJob = store.claimNextVoiceOutbox(now);
    const existingQuestion = store.recordInbound(
      {
        ...input(
          voiceInput().idempotencyKey,
          'What bills are coming up?',
          voiceInput().roomToken,
        ),
        backendUrl: voiceInput().backendUrl,
        actorId: voiceInput().actorId,
        messageId: voiceInput().messageId,
      },
      { enqueueAcknowledgement: false },
    ).event;

    expect(
      store.completeVoiceTranscription(
        voiceJob?.id ?? -1,
        source.id,
        'Which bills are coming up?',
        now,
      ),
    ).toEqual(existingQuestion);
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'transcribed',
      completedAt: now,
    });
    expect(store.getInbound(source.id)).toBeUndefined();
    expect(store.getQuestionItem(source.id)).toBeUndefined();
    expect(store.claimNextVoiceOutbox(now)).toBeUndefined();
    expect(store.claimNextOutbox(now)).toMatchObject({
      kind: 'process-finance-question',
      eventId: existingQuestion.id,
    });
    expect(store.claimNextOutbox(now)).toBeUndefined();
    expect(
      store.listAudit(existingQuestion.id).map((entry) => entry.action),
    ).toEqual(['question.received', 'question.voice-transcribed']);
    store.close();
  });

  it('rejects a same-key voice reconciliation with a different message identity', () => {
    const store = new QuestionStore(':memory:');
    const source = store.recordVoiceInbound(voiceInput()).event;
    const voiceJob = store.claimNextVoiceOutbox(now);
    store.recordInbound(
      {
        ...input(
          voiceInput().idempotencyKey,
          'What bills are coming up?',
          voiceInput().roomToken,
        ),
        backendUrl: voiceInput().backendUrl,
        actorId: 'sam',
        messageId: voiceInput().messageId,
      },
      { enqueueAcknowledgement: false },
    );

    expect(() =>
      store.completeVoiceTranscription(
        voiceJob?.id ?? -1,
        source.id,
        'What bills are coming up?',
        now,
      ),
    ).toThrowError(/conflicts with an existing finance question/u);
    expect(store.getVoiceInbound(source.id)).toMatchObject({
      status: 'received',
    });
    store.close();
  });
});
