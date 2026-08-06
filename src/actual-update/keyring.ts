import { z } from 'zod';

export const ACTUAL_UPDATE_SIGNING_KEYRING_SCHEMA_VERSION =
  'actual-update-signing-keyring.v1' as const;

export const actualUpdateKeyIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/);

const authenticationKeySchema = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, {
    message: 'Actual update authentication keys must contain at least 32 bytes',
  });

const signingKeyringSchema = z
  .strictObject({
    schemaVersion: z.literal(ACTUAL_UPDATE_SIGNING_KEYRING_SCHEMA_VERSION),
    targetReferenceKey: authenticationKeySchema,
    keys: z.record(actualUpdateKeyIdSchema, authenticationKeySchema),
  })
  .superRefine((keyring, context) => {
    const keyCount = Object.keys(keyring.keys).length;
    if (keyCount === 0 || keyCount > 8) {
      context.addIssue({
        code: 'custom',
        message:
          'Actual update keyring must contain between one and eight keys',
        path: ['keys'],
      });
    }
  });

export interface ActualUpdateAuthenticationMaterial {
  readonly signingKeys: Readonly<Record<string, string>>;
  readonly targetReferenceKey: string;
}

/** Parses the shared finance-bot/writer keyring contract. */
export function parseActualUpdateAuthenticationMaterial(
  value: string,
  activeKeyIdInput: string,
): ActualUpdateAuthenticationMaterial {
  const activeKeyId = actualUpdateKeyIdSchema.parse(activeKeyIdInput);
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('Actual update signing keyring is not valid JSON', {
      cause: error,
    });
  }
  const keyring = signingKeyringSchema.parse(untrusted);
  if (!Object.hasOwn(keyring.keys, activeKeyId)) {
    throw new Error(
      'Active Actual update signing key is absent from the retained keyring',
    );
  }
  return {
    signingKeys: Object.fromEntries(Object.entries(keyring.keys)),
    targetReferenceKey: keyring.targetReferenceKey,
  };
}
