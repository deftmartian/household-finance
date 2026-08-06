import { createHash } from 'node:crypto';

import {
  receiptModelProposalV1Schema,
  type ReceiptModelRunMetadata,
  type ReceiptModelProposalV1,
} from '../model/index.js';
import { buildExtractedReceiptMatchIntent } from '../matching/index.js';
import {
  canonicalizeHouseholdFinanceReceiptHouseholdNotes,
  householdFinanceActiveReceiptRecordSchema,
  MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS,
  type HouseholdFinanceActiveReceiptRecordV1,
} from '../receipt-record/index.js';

const DEFAULT_BUNDLE_WINDOW_MS = 15 * 60 * 1_000;
const MAX_BUNDLE_CANDIDATES = MAX_HOUSEHOLD_FINANCE_RECEIPT_RECORDS * 2;

export interface ReceiptPhotoCandidate {
  readonly eventId: string;
  readonly roomToken: string;
  readonly actorId: string;
  readonly messageId: string;
  readonly receivedAt: string;
  readonly fileId: string;
  readonly archivePath: string;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
  readonly sourceSha256: string;
  readonly extractedAt: string;
  readonly modelMetadata: ReceiptModelRunMetadata;
  readonly receipt: ReceiptModelProposalV1;
  readonly captionHint?: string;
  /** Another non-ignored attachment in the same Talk post is not usable yet. */
  readonly relatedAttachmentBlocked?: boolean;
}

export interface ReceiptPhotoBundle {
  readonly receiptId: string;
  readonly bundleSha256: string;
  readonly receivedAt: string;
  readonly updatedAt: string;
  readonly sources: readonly ReceiptPhotoCandidate[];
  readonly householdNoteCandidates: readonly {
    readonly captionHint: string;
    readonly roomToken: string;
    readonly actorId: string;
    readonly messageId: string;
    readonly fileId: string;
    readonly receivedAt: string;
    readonly extractedAt: string;
  }[];
  readonly receipt: ReceiptModelProposalV1;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError('Receipt photo timestamp is invalid');
  }
  return parsed;
}

function normalizedText(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-CA')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function canonicalReceiptText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const withoutControls = [...value.normalize('NFC')]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined &&
        (codePoint <= 0x1f || codePoint === 0x7f)
        ? ' '
        : character;
    })
    .join('');
  const normalized = withoutControls.replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? null : normalized;
}

function purchasedLineItems(
  receipt: ReceiptModelProposalV1,
): ReceiptModelProposalV1['lineItems'] {
  const isCostco = normalizedText(receipt.merchant.value).includes('costco');
  if (!isCostco) return receipt.lineItems;
  return receipt.lineItems.filter(
    (item) => !/\btpd\s*\//iu.test(item.description ?? ''),
  );
}

function merchantInitials(value: string): string {
  return value
    .split(' ')
    .filter((token) => token.length > 0)
    .map((token) => token[0])
    .join('');
}

function compatibleOptional<T>(left: T | null, right: T | null): boolean {
  return left === null || right === null || left === right;
}

function lineKey(line: ReceiptModelProposalV1['lineItems'][number]): string {
  return [
    normalizedText(line.description),
    line.quantity ?? '',
    line.unitPriceMinor ?? '',
    line.totalMinor ?? '',
  ].join('\u0000');
}

function lineDescriptionTokens(receipt: ReceiptModelProposalV1): Set<string> {
  return new Set(
    receipt.lineItems.flatMap((line) => {
      const description = normalizedText(line.description);
      return description.length < 3 ? [] : [description];
    }),
  );
}

function lineOverlapCount(
  left: ReceiptModelProposalV1,
  right: ReceiptModelProposalV1,
): number {
  const leftLines = lineDescriptionTokens(left);
  const rightLines = lineDescriptionTokens(right);
  return [...leftLines].filter((line) => rightLines.has(line)).length;
}

function completeLineItemTotalMinor(
  receipt: ReceiptModelProposalV1,
): number | null {
  if (
    receipt.lineItems.length === 0 ||
    receipt.lineItems.some((line) => line.totalMinor === null)
  ) {
    return null;
  }
  return receipt.lineItems.reduce(
    (total, line) => total + (line.totalMinor ?? 0),
    0,
  );
}

