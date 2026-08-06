import { describe, expect, it } from 'vitest';

import {
  createApprovalDecision,
  parseApprovalDecisionText,
} from '../../src/approval/index.js';

describe('approval decisions', () => {
  it('recognizes only exact normalized approve and reject replies', () => {
    expect(parseApprovalDecisionText('approve')).toBe('approve');
    expect(parseApprovalDecisionText('  APPROVE\n')).toBe('approve');
    expect(parseApprovalDecisionText('\treject ')).toBe('reject');

    for (const message of [
      '',
      'approved',
      'approve.',
      'approve please',
      '!approve',
      'yes',
      '**approve**',
    ]) {
      expect(parseApprovalDecisionText(message)).toBeUndefined();
    }
  });

  it('creates a replay-stable event bound to the approval and proposal', () => {
    const input = {
      backendUrl: 'https://cloud.example.test',
      roomToken: 'private-finance-room',
      approverId: 'alex',
      inboundMessageId: '1702',
      proposalBotId: 'bots/bot-0123456789abcdef',
      proposalMessageId: '1701',
      proposalMessageText: 'Example Market — CAD 17.25',
      decision: 'approve' as const,
    };

    const first = createApprovalDecision(input);
    const replay = createApprovalDecision(input);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      kind: 'approval-decision',
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      ...input,
    });

    expect(
      createApprovalDecision({
        ...input,
        decision: 'reject',
      }).idempotencyKey,
    ).not.toBe(first.idempotencyKey);
    expect(
      createApprovalDecision({
        ...input,
        proposalMessageId: 'different-proposal',
      }).idempotencyKey,
    ).not.toBe(first.idempotencyKey);
    expect(
      createApprovalDecision({
        ...input,
        approverId: 'sam',
      }).idempotencyKey,
    ).not.toBe(first.idempotencyKey);
  });
});
