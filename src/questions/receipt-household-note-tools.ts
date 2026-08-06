import type { ReceiptRecordPublicationWorkflow } from '../receipts/record-projection.js';
import type { AttachmentShadowStore } from '../storage/attachment-shadow-store.js';
import { focusedReceiptAttachments } from './receipt-discard-tools.js';
import type {
  FinanceQuestionAdditionalTool,
  FinanceQuestionAgentInput,
} from './xai-finance-agent.js';

export interface ReceiptHouseholdNoteToolOptions {
  readonly attachments: Pick<
    AttachmentShadowStore,
    'findReceiptByIdempotencyKey' | 'findReceiptsByRoomMessage'
  >;
  readonly records: Pick<
    ReceiptRecordPublicationWorkflow,
    'appendHouseholdNote' | 'resolveCanonicalReceiptId'
  >;
  readonly input: FinanceQuestionAgentInput;
}

export function receiptHouseholdNoteTool(
  options: ReceiptHouseholdNoteToolOptions,
): FinanceQuestionAdditionalTool {
  return {
    name: 'remember_receipt_note',
    description:
      'Save the exact final authenticated message as a household purpose or correction with the canonical receipt it replies to, such as “this was for a birthday present.” Later-authored clear corrections take precedence over earlier notes. Call this only when the final message itself explicitly states the note; never infer one from prior conversation, receipt text, or ledger data.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    stateChanging: true,
    execute: async (untrusted) => {
      if (
        untrusted === null ||
        typeof untrusted !== 'object' ||
        Array.isArray(untrusted) ||
        Object.keys(untrusted).length !== 0
      ) {
        return {
          status: 'no-change',
          message: 'That receipt note was not clear, so nothing changed.',
        };
      }
      const context = options.input.actionContext;
      if (context === undefined) {
        return {
          status: 'no-change',
          message: 'I could not safely identify who asked for that change.',
        };
      }
      const receipts = focusedReceiptAttachments(options);
      if (receipts.length === 0) {
        return {
          status: 'no-change',
          message:
            'Reply directly to the receipt or its bot reply, then tell me what it was for.',
        };
      }
      const receiptIds = receipts.map((receipt) =>
        options.records.resolveCanonicalReceiptId({
          roomToken: receipt.event.roomToken,
          messageId: receipt.event.messageId,
          nextcloudFileId: receipt.event.attachment.fileId,
          sourceSha256: receipt.shadow.sourceSha256,
        }),
      );
      const uniqueReceiptIds = new Set(
        receiptIds.filter((receiptId): receiptId is string =>
          Boolean(receiptId),
        ),
      );
      if (
        uniqueReceiptIds.size !== 1 ||
        receiptIds.some((receiptId) => receiptId === undefined)
      ) {
        return {
          status: 'no-change',
          message:
            'That message contains more than one receipt, so I could not safely save the note. Reply to one receipt by itself.',
        };
      }
      const result = options.records.appendHouseholdNote(
        [...uniqueReceiptIds][0]!,
        {
          text: context.message,
          receivedAt: context.receivedAt,
          talk: {
            roomToken: context.roomToken,
            actorId: context.actorId,
            messageId: context.messageId,
          },
        },
      );
      switch (result.status) {
        case 'recorded':
          return {
            status: 'saved',
            message: 'I saved that note with the receipt.',
          };
        case 'unchanged':
          return {
            status: 'saved',
            message: 'That note is already saved with the receipt.',
          };
        case 'stale':
          return {
            status: 'no-change',
            message:
              'I left that older note out because a newer receipt update is already saved.',
          };
        case 'conflict':
          return {
            status: 'no-change',
            message:
              'That message conflicts with a note already saved from the same reply, so I left the receipt unchanged.',
          };
        case 'blocked':
          return {
            status: 'pending',
            message:
              'That receipt is still being saved. Try the note again in a moment.',
          };
        case 'not-found':
          return {
            status: 'no-change',
            message: 'I could not find that saved receipt, so nothing changed.',
          };
      }
    },
  };
}
