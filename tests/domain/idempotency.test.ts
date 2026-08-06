import { describe, expect, it } from 'vitest';

import {
  createQuestionTalkReplyReferenceId,
  createReceiptDocumentIdempotencyKey,
  createStableIdempotencyKey,
} from '../../src/domain/idempotency.js';

describe('idempotency keys', () => {
  it('is stable regardless of object property insertion order', () => {
    const first = createStableIdempotencyKey('test-operation', {
      beta: 'two',
      alpha: 'one',
    });
    const second = createStableIdempotencyKey('test-operation', {
      alpha: 'one',
      beta: 'two',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^test-operation:v1:[a-f0-9]{64}$/);
  });

  it('deduplicates exact source documents independently of message identity', () => {
    const sourceSha256 = 'c'.repeat(64);

    expect(createReceiptDocumentIdempotencyKey(sourceSha256)).toBe(
      createReceiptDocumentIdempotencyKey(sourceSha256),
    );
    expect(createReceiptDocumentIdempotencyKey(sourceSha256)).not.toBe(
      createReceiptDocumentIdempotencyKey('d'.repeat(64)),
    );
  });

  it('derives separate stable identities for question replies', () => {
    const answered = createQuestionTalkReplyReferenceId(
      'question-event-key',
      'answered',
    );
    const failed = createQuestionTalkReplyReferenceId(
      'question-event-key',
      'failed',
    );

    expect(answered).toMatch(/^[a-f0-9]{64}$/);
    expect(answered).toBe(
      createQuestionTalkReplyReferenceId('question-event-key', 'answered'),
    );
    expect(failed).not.toBe(answered);
  });
});