function partialPagesFitKnownLineTotal(
  left: ReceiptModelProposalV1,
  right: ReceiptModelProposalV1,
): boolean {
  const leftLineTotal = completeLineItemTotalMinor(left);
  const rightLineTotal = completeLineItemTotalMinor(right);
  if (leftLineTotal === null || rightLineTotal === null) {
    return false;
  }
  const combinedLineTotal = leftLineTotal + rightLineTotal;
  return [left, right].some((receipt) =>
    [
      receipt.amounts.subtotal.valueMinor,
      receipt.amounts.total.valueMinor,
    ].includes(combinedLineTotal),
  );
}

function sameReceipt(
  left: ReceiptPhotoCandidate,
  right: ReceiptPhotoCandidate,
  windowMs: number,
): boolean {
  if (
    left.roomToken !== right.roomToken ||
    left.actorId !== right.actorId ||
    Math.abs(instant(left.receivedAt) - instant(right.receivedAt)) > windowMs
  ) {
    return false;
  }
  const leftReceipt = left.receipt;
  const rightReceipt = right.receipt;
  if (
    !compatibleOptional(
      leftReceipt.purchaseDate.value,
      rightReceipt.purchaseDate.value,
    ) ||
    !compatibleOptional(
      leftReceipt.currency.value,
      rightReceipt.currency.value,
    ) ||
    !compatibleOptional(
      leftReceipt.amounts.total.valueMinor,
      rightReceipt.amounts.total.valueMinor,
    )
  ) {
    return false;
  }

  const leftReference = normalizedText(leftReceipt.receiptReference.value);
  const rightReference = normalizedText(rightReceipt.receiptReference.value);
  if (
    leftReference.length > 0 &&
    rightReference.length > 0 &&
    leftReference !== rightReference
  ) {
    return false;
  }
  const exactReference =
    leftReference.length > 0 && leftReference === rightReference;

  const leftMerchant = normalizedText(leftReceipt.merchant.value);
  const rightMerchant = normalizedText(rightReceipt.merchant.value);
  const merchantCompatible =
    leftMerchant.length === 0 ||
    rightMerchant.length === 0 ||
    leftMerchant === rightMerchant ||
    leftMerchant.includes(rightMerchant) ||
    rightMerchant.includes(leftMerchant) ||
    merchantInitials(leftMerchant) === rightMerchant ||
    merchantInitials(rightMerchant) === leftMerchant;
  if (!merchantCompatible) {
    return false;
  }
  if (exactReference) {
    return true;
  }

  const overlapCount = lineOverlapCount(leftReceipt, rightReceipt);
  const smallerLineCount = Math.min(
    lineDescriptionTokens(leftReceipt).size,
    lineDescriptionTokens(rightReceipt).size,
  );
  const strongLineOverlap =
    overlapCount >= 2 ||
    (overlapCount >= 1 && overlapCount === smallerLineCount);
  const exactTotal =
    leftReceipt.amounts.total.valueMinor !== null &&
    leftReceipt.amounts.total.valueMinor ===
      rightReceipt.amounts.total.valueMinor;
  const exactDate =
    leftReceipt.purchaseDate.value !== null &&
    leftReceipt.purchaseDate.value === rightReceipt.purchaseDate.value;
  const sameMessagePartialPage =
    left.messageId === right.messageId &&
    (leftMerchant.length > 0 || rightMerchant.length > 0) &&
    (leftReceipt.amounts.total.valueMinor === null ||
      rightReceipt.amounts.total.valueMinor === null) &&
    partialPagesFitKnownLineTotal(leftReceipt, rightReceipt);
  return (
    strongLineOverlap ||
    sameMessagePartialPage ||
    (exactTotal &&
      (leftReceipt.lineItems.length === 0 ||
        rightReceipt.lineItems.length === 0) &&
      (exactDate ||
        leftReceipt.purchaseDate.value === null ||
        rightReceipt.purchaseDate.value === null))
  );
}

function evidenceRank(
  evidence: 'explicit' | 'derived' | 'inferred' | 'absent' | 'unreadable',
): number {
  switch (evidence) {
    case 'explicit':
      return 4;
    case 'derived':
      return 3;
    case 'inferred':
      return 2;
    case 'unreadable':
      return 1;
    case 'absent':
      return 0;
  }
}

function observedFieldScore(field: {
  readonly evidence: Parameters<typeof evidenceRank>[0];
  readonly confidence: number;
  readonly sourcePage: number | null;
  readonly value?: unknown;
  readonly valueMinor?: number | null;
}): number {
  const value = 'valueMinor' in field ? field.valueMinor : field.value;
  return (
    (value === null ? 0 : 10_000) +
    evidenceRank(field.evidence) * 1_000 +
    Math.round(field.confidence * 100) +
    (field.sourcePage === null ? 0 : 1)
  );
}

