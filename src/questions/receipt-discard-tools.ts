import type {
  AttachmentShadowStore,
  ReceiptAttachmentReference,
} from '../storage/attachment-shadow-store.js';
import type { ReceiptCategorizationStore } from '../storage/receipt-categorization-store.js';
import type { ReceiptMatchStore } from '../storage/receipt-match-store.js';
import type { ReceiptRecordPublicationWorkflow } from '../receipts/record-projection.js';
import type {
  FinanceAgentConversationTurn,
  FinanceQuestionAdditionalTool,
  FinanceQuestionAgentInput,
} from './xai-finance-agent.js';

const MAXIMUM_REPLY_ANCESTRY_DEPTH = 8;

export interface ReceiptIgnoreToolOptions {
  readonly attachments: Pick<
    AttachmentShadowStore,
    | 'findReceiptByIdempotencyKey'
    | 'findReceiptsByRoomMessage'
    | 'ignoreReceipt'
  >;
  readonly categorizations: Pick<ReceiptCategorizationStore, 'ignoreReceipt'>;
  readonly matches: Pick<ReceiptMatchStore, 'getReceipt' | 'ignoreReceipt'>;
  readonly records: Pick<
    ReceiptRecordPublicationWorkflow,
    'resolveCanonicalReceiptId' | 'discard' | 'removeSource'
  >;
  readonly input: FinanceQuestionAgentInput;
}

export interface ReceiptFocusOptions {
  readonly attachments: Pick<
    AttachmentShadowStore,
    'findReceiptByIdempotencyKey' | 'findReceiptsByRoomMessage'
  >;
  readonly input: FinanceQuestionAgentInput;
}

function parentMessageId(
  turn: FinanceAgentConversationTurn | undefined,
): string | undefined {
  return turn?.parentMessageId ?? turn?.replyTo?.messageId;
}

export function receiptReplyAncestryMessageIds(
  input: FinanceQuestionAgentInput,
): readonly string[] {
  const firstMessageId = input.currentReplyTo?.messageId;
  if (firstMessageId === undefined) return [];
  const turnsByMessageId = new Map(
    (input.recentConversation ?? []).flatMap((turn) =>
      turn.messageId === undefined ? [] : [[turn.messageId, turn] as const],
    ),
  );
  const messageIds: string[] = [];
  const seen = new Set<string>();
  let messageId: string | undefined = firstMessageId;
  for (
    let depth = 0;
    depth < MAXIMUM_REPLY_ANCESTRY_DEPTH && messageId !== undefined;
    depth += 1
  ) {
    if (seen.has(messageId)) break;
    seen.add(messageId);
    messageIds.push(messageId);
    messageId = parentMessageId(turnsByMessageId.get(messageId));
  }
  return messageIds;
}

export function focusedReceiptAttachments(
  options: ReceiptFocusOptions,
  scope?: 'picture' | 'receipt',
): readonly ReceiptAttachmentReference[] {
  const actionContext = options.input.actionContext;
  if (actionContext === undefined) {
    return [];
  }
  const current = options.attachments.findReceiptByIdempotencyKey(
    actionContext.idempotencyKey,
  );
  if (
    current !== undefined &&
    current.event.roomToken === actionContext.roomToken &&
    current.event.actorId === actionContext.actorId &&
    current.event.messageId === actionContext.messageId
  ) {
    if (scope === 'picture') {
      return [current];
    }
    const sameMessage = options.attachments.findReceiptsByRoomMessage(
      actionContext.roomToken,
      actionContext.messageId,
    );
    return sameMessage.length === 0 ? [current] : sameMessage;
  }
  for (const messageId of receiptReplyAncestryMessageIds(options.input)) {
    const receipts = options.attachments.findReceiptsByRoomMessage(
      actionContext.roomToken,
      messageId,
    );
    if (receipts.length > 0) {
      return receipts;
    }
  }
  return [];
}

