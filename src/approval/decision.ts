import { createHash } from 'node:crypto';

export type ApprovalDecisionValue = 'approve' | 'reject';

export interface ApprovalDecision {
  kind: 'approval-decision';
  idempotencyKey: string;
  backendUrl: string;
  roomToken: string;
  approverId: string;
  inboundMessageId: string;
  proposalBotId: string;
  proposalMessageId: string;
  proposalMessageText: string;
  decision: ApprovalDecisionValue;
}

export interface CreateApprovalDecisionInput {
  backendUrl: string;
  roomToken: string;
  approverId: string;
  inboundMessageId: string;
  proposalBotId: string;
  proposalMessageId: string;
  proposalMessageText: string;
  decision: ApprovalDecisionValue;
}

export function parseApprovalDecisionText(
  message: string,
): ApprovalDecisionValue | undefined {
  const normalized = message.trim().toLowerCase();
  if (normalized === 'approve' || normalized === 'reject') {
    return normalized;
  }
  return undefined;
}

export function createApprovalDecision(
  input: CreateApprovalDecisionInput,
): ApprovalDecision {
  const idempotencyKey = createHash('sha256')
    .update('nextcloud-talk-approval-decision-v1\0')
    .update(input.backendUrl)
    .update('\0')
    .update(input.roomToken)
    .update('\0')
    .update(input.approverId)
    .update('\0')
    .update(input.inboundMessageId)
    .update('\0')
    .update(input.proposalBotId)
    .update('\0')
    .update(input.proposalMessageId)
    .update('\0')
    .update(input.proposalMessageText)
    .update('\0')
    .update(input.decision)
    .digest('hex');

  return {
    kind: 'approval-decision',
    idempotencyKey,
    backendUrl: input.backendUrl,
    roomToken: input.roomToken,
    approverId: input.approverId,
    inboundMessageId: input.inboundMessageId,
    proposalBotId: input.proposalBotId,
    proposalMessageId: input.proposalMessageId,
    proposalMessageText: input.proposalMessageText,
    decision: input.decision,
  };
}
