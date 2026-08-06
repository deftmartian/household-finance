import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

import {
  parseActualReadContract,
  type ActualReadContract,
} from './read-contract.js';

const environmentSchema = z.object({
  NODE_ENV: z.literal('production'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4_370),
  DATA_DIR: z.string().min(1).default('/reader-data'),
  ACTUAL_SERVER_URL: z.url().default('http://actual-server:5006'),
  ACTUAL_SERVER_PASSWORD_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/actual_server_password'),
  ACTUAL_READ_CONTRACT_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/actual_read_contract'),
  ACTUAL_READER_OPERATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(600_000)
    .default(120_000),
});

export interface ActualReaderServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDirectory: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly readContract: ActualReadContract;
  readonly operationTimeoutMs: number;
}

function absolutePath(value: string): string {
  if (!isAbsolute(value))
    throw new Error('Actual reader path must be absolute');
  return resolve(value);
}
function oneLineSecret(path: string): string {
  const value = readFileSync(absolutePath(path), 'utf8').trim();
  if (value.length === 0 || value.includes('\n') || value.includes('\r')) {
    throw new Error('Actual reader secret must contain one non-empty line');
  }
  return value;
}
function internalActualOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== 'actual-server' ||
    parsed.port !== '5006' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('Actual reader server URL must be the internal origin');
  }
  return parsed.origin;
}
function safeHost(value: string): string {
  if (
    value !== value.trim() ||
    value.length > 253 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        (codePoint <= 0x20 || character === '/' || character === '\\')
      );
    })
  ) {
    throw new Error('Actual reader host is invalid');
  }
  return value;
}

export function loadActualReaderServiceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ActualReaderServiceConfig {
  const parsed = environmentSchema.parse(environment);
  const contract = parseActualReadContract(
    JSON.parse(
      readFileSync(absolutePath(parsed.ACTUAL_READ_CONTRACT_FILE), 'utf8'),
    ) as unknown,
  );
  return {
    host: safeHost(parsed.HOST),
    port: parsed.PORT,
    dataDirectory: absolutePath(parsed.DATA_DIR),
    serverUrl: internalActualOrigin(parsed.ACTUAL_SERVER_URL),
    serverPassword: oneLineSecret(parsed.ACTUAL_SERVER_PASSWORD_FILE),
    readContract: contract,
    operationTimeoutMs: parsed.ACTUAL_READER_OPERATION_TIMEOUT_MS,
  };
}
