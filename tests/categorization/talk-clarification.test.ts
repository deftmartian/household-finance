import { describe, expect, it, vi } from 'vitest';

import {
  ReceiptMatchAmbiguityTalkWorker,
  TalkClarificationHandler,
  exactTaxonomyCategory,
  type CategoryTaxonomy,
} from '../../src/categorization/index.js';
import {
  ReceiptCategorizationClarificationNotApplicableError,
  type ReceiptCategorizationSource,
} from '../../src/storage/index.js';
import {
  appendFinanceInteractionReference,
  type TalkBotReply,
} from '../../src/talk/index.js';

const botActorId = `bots/bot-${'a'.repeat(40)}`;
const now = '2026-07-28T01:10:00.000Z';

const taxonomy: CategoryTaxonomy = {
  schemaVersion: 'household-category-taxonomy.v1',
  currency: 'CAD',
  categories: [
    {
      alias: 'groceries',
      name: 'Groceries',
      description: 'Food bought for home.',
      kind: 'expense',
      modelSelectable: true,
    },
    {
      alias: 'household-income',
      name: 'Household Income',
      description: 'Employment and household income.',
      kind: 'income',
      modelSelectable: true,
    },
  ],
};

function botReply(
  kind: 'transaction-category' | 'receipt-category' | 'receipt-match',
  message: string,
): TalkBotReply {
  return {
    kind: 'bot-reply',
    idempotencyKey: 'b'.repeat(64),
    backendUrl: 'https://cloud.example.test',
    roomToken: 'household-finance',
    actorId: 'alex',
    messageId: '3002',
    message,
    parentBotId: botActorId,
    parentMessageId: '3001',
    parentMessageText: appendFinanceInteractionReference(
      'Please answer this question.',
      { kind, referenceId: 'c'.repeat(64) },
    ),
  };
}

