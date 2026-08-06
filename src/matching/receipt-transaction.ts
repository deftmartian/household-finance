import { z } from 'zod';

import {
  assessReceiptModelProposal,
  canonicalizeHouseholdReceiptCurrency,
  receiptModelProposalV1Schema,
  type ReceiptModelProposalV1,
} from '../model/index.js';
import {
  householdFinanceActiveReceiptRecordSchema,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../receipt-record/index.js';

const safeTextSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => value === value.normalize('NFC').trim());

export const receiptMatchIntentSchema = z.strictObject({
  schemaVersion: z.literal('receipt-match-intent.v1'),
  receiptId: z.uuid(),
  merchantName: safeTextSchema,
  purchaseDate: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalMinorUnits: z.number().int().safe().positive(),
  paymentEvidence: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('masked-card'),
      lastFour: z.string().regex(/^\d{4}$/),
    }),
    z.strictObject({ kind: z.literal('unknown') }),
    z.strictObject({ kind: z.literal('cash') }),
  ]),
});

export type ReceiptMatchIntent = z.infer<typeof receiptMatchIntentSchema>;

export const importedTransactionCandidateSchema = z.strictObject({
  transactionId: z.string().min(1).max(200),
  importedId: z.string().min(1).max(500),
  accountAlias: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  accountLastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  postingDate: z.iso.date(),
  payeeName: safeTextSchema.nullable(),
  statementDescription: safeTextSchema.nullable().optional(),
  currency: z.literal('CAD'),
  amountMinorUnits: z.number().int().safe().negative(),
  alreadyLinkedReceipts: z
    .array(
      z.strictObject({
        receiptId: z.uuid(),
        sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(32)
    .refine(
      (values) =>
        new Set(
          values.map((value) => `${value.receiptId}\0${value.sourceSha256}`),
        ).size === values.length,
    ),
});

export type ImportedTransactionCandidate = z.infer<
  typeof importedTransactionCandidateSchema
>;

function linksReceipt(
  candidate: ImportedTransactionCandidate,
  receiptId: string,
): boolean {
  return candidate.alreadyLinkedReceipts.some(
    (link) => link.receiptId === receiptId,
  );
}

export interface ReceiptMatchPolicy {
  earliestPostingDaysBeforePurchase: number;
  latestPostingDaysAfterPurchase: number;
  minimumMerchantScore: number;
  minimumWinningMargin: number;
}

export const defaultReceiptMatchPolicy: ReceiptMatchPolicy = {
  earliestPostingDaysBeforePurchase: 0,
  latestPostingDaysAfterPurchase: 7,
  minimumMerchantScore: 60,
  minimumWinningMargin: 15,
};

const MINIMUM_FOREIGN_LEDGER_RATIO_BASIS_POINTS = 5_000;
const MAXIMUM_FOREIGN_LEDGER_RATIO_BASIS_POINTS = 30_000;
const MAXIMUM_SUBSET_CANDIDATES = 20;
const MAXIMUM_SUBSET_SIZE = 6;
const MAXIMUM_SUBSET_SOLUTIONS = 2;

/**
 * This is intentionally a broad sanity bound, not an exchange-rate oracle.
 * It prevents a sole same-merchant charge with a wildly different amount
 * from being linked before the real posted charge arrives.
 */
export function plausibleForeignLedgerAmount(
  sourceMinorUnits: number,
  ledgerMinorUnits: number,
): boolean {
  if (
    !Number.isSafeInteger(sourceMinorUnits) ||
    sourceMinorUnits <= 0 ||
    !Number.isSafeInteger(ledgerMinorUnits) ||
    ledgerMinorUnits <= 0
  ) {
    return false;
  }
  const scaledLedger = BigInt(ledgerMinorUnits) * 10_000n;
  const source = BigInt(sourceMinorUnits);
  return (
    scaledLedger >=
      source * BigInt(MINIMUM_FOREIGN_LEDGER_RATIO_BASIS_POINTS) &&
    scaledLedger <= source * BigInt(MAXIMUM_FOREIGN_LEDGER_RATIO_BASIS_POINTS)
  );
}

export type ReceiptTransactionMatchResult =
  | {
      disposition: 'manual';
      reason: 'cash';
    }
  | {
      disposition: 'pending';
      plausibleCandidateCount: 0;
    }
  | {
      disposition: 'matched';
      candidate: ImportedTransactionCandidate;
      score: number;
      idempotent: boolean;
    }
  | {
      disposition: 'matched-set';
      candidates: readonly ImportedTransactionCandidate[];
      score: number;
      idempotent: boolean;
    }
  | {
      disposition: 'ambiguous';
      candidates: readonly {
        candidate: ImportedTransactionCandidate;
        score: number;
      }[];
    }
  | {
      disposition: 'ambiguous-set';
      candidateSets: readonly {
        candidates: readonly ImportedTransactionCandidate[];
        score: number;
      }[];
    };

export type ReceiptMatchIntentBuildResult =
  | {
      disposition: 'ready';
      intent: ReceiptMatchIntent;
    }
  | {
      disposition: 'review';
      reason:
        | 'receipt-not-ready'
        | 'merchant-missing'
        | 'date-missing'
        | 'currency-missing'
        | 'total-missing';
    };

const MATCHING_NON_BLOCKING_ISSUE_CODES = new Set([
  'amounts-incomplete',
  'line-items-incomplete',
  'line-items-mismatch',
]);

function receiptProposalIsReadyForMatching(
  proposal: ReceiptModelProposalV1,
): boolean {
  // A ledger match uses the receipt-level merchant, date, currency, and total.
  // Item extraction and full header arithmetic are independently useful for
  // categorization, but they cannot make clear receipt-level merchant, date,
  // currency, and total facts unsafe to match. Material uncertainty and
  // contradictory arithmetic still block.
  const matchingAssessment = assessReceiptModelProposal({
    ...proposal,
    uncertainties: proposal.uncertainties.filter(
      (uncertainty) => uncertainty.code !== 'line-items-unclear',
    ),
  });
  return matchingAssessment.issueCodes.every((issueCode) =>
    MATCHING_NON_BLOCKING_ISSUE_CODES.has(issueCode),
  );
}

/**
 * Builds a provisional match intent while receipt extraction is still in
 * progress. Post-publication callers must use buildReceiptMatchIntent so they
 * consume the canonical Actual receipt record instead of model provenance.
 */
export function buildExtractedReceiptMatchIntent(
  receiptId: string,
  untrustedProposal: ReceiptModelProposalV1,
): ReceiptMatchIntentBuildResult {
  const proposal = canonicalizeHouseholdReceiptCurrency(
    receiptModelProposalV1Schema.parse(untrustedProposal),
  );
  if (proposal.merchant.value === null) {
    return { disposition: 'review', reason: 'merchant-missing' };
  }
  if (proposal.purchaseDate.value === null) {
    return { disposition: 'review', reason: 'date-missing' };
  }
  if (proposal.currency.value === null) {
    return { disposition: 'review', reason: 'currency-missing' };
  }
  if (proposal.amounts.total.valueMinor === null) {
    return { disposition: 'review', reason: 'total-missing' };
  }
  if (
    proposal.amounts.total.valueMinor <= 0 ||
    proposal.merchant.value.length > 300
  ) {
    return { disposition: 'review', reason: 'receipt-not-ready' };
  }
  if (!receiptProposalIsReadyForMatching(proposal)) {
    return { disposition: 'review', reason: 'receipt-not-ready' };
  }
  const paymentEvidence =
    proposal.paymentEvidence.kind === 'masked-card' &&
    proposal.paymentEvidence.lastFour !== null
      ? {
          kind: 'masked-card' as const,
          lastFour: proposal.paymentEvidence.lastFour,
        }
      : proposal.paymentEvidence.kind === 'cash'
        ? { kind: 'cash' as const }
        : { kind: 'unknown' as const };
  const intent = receiptMatchIntentSchema.safeParse({
    schemaVersion: 'receipt-match-intent.v1',
    receiptId,
    merchantName: proposal.merchant.value,
    purchaseDate: proposal.purchaseDate.value,
    currency: proposal.currency.value,
    totalMinorUnits: proposal.amounts.total.valueMinor,
    paymentEvidence,
  });
  if (!intent.success) {
    return { disposition: 'review', reason: 'receipt-not-ready' };
  }
  return {
    disposition: 'ready',
    intent: intent.data,
  };
}

/** Builds a ledger-match intent from the canonical receipt facts in Actual. */
export function buildReceiptMatchIntent(
  untrustedRecord: HouseholdFinanceActiveReceiptRecordV1,
): ReceiptMatchIntentBuildResult {
  const record =
    householdFinanceActiveReceiptRecordSchema.parse(untrustedRecord);
  if (record.merchant === null) {
    return { disposition: 'review', reason: 'merchant-missing' };
  }
  if (record.purchaseDate === null) {
    return { disposition: 'review', reason: 'date-missing' };
  }
  if (record.currency === null) {
    return { disposition: 'review', reason: 'currency-missing' };
  }
  if (record.amounts.totalMinor === null) {
    return { disposition: 'review', reason: 'total-missing' };
  }
  if (
    record.extraction.automaticProcessingBlocked === true ||
    record.amounts.totalMinor <= 0 ||
    record.merchant.length > 300
  ) {
    return { disposition: 'review', reason: 'receipt-not-ready' };
  }
  const intent = receiptMatchIntentSchema.safeParse({
    schemaVersion: 'receipt-match-intent.v1',
    receiptId: record.receiptId,
    merchantName: record.merchant,
    purchaseDate: record.purchaseDate,
    currency: record.currency,
    totalMinorUnits: record.amounts.totalMinor,
    paymentEvidence:
      record.paymentEvidence.kind === 'masked-card'
        ? {
            kind: 'masked-card',
            lastFour: record.paymentEvidence.lastFour,
          }
        : { kind: record.paymentEvidence.kind },
  });
  if (!intent.success) {
    return { disposition: 'review', reason: 'receipt-not-ready' };
  }
  return { disposition: 'ready', intent: intent.data };
}

function utcDay(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('Invalid ISO date');
  }
  return Math.trunc(timestamp / 86_400_000);
}

function normalizedMerchant(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function canonicalMerchant(value: string): string {
  const normalized = normalizedMerchant(value);
  if (normalized === 'mec') {
    return 'mountain equipment company';
  }
  if (normalized.split(' ').includes('superstore')) {
    return 'superstore';
  }
  return normalized;
}

const MERCHANT_TOKEN_ALIASES = new Map<string, string>([
  ['amzn', 'amazon'],
  ['mkt', 'market'],
  ['mktp', 'marketplace'],
  ['whse', 'wholesale'],
]);

const MERCHANT_NOISE_TOKENS = new Set([
  'authorized',
  'aud',
  'ca',
  'cad',
  'can',
  'canada',
  'co',
  'com',
  'corp',
  'credit',
  'debit',
  'eur',
  'gbp',
  'inc',
  'jpy',
  'ltd',
  'llc',
  'nzd',
  'pos',
  'purchase',
  'ulc',
  'usd',
  'www',
]);

function merchantTokens(value: string): string[] {
  return canonicalMerchant(value)
    .split(' ')
    .filter((token) => token.length > 0 && !/^\d+$/u.test(token))
    .map((token) => MERCHANT_TOKEN_ALIASES.get(token) ?? token)
    .filter((token) => !MERCHANT_NOISE_TOKENS.has(token));
}

function merchantScore(receiptMerchant: string, candidateText: string): number {
  const receipt = canonicalMerchant(receiptMerchant);
  const candidate = canonicalMerchant(candidateText);
  if (receipt === candidate) {
    return 100;
  }
  const receiptTokens = new Set(merchantTokens(receiptMerchant));
  const candidateTokens = new Set(merchantTokens(candidateText));
  if (receiptTokens.size === 0 || candidateTokens.size === 0) {
    return 0;
  }
  const receiptTokenText = [...receiptTokens].join(' ');
  const candidateTokenText = [...candidateTokens].join(' ');
  if (
    receiptTokenText === candidateTokenText ||
    receiptTokenText.replaceAll(' ', '') ===
      candidateTokenText.replaceAll(' ', '')
  ) {
    return 100;
  }
  const intersection = [...receiptTokens].filter((token) =>
    candidateTokens.has(token),
  ).length;
  if (intersection === Math.min(receiptTokens.size, candidateTokens.size)) {
    return 85;
  }
  const union = new Set([...receiptTokens, ...candidateTokens]).size;
  return Math.floor((intersection / union) * 100);
}

function candidateMerchantScore(
  receiptMerchant: string,
  candidate: ImportedTransactionCandidate,
): number {
  return Math.max(
    ...[candidate.payeeName, candidate.statementDescription]
      .filter((value): value is string => value !== null && value !== undefined)
      .map((value) => merchantScore(receiptMerchant, value)),
    0,
  );
}

function parseDecimalMinorUnits(value: string): number | undefined {
  const normalized = value.replaceAll(',', '');
  const match = /^(\d+)\.(\d{2})$/u.exec(normalized);
  if (match === null) {
    return undefined;
  }
  const minor = BigInt(match[1]!) * 100n + BigInt(match[2]!);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(minor);
}

function currencyTaggedAmounts(
  text: string,
  currency: string,
): readonly number[] {
  const normalized = text.normalize('NFKC').toUpperCase();
  const escapedCurrency = currency.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const amount = '(\\d{1,9}(?:,\\d{3})*\\.\\d{2})';
  const patterns = [
    new RegExp(
      `(?:^|[^A-Z0-9])${escapedCurrency}\\s*\\$?\\s*${amount}(?=$|[^0-9])`,
      'gu',
    ),
    new RegExp(
      `(?:^|[^0-9])\\$?\\s*${amount}\\s*${escapedCurrency}(?=$|[^A-Z0-9])`,
      'gu',
    ),
  ];
  const values: number[] = [];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const parsed = parseDecimalMinorUnits(match[1]!);
      if (parsed !== undefined) {
        values.push(parsed);
      }
    }
  }
  return values;
}

type ForeignSourceAmountEvidence = 'none' | 'exact' | 'conflicting';

function foreignSourceAmountEvidence(
  receipt: ReceiptMatchIntent,
  candidate: ImportedTransactionCandidate,
): ForeignSourceAmountEvidence {
  const taggedAmounts = new Set(
    [candidate.payeeName, candidate.statementDescription]
      .filter((value): value is string => value !== null && value !== undefined)
      .flatMap((value) => currencyTaggedAmounts(value, receipt.currency)),
  );
  if (taggedAmounts.size === 0) {
    return 'none';
  }
  return taggedAmounts.size === 1 && taggedAmounts.has(receipt.totalMinorUnits)
    ? 'exact'
    : 'conflicting';
}

function validatedPolicy(policy: ReceiptMatchPolicy): ReceiptMatchPolicy {
  const values = [
    policy.earliestPostingDaysBeforePurchase,
    policy.latestPostingDaysAfterPurchase,
    policy.minimumMerchantScore,
    policy.minimumWinningMargin,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    policy.earliestPostingDaysBeforePurchase > 7 ||
    policy.latestPostingDaysAfterPurchase > 30 ||
    policy.minimumMerchantScore > 100 ||
    policy.minimumWinningMargin > 100
  ) {
    throw new RangeError('Receipt match policy is invalid');
  }
  return policy;
}

function scoreCandidate(
  receipt: ReceiptMatchIntent,
  candidate: ImportedTransactionCandidate,
  policy: ReceiptMatchPolicy,
): number | undefined {
  const foreignCurrency = receipt.currency !== candidate.currency;
  const exactPriorLink = linksReceipt(candidate, receipt.receiptId);
  if (
    (candidate.alreadyLinkedReceipts.length > 0 && !exactPriorLink) ||
    (!foreignCurrency &&
      -candidate.amountMinorUnits !== receipt.totalMinorUnits) ||
    (foreignCurrency &&
      !exactPriorLink &&
      !plausibleForeignLedgerAmount(
        receipt.totalMinorUnits,
        -candidate.amountMinorUnits,
      ))
  ) {
    return undefined;
  }
  const purchaseDay = utcDay(receipt.purchaseDate);
  const postingDay = utcDay(candidate.postingDate);
  const difference = postingDay - purchaseDay;
  if (
    difference < -policy.earliestPostingDaysBeforePurchase ||
    difference > policy.latestPostingDaysAfterPurchase
  ) {
    return undefined;
  }
  if (
    !exactPriorLink &&
    receipt.paymentEvidence.kind === 'masked-card' &&
    candidate.accountLastFour !== null &&
    candidate.accountLastFour !== receipt.paymentEvidence.lastFour
  ) {
    return undefined;
  }
  const nameScore = candidateMerchantScore(receipt.merchantName, candidate);
  const hasMerchantText =
    candidate.payeeName !== null ||
    (candidate.statementDescription !== null &&
      candidate.statementDescription !== undefined);
  const exactAccountEvidence =
    receipt.paymentEvidence.kind === 'masked-card' &&
    candidate.accountLastFour === receipt.paymentEvidence.lastFour;
  if (
    (!exactPriorLink &&
      nameScore < policy.minimumMerchantScore &&
      (hasMerchantText || foreignCurrency)) ||
    (!exactPriorLink && !hasMerchantText && !exactAccountEvidence)
  ) {
    return undefined;
  }

  const dateScore = Math.max(0, 14 - Math.abs(difference) * 2);
  const accountScore = exactAccountEvidence ? 20 : 0;
  const sourceAmountScore =
    foreignCurrency &&
    foreignSourceAmountEvidence(receipt, candidate) === 'exact'
      ? 30
      : 0;
  const alreadyLinkedScore = exactPriorLink ? 1_000 : 0;
  return (
    alreadyLinkedScore +
    nameScore +
    dateScore +
    accountScore +
    sourceAmountScore
  );
}

interface ScoredCandidate {
  readonly candidate: ImportedTransactionCandidate;
  readonly score: number;
}

function compareScoredCandidates(
  left: ScoredCandidate,
  right: ScoredCandidate,
): number {
  return (
    right.score - left.score ||
    left.candidate.importedId.localeCompare(right.candidate.importedId)
  );
}

function subsetCandidateScore(
  receipt: ReceiptMatchIntent,
  candidate: ImportedTransactionCandidate,
  policy: ReceiptMatchPolicy,
): number | undefined {
  if (
    receipt.currency !== candidate.currency ||
    -candidate.amountMinorUnits >= receipt.totalMinorUnits ||
    (candidate.alreadyLinkedReceipts.length > 0 &&
      !linksReceipt(candidate, receipt.receiptId))
  ) {
    return undefined;
  }
  const purchaseDay = utcDay(receipt.purchaseDate);
  const postingDay = utcDay(candidate.postingDate);
  const difference = postingDay - purchaseDay;
  if (
    difference < -policy.earliestPostingDaysBeforePurchase ||
    difference > policy.latestPostingDaysAfterPurchase
  ) {
    return undefined;
  }
  if (
    receipt.paymentEvidence.kind === 'masked-card' &&
    candidate.accountLastFour !== null &&
    candidate.accountLastFour !== receipt.paymentEvidence.lastFour
  ) {
    return undefined;
  }
  const nameScore = candidateMerchantScore(receipt.merchantName, candidate);
  const hasMerchantText =
    candidate.payeeName !== null ||
    (candidate.statementDescription !== null &&
      candidate.statementDescription !== undefined);
  const exactAccountEvidence =
    receipt.paymentEvidence.kind === 'masked-card' &&
    candidate.accountLastFour === receipt.paymentEvidence.lastFour;
  if (
    (hasMerchantText && nameScore < policy.minimumMerchantScore) ||
    (!hasMerchantText && !exactAccountEvidence)
  ) {
    return undefined;
  }
  const dateScore = Math.max(0, 14 - Math.abs(difference) * 2);
  const accountScore = exactAccountEvidence ? 20 : 0;
  const alreadyLinkedScore = linksReceipt(candidate, receipt.receiptId)
    ? 1_000
    : 0;
  return alreadyLinkedScore + nameScore + dateScore + accountScore;
}

interface ScoredCandidateSet {
  readonly candidates: readonly ImportedTransactionCandidate[];
  readonly score: number;
}

function exactSubsetMatches(
  receipt: ReceiptMatchIntent,
  candidates: readonly ImportedTransactionCandidate[],
  policy: ReceiptMatchPolicy,
): readonly ScoredCandidateSet[] {
  const compatible = candidates
    .map((candidate): ScoredCandidate | undefined => {
      const score = subsetCandidateScore(receipt, candidate, policy);
      return score === undefined ? undefined : { candidate, score };
    })
    .filter((entry): entry is ScoredCandidate => entry !== undefined)
    .sort(compareScoredCandidates);
  if (compatible.length < 2 || compatible.length > MAXIMUM_SUBSET_CANDIDATES) {
    return [];
  }

  const byAccount = new Map<string, ScoredCandidate[]>();
  for (const entry of compatible) {
    const group = byAccount.get(entry.candidate.accountAlias) ?? [];
    group.push(entry);
    byAccount.set(entry.candidate.accountAlias, group);
  }

  const solutions: ScoredCandidateSet[] = [];
  for (const group of [...byAccount.values()].sort((left, right) =>
    left[0]!.candidate.accountAlias.localeCompare(
      right[0]!.candidate.accountAlias,
    ),
  )) {
    const ordered = [...group].sort((left, right) =>
      left.candidate.importedId.localeCompare(right.candidate.importedId),
    );
    const selected: ScoredCandidate[] = [];
    const visit = (index: number, sumMinorUnits: number): void => {
      if (solutions.length >= MAXIMUM_SUBSET_SOLUTIONS) {
        return;
      }
      if (sumMinorUnits === receipt.totalMinorUnits) {
        if (selected.length >= 2) {
          solutions.push({
            candidates: selected.map(({ candidate }) => candidate),
            score: Math.floor(
              selected.reduce((sum, entry) => sum + entry.score, 0) /
                selected.length,
            ),
          });
        }
        return;
      }
      if (
        sumMinorUnits > receipt.totalMinorUnits ||
        selected.length >= MAXIMUM_SUBSET_SIZE
      ) {
        return;
      }
      for (
        let candidateIndex = index;
        candidateIndex < ordered.length;
        candidateIndex += 1
      ) {
        const entry = ordered[candidateIndex]!;
        selected.push(entry);
        visit(
          candidateIndex + 1,
          sumMinorUnits - entry.candidate.amountMinorUnits,
        );
        selected.pop();
        if (solutions.length >= MAXIMUM_SUBSET_SOLUTIONS) {
          return;
        }
      }
    };
    visit(0, 0);
    if (solutions.length >= MAXIMUM_SUBSET_SOLUTIONS) {
      break;
    }
  }
  return solutions;
}

export function matchReceiptToImportedTransactions(
  untrustedReceipt: ReceiptMatchIntent,
  untrustedCandidates: readonly ImportedTransactionCandidate[],
  untrustedPolicy: ReceiptMatchPolicy = defaultReceiptMatchPolicy,
): ReceiptTransactionMatchResult {
  const receipt = receiptMatchIntentSchema.parse(untrustedReceipt);
  const candidates = untrustedCandidates.map((candidate) =>
    importedTransactionCandidateSchema.parse(candidate),
  );
  if (
    new Set(candidates.map(({ transactionId }) => transactionId)).size !==
      candidates.length ||
    new Set(
      candidates.map(
        ({ accountAlias, importedId }) => `${accountAlias}\0${importedId}`,
      ),
    ).size !== candidates.length
  ) {
    throw new TypeError(
      'Receipt candidates must identify distinct imported transactions',
    );
  }
  const policy = validatedPolicy(untrustedPolicy);
  if (receipt.paymentEvidence.kind === 'cash') {
    return { disposition: 'manual', reason: 'cash' };
  }

  const linkedCandidates = candidates.filter((candidate) =>
    linksReceipt(candidate, receipt.receiptId),
  );
  if (linkedCandidates.length > 0) {
    const linkedSingles = linkedCandidates
      .map((candidate): ScoredCandidate | undefined => {
        const score = scoreCandidate(receipt, candidate, policy);
        return score === undefined ? undefined : { candidate, score };
      })
      .filter((entry): entry is ScoredCandidate => entry !== undefined);
    const linkedSets = exactSubsetMatches(receipt, linkedCandidates, policy);
    const linkedSolutions: ScoredCandidateSet[] = [
      ...linkedSingles.map(({ candidate, score }) => ({
        candidates: [candidate],
        score,
      })),
      ...linkedSets,
    ];
    if (linkedSolutions.length === 1) {
      const solution = linkedSolutions[0]!;
      return solution.candidates.length === 1
        ? {
            disposition: 'matched',
            candidate: solution.candidates[0]!,
            score: solution.score,
            idempotent: true,
          }
        : {
            disposition: 'matched-set',
            candidates: solution.candidates,
            score: solution.score,
            idempotent: true,
          };
    }
    return {
      disposition: 'ambiguous-set',
      candidateSets:
        linkedSolutions.length > 0
          ? linkedSolutions
          : [{ candidates: linkedCandidates, score: 0 }],
    };
  }

  const plausible = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(receipt, candidate, policy),
    }))
    .filter(
      (
        value,
      ): value is {
        candidate: ImportedTransactionCandidate;
        score: number;
      } => value.score !== undefined,
    )
    .sort(compareScoredCandidates);
  if (plausible.length === 0) {
    const subsetMatches = exactSubsetMatches(receipt, candidates, policy);
    if (subsetMatches.length === 1) {
      const match = subsetMatches[0]!;
      return {
        disposition: 'matched-set',
        candidates: match.candidates,
        score: match.score,
        idempotent: match.candidates.every((candidate) =>
          linksReceipt(candidate, receipt.receiptId),
        ),
      };
    }
    if (subsetMatches.length > 1) {
      return {
        disposition: 'ambiguous-set',
        candidateSets: subsetMatches,
      };
    }
    return { disposition: 'pending', plausibleCandidateCount: 0 };
  }

  const exactPriorLink = plausible.filter(({ candidate }) =>
    linksReceipt(candidate, receipt.receiptId),
  );
  if (exactPriorLink.length === 1) {
    return {
      disposition: 'matched',
      candidate: exactPriorLink[0]!.candidate,
      score: exactPriorLink[0]!.score,
      idempotent: true,
    };
  }
  if (exactPriorLink.length > 1) {
    return { disposition: 'ambiguous', candidates: exactPriorLink };
  }

  const best = plausible[0]!;
  const second = plausible[1];
  const foreignCurrency = receipt.currency !== best.candidate.currency;
  const exactAccountEvidence =
    receipt.paymentEvidence.kind === 'masked-card' &&
    best.candidate.accountLastFour === receipt.paymentEvidence.lastFour;
  const bestSourceAmountEvidence = foreignCurrency
    ? foreignSourceAmountEvidence(receipt, best.candidate)
    : 'none';
  if (foreignCurrency && bestSourceAmountEvidence === 'conflicting') {
    return { disposition: 'ambiguous', candidates: plausible };
  }
  if (foreignCurrency && !exactAccountEvidence) {
    const exactSourceCandidates = plausible.filter(
      ({ candidate: plausibleCandidate }) =>
        foreignSourceAmountEvidence(receipt, plausibleCandidate) === 'exact',
    );
    if (
      exactSourceCandidates.length !== 1 ||
      exactSourceCandidates[0] !== best
    ) {
      return { disposition: 'ambiguous', candidates: plausible };
    }
  }
  if (
    second === undefined ||
    best.score - second.score >= policy.minimumWinningMargin
  ) {
    return {
      disposition: 'matched',
      candidate: best.candidate,
      score: best.score,
      idempotent: false,
    };
  }
  return { disposition: 'ambiguous', candidates: plausible };
}
