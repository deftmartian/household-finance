import { createHash } from 'node:crypto';

const scopePattern = /^[a-z][a-z0-9-]{0,63}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function createStableIdempotencyKey(
  scope: string,
  parts: Readonly<Record<string, string>>,
): string {
  if (!scopePattern.test(scope)) {
    throw new TypeError(
      'Idempotency scope must start with a lowercase letter and contain only lowercase letters, digits, and hyphens',
    );
  }

  const entries = Object.entries(parts).sort(([left], [right]) =>
    compareText(left, right),
  );
  if (entries.length === 0) {
    throw new TypeError('At least one idempotency component is required');
  }

  for (const [name, value] of entries) {
    if (name.length === 0 || value.length === 0) {
      throw new TypeError(
        'Idempotency component names and values cannot be empty',
      );
    }
  }

  const canonicalParts = JSON.stringify(entries);
  const digest = createHash('sha256').update(canonicalParts).digest('hex');
  return `${scope}:v1:${digest}`;
}

function assertSourceSha256(sourceSha256: string): string {
  if (!sha256Pattern.test(sourceSha256)) {
    throw new TypeError('Receipt source SHA-256 must be lowercase hexadecimal');
  }
  return sourceSha256;
}

export function createReceiptDocumentIdempotencyKey(
  sourceSha256: string,
): string {
  return createStableIdempotencyKey('receipt-document', {
    sourceSha256: assertSourceSha256(sourceSha256),
  });
}

export function createAttachmentTalkReplyReferenceId(
  eventIdempotencyKey: string,
  purpose: string,
): string {
  if (eventIdempotencyKey.length === 0 || purpose.length === 0) {
    throw new TypeError('Attachment reply identity components cannot be empty');
  }
  return createHash('sha256')
    .update('finance-attachment-talk-reply-v1\0')
    .update(eventIdempotencyKey)
    .update('\0')
    .update(purpose)
    .digest('hex');
}

export function createQuestionTalkReplyReferenceId(
  eventIdempotencyKey: string,
  purpose: 'answered' | 'failed',
): string {
  if (eventIdempotencyKey.length === 0) {
    throw new TypeError('Question reply identity cannot be empty');
  }
  return createHash('sha256')
    .update('finance-question-talk-reply-v1\0')
    .update(eventIdempotencyKey)
    .update('\0')
    .update(purpose)
    .digest('hex');
}