export function receiptIgnoreTool(
  options: ReceiptIgnoreToolOptions,
): FinanceQuestionAdditionalTool {
  return {
    name: 'ignore_receipt',
    description:
      'Stop using either one bad receipt picture or the entire receipt attached to the current turn or identified by its reply chain. Use scope "picture" only when the household clearly refers to one image or page; use "receipt" when they ask to discard the purchase record. This preserves archived originals and does not delete files.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['picture', 'receipt'] },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    stateChanging: true,
    execute: async (untrusted) => {
      if (
        untrusted === null ||
        typeof untrusted !== 'object' ||
        Array.isArray(untrusted) ||
        Object.keys(untrusted).length !== 1 ||
        !('scope' in untrusted) ||
        (untrusted.scope !== 'picture' && untrusted.scope !== 'receipt')
      ) {
        return { status: 'no-change', message: 'That request was not clear.' };
      }
      const context = options.input.actionContext;
      if (context === undefined) {
        return {
          status: 'no-change',
          message: 'I could not safely identify who asked for that change.',
        };
      }
      const receipts = focusedReceiptAttachments(options, untrusted.scope);
      if (receipts.length === 0) {
        return {
          status: 'no-change',
          message:
            'Reply directly to the receipt picture and say “ignore this receipt.”',
        };
      }

      const canonicalRecordIds = receipts.map((receipt) =>
        options.records.resolveCanonicalReceiptId({
          roomToken: receipt.event.roomToken,
          messageId: receipt.event.messageId,
          nextcloudFileId: receipt.event.attachment.fileId,
          sourceSha256: receipt.shadow.sourceSha256,
        }),
      );
      const uniqueCanonicalIds = new Set(
        canonicalRecordIds.filter(
          (receiptId): receiptId is string => receiptId !== undefined,
        ),
      );
      const hasUnresolvedReceipt = canonicalRecordIds.some(
        (receiptId) => receiptId === undefined,
      );
      const unresolvedSingle =
        receipts.length === 1 && canonicalRecordIds[0] === undefined;
      if (
        (receipts.length > 1 && hasUnresolvedReceipt) ||
        (!unresolvedSingle && uniqueCanonicalIds.size !== 1)
      ) {
        return {
          status: 'no-change',
          message:
            receipts.length > 1 && hasUnresolvedReceipt
              ? 'One or more pictures are still being read, so I cannot safely tell whether they are one receipt. Try again in a moment, or send the receipt you want ignored by itself.'
              : 'That message contains more than one receipt, so I cannot safely tell which one you mean. Send the one you want ignored by itself, then reply to it.',
        };
      }
      if (untrusted.scope === 'picture' && receipts.length !== 1) {
        return {
          status: 'no-change',
          message:
            'Those pictures belong to one receipt, but I cannot tell which page you mean. Send the bad picture by itself, then reply to it.',
        };
      }

      const receipt = receipts[0]!;
      const canonicalRecordId = unresolvedSingle
        ? undefined
        : [...uniqueCanonicalIds][0]!;
      const canonicalEventId = canonicalRecordId ?? receipt.event.id;
      const canonicalCommon = {
        eventId: canonicalEventId,
        roomToken: context.roomToken,
        actorId: context.actorId,
        inboundMessageId: context.messageId,
        ignoredAt: context.receivedAt,
      };

      if (untrusted.scope === 'picture') {
        if (receipt.shadow.sourceSha256 === undefined) {
          return {
            status: 'no-change',
            message:
              'That picture is still being read, so I cannot safely remove it yet. Try again in a moment.',
          };
        }
        if (canonicalRecordId === undefined) {
          options.matches.ignoreReceipt({
            receiptId: canonicalEventId,
            actorId: context.actorId,
            inboundMessageId: context.messageId,
            ignoredAt: context.receivedAt,
          });
          options.categorizations.ignoreReceipt({
            ...canonicalCommon,
            eventId: receipt.event.id,
          });
          options.attachments.ignoreReceipt({
            ...canonicalCommon,
            eventId: receipt.event.id,
          });
          return {
            status: 'changed',
            message:
              'Done — I stopped using that picture. The archived original is still there if it is ever needed.',
          };
        }
        const match = options.matches.getReceipt(canonicalEventId);
        if (match !== undefined && match.status !== 'applied') {
          return {
            status: 'no-change',
            message:
              'That receipt is still being matched or updated, so I cannot safely change its pictures yet. Try again in a moment.',
          };
        }
        const sourceRemoval = options.records.removeSource(
          canonicalEventId,
          {
            roomToken: receipt.event.roomToken,
            messageId: receipt.event.messageId,
            nextcloudFileId: receipt.event.attachment.fileId,
            sourceSha256: receipt.shadow.sourceSha256,
          },
          context.receivedAt,
        );
        if (sourceRemoval.status === 'not-found') {
          return {
            status: 'no-change',
            message: 'I could not find that saved receipt, so nothing changed.',
          };
        }
        if (sourceRemoval.status === 'blocked') {
          if (sourceRemoval.reason === 'source-not-found') {
            options.attachments.ignoreReceipt({
              ...canonicalCommon,
              eventId: receipt.event.id,
            });
            return {
              status: 'changed',
              message:
                'Done — I ignored that extra picture. The saved receipt is unchanged.',
            };
          }
          return {
            status: 'no-change',
            message:
              sourceRemoval.reason === 'prior-write-pending'
                ? 'That receipt is still being saved. Try removing the picture again in a moment.'
                : 'I could not safely rebuild the receipt without that picture, so I left it alone.',
          };
        }
        const attachmentResult = options.attachments.ignoreReceipt({
          ...canonicalCommon,
          eventId: receipt.event.id,
        });
        if (sourceRemoval.status === 'recorded') {
          return {
            status: 'changed',
            message:
              attachmentResult.status === 'still-processing'
                ? 'I removed that picture from the saved receipt. Its current read may finish, but the other pictures remain in use.'
                : 'Done — I removed that picture from the saved receipt and kept the other pictures.',
          };
        }
        options.categorizations.ignoreReceipt(canonicalCommon);
        const matchResult = options.matches.ignoreReceipt({
          receiptId: canonicalEventId,
          actorId: context.actorId,
          inboundMessageId: context.messageId,
          ignoredAt: context.receivedAt,
        });
        return {
          status: 'changed',
          message:
            matchResult.status === 'already-applied'
              ? 'Done — that was the only picture, so I stopped using the receipt. I left the transaction exactly as it was.'
              : 'Done — that was the only picture, so I stopped using the receipt. The archived picture is still there if it is ever needed.',
        };
      }

      const matchResult = options.matches.ignoreReceipt({
        receiptId: canonicalEventId,
        actorId: context.actorId,
        inboundMessageId: context.messageId,
        ignoredAt: context.receivedAt,
      });
      if (matchResult.status === 'still-processing') {
        return {
          status: 'no-change',
          message:
            'That receipt is already being applied, so I cannot safely stop it mid-update. Try again in a moment; once it finishes I can stop using the receipt without undoing the transaction.',
        };
      }

      const canonicalDiscard =
        canonicalRecordId === undefined
          ? undefined
          : options.records.discard(canonicalRecordId, context.receivedAt);

      const categorizationResult =
        options.categorizations.ignoreReceipt(canonicalCommon);
      const attachmentResults = receipts.map((focused) =>
        options.attachments.ignoreReceipt({
          ...canonicalCommon,
          eventId: focused.event.id,
        }),
      );
      if (
        categorizationResult.status === 'still-processing' ||
        attachmentResults.some((result) => result.status === 'still-processing')
      ) {
        return {
          status: 'changed',
          message:
            'I stopped that receipt from matching. Its current read may finish, but it will not update Actual.',
        };
      }
      if (canonicalDiscard?.status === 'blocked') {
        return {
          status: 'changed',
          message:
            'I stopped using that receipt here, but I could not update the saved receipt yet. The transaction and archived picture are unchanged.',
        };
      }
      if (matchResult.status === 'already-applied') {
        return {
          status: 'changed',
          message:
            'Done — I will stop using that receipt, but I left the transaction exactly as it was. The archived picture is still there if it is ever needed.',
        };
      }
      return {
        status: 'changed',
        message:
          'Done — I will ignore that receipt. The archived picture is still there if it is ever needed.',
      };
    },
  };
}