describe('TalkClarificationHandler', () => {
  it('understands a selectable expense category in a natural reply', () => {
    expect(exactTaxonomyCategory(taxonomy, '  GROCERIES  ')?.alias).toBe(
      'groceries',
    );
    expect(exactTaxonomyCategory(taxonomy, 'Groceries please')?.alias).toBe(
      'groceries',
    );
    expect(exactTaxonomyCategory(taxonomy, 'That was groceries')?.alias).toBe(
      'groceries',
    );
    expect(
      exactTaxonomyCategory(taxonomy, 'I think this one was groceries.'),
    ).toMatchObject({ alias: 'groceries' });
    expect(
      exactTaxonomyCategory(taxonomy, 'why did you choose groceries?'),
    ).toBeUndefined();
    expect(
      exactTaxonomyCategory(taxonomy, "it's not groceries"),
    ).toBeUndefined();
    expect(exactTaxonomyCategory(taxonomy, 'grocery')).toBeUndefined();
    expect(exactTaxonomyCategory(taxonomy, 'Household Income')).toBeUndefined();
  });

  it('resolves transaction and receipt replies with exact parent identity', async () => {
    const resolveTransaction = vi.fn();
    const resolveReceipt = vi.fn();
    const handler = new TalkClarificationHandler({
      expectedBotActorId: botActorId,
      taxonomySource: { read: vi.fn().mockResolvedValue(taxonomy) },
      transactions: {
        getClarificationDirection: vi.fn().mockReturnValue('expense'),
        resolveClarification: resolveTransaction,
      },
      receipts: { resolveClarification: resolveReceipt },
      now: () => new Date(now),
    });

    await expect(
      handler.handle(botReply('transaction-category', 'Groceries')),
    ).resolves.toEqual({
      handled: true,
      outcome: 'resolved',
      interaction: 'transaction-category',
      referenceId: 'c'.repeat(64),
    });
    expect(resolveTransaction).toHaveBeenCalledWith({
      referenceId: 'c'.repeat(64),
      roomToken: 'household-finance',
      categoryAlias: 'groceries',
      actorId: 'alex',
      inboundMessageId: '3002',
      parentBotId: botActorId,
      parentMessageId: '3001',
      resolvedAt: now,
    });

    await handler.handle(botReply('receipt-category', 'groceries'));
    expect(resolveReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: 'c'.repeat(64),
        categoryAlias: 'groceries',
        parentMessageId: '3001',
      }),
    );

    await expect(
      handler.handle(botReply('transaction-category', 'Household Income')),
    ).resolves.toMatchObject({
      handled: true,
      outcome: 'invalid-category',
    });
    expect(resolveTransaction).toHaveBeenCalledTimes(1);

    const incomeHandler = new TalkClarificationHandler({
      expectedBotActorId: botActorId,
      taxonomySource: { read: vi.fn().mockResolvedValue(taxonomy) },
      transactions: {
        getClarificationDirection: vi.fn().mockReturnValue('income'),
        resolveClarification: resolveTransaction,
      },
      now: () => new Date(now),
    });
    await expect(
      incomeHandler.handle(
        botReply('transaction-category', 'Household Income'),
      ),
    ).resolves.toMatchObject({
      handled: true,
      outcome: 'resolved',
    });
    expect(resolveTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryAlias: 'household-income' }),
    );
  });

  it('accepts a natural numbered choice but not an approximate category', async () => {
    const resolveTransaction = vi.fn();
    const resolveMatch = vi.fn();
    const handler = new TalkClarificationHandler({
      expectedBotActorId: botActorId,
      taxonomySource: { read: vi.fn().mockResolvedValue(taxonomy) },
      transactions: {
        getClarificationDirection: vi.fn().mockReturnValue('expense'),
        resolveClarification: resolveTransaction,
      },
      matches: { resolveAmbiguityFromTalk: resolveMatch },
      now: () => new Date(now),
    });

    await expect(
      handler.handle(botReply('transaction-category', 'grocery')),
    ).resolves.toMatchObject({
      handled: true,
      outcome: 'invalid-category',
    });
    await expect(
      handler.handle(botReply('receipt-match', 'option 2 please')),
    ).resolves.toMatchObject({
      handled: true,
      outcome: 'resolved',
    });
    expect(resolveTransaction).not.toHaveBeenCalled();
    expect(resolveMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceId: 'c'.repeat(64),
        selection: 2,
        parentBotId: botActorId,
        parentMessageId: '3001',
      }),
    );
    await expect(
      handler.handle(botReply('receipt-match', 'the second one')),
    ).resolves.toMatchObject({
      handled: true,
      outcome: 'resolved',
    });
    await expect(
      handler.handle(botReply('receipt-match', 'why is option 2 wrong?')),
    ).resolves.toMatchObject({
      handled: true,
      outcome: 'invalid-selection',
    });
  });

  it('binds agent actions to the exact replied-to prompt instead of the newest room prompt', async () => {
    const resolveReceipt = vi.fn();
    const resolveMatch = vi.fn();
    const handler = new TalkClarificationHandler({
      expectedBotActorId: botActorId,
      taxonomySource: { read: vi.fn().mockResolvedValue(taxonomy) },
      receipts: {
        resolveClarification: resolveReceipt,
        latestOpenClarification: vi.fn().mockReturnValue({
          referenceId: 'd'.repeat(64),
          eventId: 'newer-receipt',
          roomToken: 'household-finance',
          botActorId,
          parentMessageId: '4001',
          deliveredAt: '2026-07-28T01:09:00.000Z',
          summary: 'A newer receipt',
        }),
      },
      matches: { resolveAmbiguityFromTalk: resolveMatch },
      now: () => new Date(now),
    });
    const receiptReply = botReply('receipt-category', 'not an exact label');

    await expect(
      handler.resolveConversationCategory({
        kind: 'receipt',
        roomToken: receiptReply.roomToken,
        categoryAlias: 'groceries',
        actorId: receiptReply.actorId,
        inboundMessageId: receiptReply.messageId,
        resolvedAt: now,
        replyContext: {
          parentBotId: receiptReply.parentBotId,
          parentMessageId: receiptReply.parentMessageId,
          parentMessageText: receiptReply.parentMessageText,
        },
      }),
    ).resolves.toBe(true);
    expect(resolveReceipt).toHaveBeenCalledExactlyOnceWith({
      referenceId: 'c'.repeat(64),
      roomToken: 'household-finance',
      categoryAlias: 'groceries',
      actorId: 'alex',
      inboundMessageId: '3002',
      parentBotId: botActorId,
      parentMessageId: '3001',
      resolvedAt: now,
    });

    const matchReply = botReply('receipt-match', 'the second one');
    expect(
      handler.resolveConversationMatch({
        roomToken: matchReply.roomToken,
        selection: 2,
        actorId: matchReply.actorId,
        inboundMessageId: matchReply.messageId,
        resolvedAt: now,
        replyContext: {
          parentBotId: matchReply.parentBotId,
          parentMessageId: matchReply.parentMessageId,
          parentMessageText: matchReply.parentMessageText,
        },
      }),
    ).toBe(true);
    expect(resolveMatch).toHaveBeenCalledWith({
      referenceId: 'c'.repeat(64),
      roomToken: 'household-finance',
      actorId: 'alex',
      inboundMessageId: '3002',
      parentBotId: botActorId,
      parentMessageId: '3001',
      selection: 2,
      resolvedAt: now,
    });
  });

  it('acknowledges a no-longer-applicable category reply without retrying it', async () => {
    const resolveReceipt = vi.fn().mockImplementation(() => {
      throw new ReceiptCategorizationClarificationNotApplicableError();
    });
    const handler = new TalkClarificationHandler({
      expectedBotActorId: botActorId,
      taxonomySource: { read: vi.fn().mockResolvedValue(taxonomy) },
      receipts: { resolveClarification: resolveReceipt },
      now: () => new Date(now),
    });

    await expect(
      handler.handle(botReply('receipt-category', 'Groceries')),
    ).resolves.toEqual({
      handled: true,
      outcome: 'not-applicable',
      interaction: 'receipt-category',
    });
    expect(resolveReceipt).toHaveBeenCalledOnce();
  });
});