function bestField<
  T extends {
    readonly evidence: Parameters<typeof evidenceRank>[0];
    readonly confidence: number;
    readonly sourcePage: number | null;
  },
>(candidates: readonly T[]): T {
  return [...candidates].sort(
    (left, right) => observedFieldScore(right) - observedFieldScore(left),
  )[0]!;
}

function paymentScore(
  value: ReceiptModelProposalV1['paymentEvidence'],
): number {
  return (
    (value.kind === 'masked-card'
      ? 10_000
      : value.kind === 'cash'
        ? 9_000
        : 0) +
    Math.round(value.confidence * 100) +
    (value.sourcePage === null ? 0 : 1)
  );
}

function mergeReceipts(
  sources: readonly ReceiptPhotoCandidate[],
): ReceiptModelProposalV1 {
  const proposals = sources.map((source) => source.receipt);
  const lines = new Map<
    string,
    ReceiptModelProposalV1['lineItems'][number][]
  >();
  for (const proposal of proposals) {
    const proposalLines = new Map<
      string,
      ReceiptModelProposalV1['lineItems'][number][]
    >();
    for (const line of proposal.lineItems) {
      const key = lineKey(line);
      const occurrences = proposalLines.get(key) ?? [];
      occurrences.push(line);
      proposalLines.set(key, occurrences);
    }
    for (const [key, occurrences] of proposalLines) {
      const merged = lines.get(key) ?? [];
      for (const [index, line] of occurrences.entries()) {
        const existing = merged[index];
        if (existing === undefined || line.confidence > existing.confidence) {
          merged[index] = line;
        }
      }
      lines.set(key, merged);
    }
  }
  const uncertainties = new Map<
    string,
    ReceiptModelProposalV1['uncertainties'][number]
  >();
  for (const proposal of proposals) {
    for (const uncertainty of proposal.uncertainties) {
      const key = `${uncertainty.code}\u0000${uncertainty.message}`;
      uncertainties.set(key, uncertainty);
    }
  }
  const payments = proposals
    .map((proposal) => proposal.paymentEvidence)
    .sort((left, right) => paymentScore(right) - paymentScore(left));

  return receiptModelProposalV1Schema.parse({
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: proposals.some(
      (proposal) => proposal.documentDisposition === 'single-receipt',
    )
      ? 'single-receipt'
      : proposals[0]!.documentDisposition,
    merchant: bestField(proposals.map((proposal) => proposal.merchant)),
    purchaseDate: bestField(proposals.map((proposal) => proposal.purchaseDate)),
    purchaseTime: bestField(proposals.map((proposal) => proposal.purchaseTime)),
    timezoneOffset: bestField(
      proposals.map((proposal) => proposal.timezoneOffset),
    ),
    currency: bestField(proposals.map((proposal) => proposal.currency)),
    amounts: {
      subtotal: bestField(
        proposals.map((proposal) => proposal.amounts.subtotal),
      ),
      tax: bestField(proposals.map((proposal) => proposal.amounts.tax)),
      discount: bestField(
        proposals.map((proposal) => proposal.amounts.discount),
      ),
      tip: bestField(proposals.map((proposal) => proposal.amounts.tip)),
      total: bestField(proposals.map((proposal) => proposal.amounts.total)),
    },
    paymentEvidence: payments[0]!,
    receiptReference: bestField(
      proposals.map((proposal) => proposal.receiptReference),
    ),
    lineItems: [...lines.values()].flat().slice(0, 200),
    uncertainties: [...uncertainties.values()].slice(0, 100),
  });
}

function bundleHash(sources: readonly ReceiptPhotoCandidate[]): string {
  const hash = createHash('sha256').update('receipt-photo-bundle.v1\0');
  for (const source of sources) {
    hash.update(source.sourceSha256).update('\0');
  }
  return hash.digest('hex');
}

