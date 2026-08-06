import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  actualUpdateKeyIdSchema,
  parseActualUpdateAuthenticationMaterial,
} from './actual-update/keyring.js';
import {
  parseActualProductionContract,
  type ActualProductionContract,
} from './integrations/actual/index.js';

const environmentSchema = z.object({
  NODE_ENV: z.literal('production'),
  DATA_DIR: z.string().min(1).default('/data'),
  ACTUAL_WRITER_STATE_DIR: z.string().min(1).default('/writer-data'),
  ACTUAL_SERVER_URL: z.url().default('http://actual-server:5006'),
  ACTUAL_SERVER_PASSWORD_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/actual_server_password'),
  ACTUAL_PRODUCTION_CONTRACT_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/actual_production_contract'),
  ACTUAL_UPDATE_SIGNING_KEY_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/actual_update_signing_key'),
  ACTUAL_UPDATE_SIGNING_KEY_ID:
    actualUpdateKeyIdSchema.default('production-v1'),
  ACTUAL_WRITER_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(250)
    .max(60_000)
    .default(1_000),
  ACTUAL_WRITER_OPERATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(120_000)
    .default(120_000),
});

export interface ActualWriterConfig {
  databasePath: string;
  actualApiDataDirectory: string;
  serverUrl: string;
  serverPassword: string;
  productionContract: ActualProductionContract;
  updateSigningKeys: Readonly<Record<string, string>>;
  updateTargetReferenceKey: string;
  updateSigningKeyId: string;
  pollIntervalMs: number;
  operationTimeoutMs: number;
}

function absoluteFile(value: string, field: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function readOneLineSecret(pathInput: string, field: string): string {
  const path = absoluteFile(pathInput, field);
  const raw = readFileSync(path, 'utf8');
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new Error('Actual writer secret must contain one non-empty line');
  }
  return value;
}

function absoluteDirectory(value: string, field: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return resolve(value);
}

function pathsOverlap(left: string, right: string): boolean {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return (
    fromLeft === '' ||
    (!fromLeft.startsWith('..') && !isAbsolute(fromLeft)) ||
    (!fromRight.startsWith('..') && !isAbsolute(fromRight))
  );
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
    throw new Error(
      'ACTUAL_SERVER_URL must be the internal http://actual-server:5006 origin',
    );
  }
  return parsed.origin;
}

export function loadActualWriterConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ActualWriterConfig {
  const parsed = environmentSchema.parse(environment);
  const dataDirectory = absoluteDirectory(parsed.DATA_DIR, 'DATA_DIR');
  const writerStateDirectory = absoluteDirectory(
    parsed.ACTUAL_WRITER_STATE_DIR,
    'ACTUAL_WRITER_STATE_DIR',
  );
  if (pathsOverlap(dataDirectory, writerStateDirectory)) {
    throw new Error('Actual writer data directories must not overlap');
  }

  const untrustedContract = JSON.parse(
    readFileSync(
      absoluteFile(
        parsed.ACTUAL_PRODUCTION_CONTRACT_FILE,
        'ACTUAL_PRODUCTION_CONTRACT_FILE',
      ),
      'utf8',
    ),
  ) as unknown;
  const productionContract = parseActualProductionContract(untrustedContract);
  const updateSigningMaterial = parseActualUpdateAuthenticationMaterial(
    readOneLineSecret(
      parsed.ACTUAL_UPDATE_SIGNING_KEY_FILE,
      'ACTUAL_UPDATE_SIGNING_KEY_FILE',
    ),
    parsed.ACTUAL_UPDATE_SIGNING_KEY_ID,
  );

  return {
    databasePath: join(dataDirectory, 'attachment-shadow.sqlite'),
    actualApiDataDirectory: join(writerStateDirectory, 'actual-api'),
    serverUrl: internalActualOrigin(parsed.ACTUAL_SERVER_URL),
    serverPassword: readOneLineSecret(
      parsed.ACTUAL_SERVER_PASSWORD_FILE,
      'ACTUAL_SERVER_PASSWORD_FILE',
    ),
    productionContract,
    updateSigningKeys: updateSigningMaterial.signingKeys,
    updateTargetReferenceKey: updateSigningMaterial.targetReferenceKey,
    updateSigningKeyId: parsed.ACTUAL_UPDATE_SIGNING_KEY_ID,
    pollIntervalMs: parsed.ACTUAL_WRITER_POLL_INTERVAL_MS,
    operationTimeoutMs: parsed.ACTUAL_WRITER_OPERATION_TIMEOUT_MS,
  };
}
