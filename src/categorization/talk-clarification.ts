import { z } from 'zod';

import {
  ReceiptCategorizationClarificationNotApplicableError,
  type ReceiptCategorizationStore,
  type ReceiptMatchStore,
  type TransactionCategorizationStore,
} from '../storage/index.js';
import {
  extractFinanceInteractionReference,
  type TalkBotReply,
} from '../talk/index.js';
import {
  categoryTaxonomySchema,
  type CategoryTaxonomy,
  type CategoryTaxonomyEntry,
} from './taxonomy.js';

const botActorIdSchema = z.string().regex(/^bots\/bot-[a-f0-9]{40}$/);

export interface TalkClarificationTaxonomySource {
  read(signal?: AbortSignal): Promise<CategoryTaxonomy>;
}

type TransactionClarificationStore = Pick<
  TransactionCategorizationStore,
  'getClarificationDirection' | 'resolveClarification'
> &
  Partial<Pick<TransactionCategorizationStore, 'latestOpenClarification'>>;

type ReceiptClarificationStore = Pick<
  ReceiptCategorizationStore,
  'resolveClarification'
> &
  Partial<Pick<ReceiptCategorizationStore, 'latestOpenClarification'>>;

export type TalkClarificationResolutionResult =
  | {
      handled: false;
      reason: 'not-a-finance-interaction' | 'actual-update';
    }
  | {
      handled: true;
      outcome: 'invalid-category';
      interaction: 'transaction-category' | 'receipt-category';
    }
  | {
      handled: true;
      outcome: 'invalid-selection';
      interaction: 'receipt-match';
    }
  | {
      handled: true;
      outcome: 'not-applicable';
      interaction: 'receipt-category';
    }
  | {
      handled: true;
      outcome: 'resolved';
      interaction:
        'transaction-category' | 'receipt-category' | 'receipt-match';
      referenceId: string;
    };