export function bundleReceiptPhotos(
  candidatesInput: readonly ReceiptPhotoCandidate[],
  windowMs = DEFAULT_BUNDLE_WINDOW_MS,
): readonly ReceiptPhotoBundle[] {
  if (
    candidatesInput.length > MAX_BUNDLE_CANDIDATES ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 0 ||
    windowMs > 60 * 60 * 1_000
  ) {
    throw new RangeError('Receipt photo bundle input is outside safe bounds');
  }
  const validatedCandidates: ReceiptPhotoCandidate[] = [];
  const byHash = new Map<string, ReceiptPhotoCandidate>();
  for (const candidateInput of candidatesInput) {
    const candidate = {
      ...candidateInput,
      receipt: receiptModelProposalV1Schema.parse(candidateInput.receipt),
    };
    if (
      !/^[a-f0-9]{64}$/.test(candidate.sourceSha256) ||
      candidate.archivePath.length === 0 ||
      candidate.archivePath.includes('\0')
    ) {
      throw new TypeError('Receipt photo source is invalid');
    }
    instant(candidate.receivedAt);
    instant(candidate.extractedAt);
    validatedCandidates.push(candidate);
    const existing = byHash.get(candidate.sourceSha256);
    if (
      existing === undefined ||
      instant(candidate.receivedAt) < instant(existing.receivedAt) ||
      (candidate.receivedAt === existing.receivedAt &&
        candidate.eventId < existing.eventId)
    ) {
      byHash.set(candidate.sourceSha256, candidate);
    }
  }
  const candidates = [...byHash.values()].sort(
    (left, right) =>
      instant(left.receivedAt) - instant(right.receivedAt) ||
      left.eventId.localeCompare(right.eventId),
  );
  const groups: ReceiptPhotoCandidate[][] = [];
  for (const candidate of candidates) {
    const compatible = groups.filter((group) =>
      group.every((member) => sameReceipt(member, candidate, windowMs)),
    );
    if (compatible.length !== 1) {
      groups.push([candidate]);
      continue;
    }
    compatible[0]!.push(candidate);
  }
  return groups.map((sources) => {
    const sourceHashes = new Set(sources.map((source) => source.sourceSha256));
    const householdNoteCandidates = validatedCandidates
      .filter(
        (candidate) =>
          sourceHashes.has(candidate.sourceSha256) &&
          candidate.captionHint !== undefined,
      )
      .sort(
        (left, right) =>
          instant(left.receivedAt) - instant(right.receivedAt) ||
          left.messageId.localeCompare(right.messageId, 'en', {
            numeric: true,
          }) ||
          left.fileId.localeCompare(right.fileId, 'en', { numeric: true }) ||
          left.eventId.localeCompare(right.eventId),
      )
      .map((candidate) => ({
        captionHint: candidate.captionHint!,
        roomToken: candidate.roomToken,
        actorId: candidate.actorId,
        messageId: candidate.messageId,
        fileId: candidate.fileId,
        receivedAt: candidate.receivedAt,
        extractedAt: candidate.extractedAt,
      }));
    const observedCandidates = validatedCandidates.filter((candidate) =>
      sourceHashes.has(candidate.sourceSha256),
    );
    const updatedAt = new Date(
      Math.max(
        ...observedCandidates.flatMap((candidate) => [
          instant(candidate.receivedAt),
          instant(candidate.extractedAt),
        ]),
      ),
    ).toISOString();
    return {
      receiptId: sources[0]!.eventId,
      bundleSha256: bundleHash(sources),
      receivedAt: sources[0]!.receivedAt,
      updatedAt,
      sources,
      householdNoteCandidates,
      receipt: mergeReceipts(sources),
    };
  });
}

