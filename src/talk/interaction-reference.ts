import { z } from 'zod';

export const financeInteractionKinds = [
  'transaction-category',
  'receipt-category',
  'receipt-match',
  'actual-update',
] as const;

export type FinanceInteractionKind = (typeof financeInteractionKinds)[number];

export interface FinanceInteractionReference {
  readonly kind: FinanceInteractionKind;
  readonly referenceId: string;
}

const referenceSchema = z.strictObject({
  kind: z.enum(financeInteractionKinds),
  referenceId: z.string().regex(/^[a-f0-9]{64}$/),
});
const markerPattern =
  /(?:^|\n)Finance reference: (transaction-category|receipt-category|receipt-match|actual-update)\/([a-f0-9]{64})$/;

export function appendFinanceInteractionReference(
  message: string,
  reference: FinanceInteractionReference,
): string {
  const parsed = referenceSchema.parse(reference);
  const normalized = z
    .string()
    .min(1)
    .max(1_880)
    .parse(message.normalize('NFC').trim());
  if (markerPattern.test(normalized)) {
    throw new TypeError('Finance interaction message already has a marker');
  }
  return `${normalized}\n\nReply directly to this message.\nFinance reference: ${parsed.kind}/${parsed.referenceId}`;
}

export function extractFinanceInteractionReference(
  message: string,
): FinanceInteractionReference | undefined {
  const match = markerPattern.exec(message.normalize('NFC').trim());
  if (match === null) {
    return undefined;
  }
  const parsed = referenceSchema.safeParse({
    kind: match[1],
    referenceId: match[2],
  });
  return parsed.success ? parsed.data : undefined;
}

export function stripFinanceInteractionReference(message: string): string {
  const normalized = message.normalize('NFC').trim();
  return normalized
    .replace(
      /\n\nReply directly to this message\.\nFinance reference: (?:transaction-category|receipt-category|receipt-match|actual-update)\/[a-f0-9]{64}$/,
      '',
    )
    .trim();
}
