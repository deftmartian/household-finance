import type {
  ReceiptCategorizationSource,
  ReceiptMatchStore,
  ReceiptMatchTalkOutcomeCandidate,
} from '../storage/index.js';
import type {
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../talk/client.js';
import { appendFinanceInteractionReference } from '../talk/index.js';

const MAXIMUM_AMBIGUITY_PROMPTS_PER_RUN = 100;

export interface ReceiptMatchPromptSource {
  getSource(eventId: string): ReceiptCategorizationSource | undefined;
}

export interface ReceiptMatchPromptTalkSender {
  sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity>;
}

export interface ReceiptMatchAmbiguityTalkWorkerOptions {
  readonly matches: Pick<
    ReceiptMatchStore,
    | 'listUnpromptedAmbiguities'
    | 'recordAmbiguityPromptDelivered'
    | 'listUnnotifiedTalkOutcomes'
    | 'recordTalkOutcomeDelivered'
  >;
  readonly sources: ReceiptMatchPromptSource;
  readonly talk: ReceiptMatchPromptTalkSender;
  readonly now?: () => Date;
}

function safeTalkText(value: string | null, maximum = 80): string {
  if (value === null) {
    return 'unnamed payee';
  }
  const normalized = [...value.normalize('NFC')]
    .map((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 0x1f || point === 0x7f)
        ? ' '
        : character;
    })
    .join('')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return normalized.length === 0
    ? 'unnamed payee'
    : normalized.slice(0, maximum);
}

function friendlyAccount(value: string): string {
  const label = value.replaceAll(/[-_]+/g, ' ').replaceAll(/\s+/g, ' ').trim();
  return label.length === 0
    ? 'Unknown account'
    : label
        .split(' ')
        .map((word) => `${word[0]!.toLocaleUpperCase('en-CA')}${word.slice(1)}`)
        .join(' ');
}

function money(valueMinorUnits: number, currency = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
  }).format(Math.abs(valueMinorUnits) / 100);
}

function renderAmbiguityPrompt(
  candidate: ReturnType<ReceiptMatchStore['listUnpromptedAmbiguities']>[number],
): string {
  const merchant = safeTalkText(candidate.receipt.intent.merchantName);
  const amount = money(
    candidate.receipt.intent.totalMinorUnits,
    candidate.receipt.intent.currency,
  );
  const choices = candidate.choices.map((choice, index) => {
    const payee = safeTalkText(choice.payeeName, 48);
    return `${String(index + 1)}. ${choice.postingDate} — ${payee} — ${friendlyAccount(choice.accountAlias)} — ${money(choice.amountMinorUnits)}`;
  });
  const introduction =
    candidate.choices.length === 1
      ? `I found a possible bank transaction for the ${merchant} receipt for ${amount}. Reply 1 if it looks right:`
      : `I found more than one bank transaction that could match the ${merchant} receipt for ${amount}. Reply with the number that looks right:`;
  return [introduction, ...choices].join('\n');
}

function renderOutcome(candidate: ReceiptMatchTalkOutcomeCandidate): string {
  const { receipt } = candidate;
  const merchant = safeTalkText(receipt.intent.merchantName);
  const amount = money(receipt.intent.totalMinorUnits, receipt.intent.currency);
  if (receipt.status === 'applied') {
    return `I matched the ${merchant} receipt for ${amount} and updated its transaction in Actual.`;
  }
  if (
    receipt.attentionReason === 'bank-transaction-not-found' ||
    receipt.attentionReason === 'match-retry-exhausted'
  ) {
    return `I saved the ${merchant} receipt for ${amount}, but the bank transaction still hasn't appeared. Nothing changed in Actual. Please add or categorize this purchase manually in Actual.`;
  }
  return `I saved the ${merchant} receipt for ${amount}, but I couldn't safely update the matching transaction. Nothing changed in Actual. Please categorize or split that transaction manually in Actual.`;
}

export class ReceiptMatchAmbiguityTalkWorker {
  readonly #matches: ReceiptMatchAmbiguityTalkWorkerOptions['matches'];
  readonly #sources: ReceiptMatchPromptSource;
  readonly #talk: ReceiptMatchPromptTalkSender;
  readonly #now: () => Date;
  #running: Promise<number> | undefined;

  constructor(options: ReceiptMatchAmbiguityTalkWorkerOptions) {
    this.#matches = options.matches;
    this.#sources = options.sources;
    this.#talk = options.talk;
    this.#now = options.now ?? (() => new Date());
  }

  kick(): Promise<number> {
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #run(): Promise<number> {
    let deliveredCount = 0;
    const candidates = this.#matches.listUnpromptedAmbiguities(
      MAXIMUM_AMBIGUITY_PROMPTS_PER_RUN,
    );
    for (const candidate of candidates) {
      const source = this.#sources.getSource(candidate.receipt.receiptId);
      if (source === undefined) {
        throw new Error(
          'Receipt match ambiguity has no categorization source identity',
        );
      }
      const message = appendFinanceInteractionReference(
        renderAmbiguityPrompt(candidate),
        {
          kind: 'receipt-match',
          referenceId: candidate.referenceId,
        },
      );
      const delivered = await this.#talk.sendReplyWithIdentity({
        roomToken: source.roomToken,
        message,
        replyTo: source.messageId,
        referenceId: candidate.referenceId,
        silent: false,
      });
      this.#matches.recordAmbiguityPromptDelivered({
        referenceId: candidate.referenceId,
        receiptId: candidate.receipt.receiptId,
        roomToken: delivered.roomToken,
        botActorId: delivered.botActorId,
        messageId: delivered.messageId,
        choiceTokens: candidate.choices.map((choice) => choice.choiceToken),
        deliveredAt: this.#now().toISOString(),
      });
      deliveredCount += 1;
    }
    const outcomes = this.#matches.listUnnotifiedTalkOutcomes(
      MAXIMUM_AMBIGUITY_PROMPTS_PER_RUN,
    );
    for (const candidate of outcomes) {
      const source = this.#sources.getSource(candidate.receipt.receiptId);
      if (source === undefined) {
        throw new Error('Receipt outcome has no source message');
      }
      await this.#talk.sendReplyWithIdentity({
        roomToken: source.roomToken,
        message: renderOutcome(candidate),
        replyTo: source.messageId,
        referenceId: candidate.referenceId,
        silent: false,
      });
      this.#matches.recordTalkOutcomeDelivered({
        receiptId: candidate.receipt.receiptId,
        status: candidate.receipt.status,
        referenceId: candidate.referenceId,
        deliveredAt: this.#now().toISOString(),
      });
      deliveredCount += 1;
    }
    return deliveredCount;
  }
}