export function buildActiveReceiptRecord(
  bundle: ReceiptPhotoBundle,
  previous?: HouseholdFinanceActiveReceiptRecordV1,
): HouseholdFinanceActiveReceiptRecordV1 {
  if (
    previous !== undefined &&
    (previous.receiptId !== bundle.receiptId || previous.status !== 'active')
  ) {
    throw new TypeError('Receipt record revision does not match its bundle');
  }
  const latestExtraction = [...bundle.sources].sort(
    (left, right) =>
      instant(right.extractedAt) - instant(left.extractedAt) ||
      right.eventId.localeCompare(left.eventId),
  )[0]!;
  const extractedAt = bundle.updatedAt;
  const updatedAt = new Date(
    Math.max(
      instant(bundle.updatedAt),
      previous === undefined
        ? Number.NEGATIVE_INFINITY
        : instant(previous.updatedAt),
    ),
  ).toISOString();
  const receipt = receiptModelProposalV1Schema.parse({
    ...bundle.receipt,
    lineItems: purchasedLineItems(bundle.receipt),
  });
  const sourceDocumentBlocked = bundle.sources.some(
    (source) =>
      source.receipt.documentDisposition === 'multiple-receipts' ||
      source.receipt.documentDisposition === 'not-receipt',
  );
  const knownPayments = new Set(
    bundle.sources.flatMap((source) => {
      const payment = source.receipt.paymentEvidence;
      return payment.kind === 'unknown'
        ? []
        : [`${payment.kind}:${payment.lastFour ?? ''}`];
    }),
  );
  const automaticProcessingBlocked =
    sourceDocumentBlocked ||
    bundle.sources.some((source) => source.relatedAttachmentBlocked === true) ||
    knownPayments.size > 1 ||
    receipt.paymentEvidence.kind === 'cash' ||
    buildExtractedReceiptMatchIntent(bundle.receiptId, receipt).disposition !==
      'ready';
  const itemSplitBlocked = receipt.uncertainties.some(
    (uncertainty) =>
      uncertainty.material && uncertainty.code === 'line-items-unclear',
  );
  const previousSourceIdentities = new Set(
    previous?.sources.map(
      (source) =>
        `${source.talk.roomToken}\u0000${source.talk.messageId}\u0000${source.nextcloudFileId}`,
    ) ?? [],
  );
  const householdNotes = canonicalizeHouseholdFinanceReceiptHouseholdNotes([
    ...(previous?.householdNotes ?? []),
    ...bundle.householdNoteCandidates.flatMap((candidate) => {
      const sourceIdentity = `${candidate.roomToken}\u0000${candidate.messageId}\u0000${candidate.fileId}`;
      if (
        previous !== undefined &&
        (previousSourceIdentities.has(sourceIdentity) ||
          instant(candidate.extractedAt) <= instant(previous.updatedAt))
      ) {
        return [];
      }
      const text = canonicalReceiptText(candidate.captionHint);
      return text === null
        ? []
        : [
            {
              text,
              receivedAt: candidate.receivedAt,
              talk: {
                roomToken: candidate.roomToken,
                actorId: candidate.actorId,
                messageId: candidate.messageId,
              },
            },
          ];
    }),
  ]);
  return householdFinanceActiveReceiptRecordSchema.parse({
    schemaVersion: 'household-finance.receipt.v1',
    receiptId: bundle.receiptId,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? bundle.receivedAt,
    updatedAt,
    sources: bundle.sources.map((source) => ({
      nextcloudFileId: source.fileId,
      archivePath: source.archivePath,
      sha256: source.sourceSha256,
      mediaType: source.mediaType,
      receivedAt: source.receivedAt,
      talk: {
        roomToken: source.roomToken,
        actorId: source.actorId,
        messageId: source.messageId,
      },
    })),
    status: 'active',
    merchant: canonicalReceiptText(receipt.merchant.value),
    purchaseDate: receipt.purchaseDate.value,
    purchaseTime: receipt.purchaseTime.value,
    timezoneOffset: receipt.timezoneOffset.value,
    currency: receipt.currency.value,
    amounts: {
      subtotalMinor: receipt.amounts.subtotal.valueMinor,
      taxMinor: receipt.amounts.tax.valueMinor,
      discountMinor: receipt.amounts.discount.valueMinor,
      tipMinor: receipt.amounts.tip.valueMinor,
      totalMinor: receipt.amounts.total.valueMinor,
    },
    paymentEvidence: {
      kind: receipt.paymentEvidence.kind,
      lastFour: receipt.paymentEvidence.lastFour,
    },
    receiptReference: canonicalReceiptText(receipt.receiptReference.value),
    ...(householdNotes.length === 0 ? {} : { householdNotes }),
    items: receipt.lineItems
      .map((item) => ({
        description: canonicalReceiptText(item.description),
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        totalMinor: item.totalMinor,
      }))
      .filter(
        (item) =>
          item.description !== null ||
          item.quantity !== null ||
          item.unitPriceMinor !== null ||
          item.totalMinor !== null,
      ),
    extraction: {
      provider: latestExtraction.modelMetadata.provider,
      requestedModel: latestExtraction.modelMetadata.requestedModel,
      resolvedModel: latestExtraction.modelMetadata.resolvedModel,
      zeroDataRetention: true,
      extractedAt,
      ...(automaticProcessingBlocked
        ? { automaticProcessingBlocked: true }
        : {}),
      ...(itemSplitBlocked ? { itemSplitBlocked: true } : {}),
      sourceSha256s: bundle.sources.map((source) => source.sourceSha256),
    },
  });
}