export interface TalkClarificationHandlerOptions {
  readonly expectedBotActorId: string;
  readonly taxonomySource: TalkClarificationTaxonomySource;
  readonly transactions?: TransactionClarificationStore;
  readonly receipts?: ReceiptClarificationStore;
  readonly matches?: Pick<ReceiptMatchStore, 'resolveAmbiguityFromTalk'>;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface ConversationCategoryPrompt {
  readonly kind: 'receipt' | 'transaction';
  readonly prompt: string;
  readonly referenceId: string;
  readonly botActorId: string;
  readonly parentMessageId: string;
}

export interface ConversationReplyContext {
  readonly parentBotId: string;
  readonly parentMessageId: string;
  readonly parentMessageText: string;
}

function normalizedCategoryLabel(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replaceAll(/\s+/g, ' ')
    .toLocaleLowerCase('en-CA');
}

function normalizedTerseDecision(value: string): string {
  const normalized = normalizedCategoryLabel(value)
    .replace(/^please\s+/u, '')
    .replace(/\s+please[.!]?$/u, '')
    .replace(/[.!]$/u, '')
    .trim();
  return normalized
    .replace(
      /^(?:(?:that|this|it)(?: one)?\s+(?:was|is|should be|belongs in|goes (?:in|under|to))|i think (?:that|this|it)(?: one)?\s+(?:was|is))\s+/u,
      '',
    )
    .replace(
      /^(?:put|categorize|mark)\s+(?:it|this|that)(?: one)?\s+(?:as|in|under)\s+/u,
      '',
    )
    .trim();
}

export function exactTaxonomyCategory(
  untrustedTaxonomy: CategoryTaxonomy,
  reply: string,
  acceptedKinds: ReadonlySet<CategoryTaxonomyEntry['kind']> = new Set([
    'expense',
  ]),
): CategoryTaxonomyEntry | undefined {
  const taxonomy = categoryTaxonomySchema.parse(untrustedTaxonomy);
  const normalized = normalizedTerseDecision(reply);
  if (normalized.length === 0) {
    return undefined;
  }
  const matches = taxonomy.categories.filter((category) => {
    if (!acceptedKinds.has(category.kind) || !category.modelSelectable) {
      return false;
    }
    return [category.alias, category.name].some(
      (label) => normalizedCategoryLabel(label) === normalized,
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function numberedSelection(reply: string): number | undefined {
  const normalized = reply.normalize('NFC').trim().toLocaleLowerCase('en-CA');
  const match = normalized.match(
    /^(?:please\s+)?(?:the\s+)?(?:option\s+)?(10|[1-9]|one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:st|nd|rd|th)?(?:\s+one)?(?:\s+please)?[.!]?$/u,
  );
  if (match === null) {
    return undefined;
  }
  const words = new Map([
    ['one', 1],
    ['two', 2],
    ['three', 3],
    ['four', 4],
    ['five', 5],
    ['six', 6],
    ['seven', 7],
    ['eight', 8],
    ['nine', 9],
    ['ten', 10],
    ['first', 1],
    ['second', 2],
    ['third', 3],
    ['fourth', 4],
    ['fifth', 5],
    ['sixth', 6],
    ['seventh', 7],
    ['eighth', 8],
    ['ninth', 9],
    ['tenth', 10],
  ]);
  return words.get(match[1]!) ?? Number.parseInt(match[1]!, 10);
}

function transactionCategoryKinds(
  store: TransactionClarificationStore,
  referenceId: string,
): ReadonlySet<CategoryTaxonomyEntry['kind']> {
  return store.getClarificationDirection(referenceId) === 'income'
    ? new Set(['income'])
    : new Set(['expense']);
}

export class TalkClarificationHandler {
  readonly #expectedBotActorId: string;
  readonly #taxonomySource: TalkClarificationTaxonomySource;
  readonly #transactions: TransactionClarificationStore | undefined;
  readonly #receipts: ReceiptClarificationStore | undefined;
  readonly #matches:
    Pick<ReceiptMatchStore, 'resolveAmbiguityFromTalk'> | undefined;
  readonly #now: () => Date;
  readonly #signal: AbortSignal | undefined;

  constructor(options: TalkClarificationHandlerOptions) {
    this.#expectedBotActorId = botActorIdSchema.parse(
      options.expectedBotActorId,
    );
    this.#taxonomySource = options.taxonomySource;
    this.#transactions = options.transactions;
    this.#receipts = options.receipts;
    this.#matches = options.matches;
    this.#now = options.now ?? (() => new Date());
    this.#signal = options.signal;
  }

  async handle(
    event: TalkBotReply,
  ): Promise<TalkClarificationResolutionResult> {
    if (event.parentBotId !== this.#expectedBotActorId) {
      throw new Error('Talk clarification parent bot does not match');
    }
    const reference = extractFinanceInteractionReference(
      event.parentMessageText,
    );
    if (reference === undefined) {
      return { handled: false, reason: 'not-a-finance-interaction' };
    }
    if (reference.kind === 'actual-update') {
      return { handled: false, reason: 'actual-update' };
    }
    const common = {
      referenceId: reference.referenceId,
      roomToken: event.roomToken,
      actorId: event.actorId,
      inboundMessageId: event.messageId,
      parentBotId: event.parentBotId,
      parentMessageId: event.parentMessageId,
      resolvedAt: this.#now().toISOString(),
    };

    switch (reference.kind) {
      case 'transaction-category': {
        if (this.#transactions === undefined) {
          throw new Error('Transaction clarification store is not configured');
        }
        const category = exactTaxonomyCategory(
          await this.#taxonomySource.read(this.#signal),
          event.message,
          transactionCategoryKinds(this.#transactions, reference.referenceId),
        );
        if (category === undefined) {
          return {
            handled: true,
            outcome: 'invalid-category',
            interaction: reference.kind,
          };
        }
        this.#transactions.resolveClarification({
          ...common,
          categoryAlias: category.alias,
        });
        return {
          handled: true,
          outcome: 'resolved',
          interaction: reference.kind,
          referenceId: reference.referenceId,
        };
      }
      case 'receipt-category': {
        if (this.#receipts === undefined) {
          throw new Error('Receipt clarification store is not configured');
        }
        const category = exactTaxonomyCategory(
          await this.#taxonomySource.read(this.#signal),
          event.message,
        );
        if (category === undefined) {
          return {
            handled: true,
            outcome: 'invalid-category',
            interaction: reference.kind,
          };
        }
        try {
          this.#receipts.resolveClarification({
            ...common,
            categoryAlias: category.alias,
          });
        } catch (error) {
          if (
            error instanceof
            ReceiptCategorizationClarificationNotApplicableError
          ) {
            return {
              handled: true,
              outcome: 'not-applicable',
              interaction: reference.kind,
            };
          }
          throw error;
        }
        return {
          handled: true,
          outcome: 'resolved',
          interaction: reference.kind,
          referenceId: reference.referenceId,
        };
      }
      case 'receipt-match': {
        if (this.#matches === undefined) {
          throw new Error(
            'Receipt match clarification store is not configured',
          );
        }
        const selection = numberedSelection(event.message);
        if (selection === undefined) {
          return {
            handled: true,
            outcome: 'invalid-selection',
            interaction: reference.kind,
          };
        }
        this.#matches.resolveAmbiguityFromTalk({
          ...common,
          selection,
        });
        return {
          handled: true,
          outcome: 'resolved',
          interaction: reference.kind,
          referenceId: reference.referenceId,
        };
      }
    }
  }

  conversationCategoryPrompt(
    roomToken: string,
    deliveredAtOrBefore?: string,
  ): ConversationCategoryPrompt | undefined {
    const receipt = this.#receipts?.latestOpenClarification?.(
      roomToken,
      deliveredAtOrBefore,
    );
    const transaction = this.#transactions?.latestOpenClarification?.(
      roomToken,
      deliveredAtOrBefore,
    );
    if (receipt === undefined && transaction === undefined) {
      return undefined;
    }
    if (
      transaction === undefined ||
      (receipt !== undefined && receipt.deliveredAt >= transaction.deliveredAt)
    ) {
      return {
        kind: 'receipt',
        prompt: receipt!.summary,
        referenceId: receipt!.referenceId,
        botActorId: receipt!.botActorId,
        parentMessageId: receipt!.parentMessageId,
      };
    }
    return {
      kind: 'transaction',
      prompt: transaction.summary,
      referenceId: transaction.referenceId,
      botActorId: transaction.botActorId,
      parentMessageId: transaction.parentMessageId,
    };
  }

  async resolveConversationCategory(input: {
    kind: 'receipt' | 'transaction';
    roomToken: string;
    categoryAlias: string;
    actorId: string;
    inboundMessageId: string;
    resolvedAt: string;
    replyContext?: ConversationReplyContext;
    target?: ConversationCategoryPrompt;
  }): Promise<boolean> {
    if (input.kind === 'receipt') {
      const category = exactTaxonomyCategory(
        await this.#taxonomySource.read(this.#signal),
        input.categoryAlias,
      );
      if (category === undefined || category.alias !== input.categoryAlias) {
        return false;
      }
      const target = (() => {
        if (input.replyContext !== undefined) {
          const reference = extractFinanceInteractionReference(
            input.replyContext.parentMessageText,
          );
          if (
            input.replyContext.parentBotId !== this.#expectedBotActorId ||
            reference?.kind !== 'receipt-category'
          ) {
            return undefined;
          }
          return {
            referenceId: reference.referenceId,
            botActorId: input.replyContext.parentBotId,
            parentMessageId: input.replyContext.parentMessageId,
          };
        }
        return input.target?.kind === 'receipt' ? input.target : undefined;
      })();
      if (target === undefined) {
        return false;
      }
      this.#receipts!.resolveClarification({
        referenceId: target.referenceId,
        roomToken: input.roomToken,
        categoryAlias: category.alias,
        actorId: input.actorId,
        inboundMessageId: input.inboundMessageId,
        parentBotId: target.botActorId,
        parentMessageId: target.parentMessageId,
        resolvedAt: input.resolvedAt,
      });
      return true;
    }
    const target = (() => {
      if (input.replyContext !== undefined) {
        const reference = extractFinanceInteractionReference(
          input.replyContext.parentMessageText,
        );
        if (
          input.replyContext.parentBotId !== this.#expectedBotActorId ||
          reference?.kind !== 'transaction-category'
        ) {
          return undefined;
        }
        return {
          referenceId: reference.referenceId,
          botActorId: input.replyContext.parentBotId,
          parentMessageId: input.replyContext.parentMessageId,
        };
      }
      return input.target?.kind === 'transaction' ? input.target : undefined;
    })();
    if (target === undefined) {
      return false;
    }
    const category = exactTaxonomyCategory(
      await this.#taxonomySource.read(this.#signal),
      input.categoryAlias,
      transactionCategoryKinds(this.#transactions!, target.referenceId),
    );
    if (category === undefined || category.alias !== input.categoryAlias) {
      return false;
    }
    this.#transactions!.resolveClarification({
      referenceId: target.referenceId,
      roomToken: input.roomToken,
      categoryAlias: category.alias,
      actorId: input.actorId,
      inboundMessageId: input.inboundMessageId,
      parentBotId: target.botActorId,
      parentMessageId: target.parentMessageId,
      resolvedAt: input.resolvedAt,
    });
    return true;
  }

  resolveConversationMatch(input: {
    roomToken: string;
    selection: number;
    actorId: string;
    inboundMessageId: string;
    resolvedAt: string;
    replyContext?: ConversationReplyContext;
  }): boolean {
    if (this.#matches === undefined || input.replyContext === undefined) {
      return false;
    }
    const reference = extractFinanceInteractionReference(
      input.replyContext.parentMessageText,
    );
    if (
      input.replyContext.parentBotId !== this.#expectedBotActorId ||
      reference?.kind !== 'receipt-match'
    ) {
      return false;
    }
    this.#matches.resolveAmbiguityFromTalk({
      referenceId: reference.referenceId,
      roomToken: input.roomToken,
      actorId: input.actorId,
      inboundMessageId: input.inboundMessageId,
      parentBotId: input.replyContext.parentBotId,
      parentMessageId: input.replyContext.parentMessageId,
      selection: input.selection,
      resolvedAt: input.resolvedAt,
    });
    return true;
  }
}