describe('ReceiptMatchAmbiguityTalkWorker', () => {
  it('sends bounded ID-free numbered choices and persists delivered identity', async () => {
    const recordDelivered = vi.fn();
    const sendReplyWithIdentity = vi.fn().mockResolvedValue({
      roomToken: 'household-finance',
      botActorId,
      messageId: '3001',
      referenceId: 'd'.repeat(64),
      replyTo: '2001',
    });
    const source = {
      eventId: '11111111-1111-4111-8111-111111111111',
      roomToken: 'household-finance',
      messageId: '2001',
    } as ReceiptCategorizationSource;
    const worker = new ReceiptMatchAmbiguityTalkWorker({
      matches: {
        listUnpromptedAmbiguities: vi.fn().mockReturnValue([
          {
            referenceId: 'd'.repeat(64),
            receipt: {
              receiptId: source.eventId,
              idempotencyKey: 'receipt-source',
              intent: {
                schemaVersion: 'receipt-match-intent.v1',
                receiptId: source.eventId,
                merchantName: 'Example Market',
                purchaseDate: '2026-07-27',
                currency: 'CAD',
                totalMinorUnits: 1_725,
                paymentEvidence: { kind: 'unknown' },
              },
              status: 'ambiguous',
              expiresAt: '2026-08-04T01:00:00.000Z',
              matchAttemptCount: 1,
              createdAt: now,
              updatedAt: now,
            },
            choices: [
              {
                choiceToken: `match_${'a'.repeat(32)}`,
                accountAlias: 'active-mastercard',
                postingDate: '2026-07-28',
                payeeName: 'Example Market',
                amountMinorUnits: -1_725,
                score: 132,
                selected: false,
              },
              {
                choiceToken: `match_${'b'.repeat(32)}`,
                accountAlias: 'primary-chequing',
                postingDate: '2026-07-29',
                payeeName: 'Example Market',
                amountMinorUnits: -1_725,
                score: 132,
                selected: false,
              },
            ],
          },
        ]),
        recordAmbiguityPromptDelivered: recordDelivered,
        listUnnotifiedTalkOutcomes: vi.fn().mockReturnValue([]),
        recordTalkOutcomeDelivered: vi.fn(),
      },
      sources: { getSource: vi.fn().mockReturnValue(source) },
      talk: { sendReplyWithIdentity },
      now: () => new Date(now),
    });

    await expect(worker.kick()).resolves.toBe(1);
    const reply = sendReplyWithIdentity.mock.calls[0]![0] as {
      message: string;
    };
    expect(reply.message).toContain('1. 2026-07-28');
    expect(reply.message).toContain('2. 2026-07-29');
    expect(reply.message).toContain('Active Mastercard — $17.25');
    expect(reply.message).toContain('I found more than one bank transaction');
    expect(reply.message).not.toContain('imported transactions');
    expect(reply.message).toContain(
      `Finance reference: receipt-match/${'d'.repeat(64)}`,
    );
    expect(reply.message).not.toContain('actual-transaction');
    expect(reply.message).not.toContain('bank-import');
    expect(recordDelivered).toHaveBeenCalledWith({
      referenceId: 'd'.repeat(64),
      receiptId: source.eventId,
      roomToken: 'household-finance',
      botActorId,
      messageId: '3001',
      choiceTokens: [`match_${'a'.repeat(32)}`, `match_${'b'.repeat(32)}`],
      deliveredAt: now,
    });
  });

  it('asks calmly for confirmation when one foreign-currency candidate is plausible', async () => {
    const sendReplyWithIdentity = vi.fn().mockResolvedValue({
      roomToken: 'household-finance',
      botActorId,
      messageId: '3001',
      referenceId: 'd'.repeat(64),
      replyTo: '2001',
    });
    const source = {
      eventId: '11111111-1111-4111-8111-111111111111',
      roomToken: 'household-finance',
      messageId: '2001',
    } as ReceiptCategorizationSource;
    const worker = new ReceiptMatchAmbiguityTalkWorker({
      matches: {
        listUnpromptedAmbiguities: vi.fn().mockReturnValue([
          {
            referenceId: 'd'.repeat(64),
            receipt: {
              receiptId: source.eventId,
              idempotencyKey: 'receipt-source',
              intent: {
                schemaVersion: 'receipt-match-intent.v1',
                receiptId: source.eventId,
                merchantName: 'Example Market',
                purchaseDate: '2026-07-27',
                currency: 'USD',
                totalMinorUnits: 1_725,
                paymentEvidence: { kind: 'unknown' },
              },
              status: 'ambiguous',
              expiresAt: '2026-08-04T01:00:00.000Z',
              matchAttemptCount: 0,
              createdAt: now,
              updatedAt: now,
            },
            choices: [
              {
                choiceToken: `match_${'a'.repeat(32)}`,
                accountAlias: 'active-mastercard',
                postingDate: '2026-07-28',
                payeeName: 'Example Market',
                amountMinorUnits: -2_341,
                score: 112,
                selected: false,
              },
            ],
          },
        ]),
        recordAmbiguityPromptDelivered: vi.fn(),
        listUnnotifiedTalkOutcomes: vi.fn().mockReturnValue([]),
        recordTalkOutcomeDelivered: vi.fn(),
      },
      sources: { getSource: vi.fn().mockReturnValue(source) },
      talk: { sendReplyWithIdentity },
      now: () => new Date(now),
    });

    await expect(worker.kick()).resolves.toBe(1);
    const reply = sendReplyWithIdentity.mock.calls[0]![0] as {
      message: string;
    };
    expect(reply.message).toContain(
      'I found a possible bank transaction for the Example Market receipt for US$17.25.',
    );
    expect(reply.message).toContain('Reply 1 if it looks right');
    expect(reply.message).not.toContain('more than one');
  });

  it('gives one calm final receipt outcome without internal identifiers', async () => {
    const recordOutcome = vi.fn();
    const sendReplyWithIdentity = vi.fn().mockResolvedValue({
      roomToken: 'household-finance',
      botActorId,
      messageId: '3003',
      referenceId: 'e'.repeat(64),
      replyTo: '2001',
    });
    const source = {
      eventId: '11111111-1111-4111-8111-111111111111',
      roomToken: 'household-finance',
      messageId: '2001',
    } as ReceiptCategorizationSource;
    const worker = new ReceiptMatchAmbiguityTalkWorker({
      matches: {
        listUnpromptedAmbiguities: vi.fn().mockReturnValue([]),
        recordAmbiguityPromptDelivered: vi.fn(),
        listUnnotifiedTalkOutcomes: vi.fn().mockReturnValue([
          {
            referenceId: 'e'.repeat(64),
            receipt: {
              receiptId: source.eventId,
              idempotencyKey: 'receipt-source',
              intent: {
                schemaVersion: 'receipt-match-intent.v1',
                receiptId: source.eventId,
                merchantName: 'Example Market',
                purchaseDate: '2026-07-27',
                currency: 'CAD',
                totalMinorUnits: 1_725,
                paymentEvidence: { kind: 'unknown' },
              },
              status: 'applied',
              expiresAt: '2026-08-04T01:00:00.000Z',
              matchAttemptCount: 1,
              createdAt: now,
              updatedAt: now,
              matchedAt: now,
              appliedAt: now,
            },
          },
        ]),
        recordTalkOutcomeDelivered: recordOutcome,
      },
      sources: { getSource: vi.fn().mockReturnValue(source) },
      talk: { sendReplyWithIdentity },
      now: () => new Date(now),
    });

    await expect(worker.kick()).resolves.toBe(1);
    expect(sendReplyWithIdentity).toHaveBeenCalledWith({
      roomToken: 'household-finance',
      message:
        'I matched the Example Market receipt for $17.25 and updated its transaction in Actual.',
      replyTo: '2001',
      referenceId: 'e'.repeat(64),
      silent: false,
    });
    expect(recordOutcome).toHaveBeenCalledWith({
      receiptId: source.eventId,
      status: 'applied',
      referenceId: 'e'.repeat(64),
      deliveredAt: now,
    });
  });
});
