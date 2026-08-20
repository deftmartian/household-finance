import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { parseActualUpdateAuthenticationMaterial } from './actual-update/keyring.js';

const booleanFromEnvironment = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalTalkBotActorId = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .string()
    .regex(/^bots\/bot-[a-f0-9]{40}$/)
    .optional(),
);

const optionalHouseholdFinanceRoomToken = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).max(500).optional(),
);

const categoryAlias = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const intakeModeFromEnvironment = z
  .enum(['disabled', 'production'])
  .default('disabled');

const environmentSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(4380),
  DATA_DIR: z.string().min(1).default('/data'),
  MODEL_NAME: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
    .default('grok-4.6'),
  MODEL_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('high'),
  XAI_API_KEY_FILE: z.string().min(1).default('/run/secrets/xai_api_key'),
  INTAKE_MODE: intakeModeFromEnvironment,
  NEXTCLOUD_BASE_URL: z.url().optional(),
  NEXTCLOUD_SERVICE_USER: z.string().min(1).optional(),
  NEXTCLOUD_APP_PASSWORD_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/nextcloud_app_password'),
  NEXTCLOUD_ARCHIVE_PATH: z.string().min(1).default('Finance/Receipts'),
  TALK_BOT_SECRET_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/talk_bot_secret'),
  TALK_BOT_ACTOR_ID: optionalTalkBotActorId,
  TALK_ALLOWED_USER_IDS: z.string().optional(),
  ACTUAL_READER_URL: z.url().default('http://actual-reader:4370'),
  ACTUAL_BANK_SYNC_INTERVAL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .default(4),
  HOUSEHOLD_TIME_ZONE: z.string().min(1).max(100).default('UTC'),
  HOUSEHOLD_PROFILE_PATH: z
    .string()
    .min(1)
    .default('Finance/Context/household-profile.json'),
  HOUSEHOLD_FINANCE_ROOM_TOKEN: optionalHouseholdFinanceRoomToken,
  CATEGORY_TAXONOMY_PATH: z
    .string()
    .min(1)
    .default('Finance/Context/category-taxonomy.json'),
  TRANSACTION_CATEGORIZATION_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(90)
    .default(45),
  TRANSACTION_CATEGORIZATION_SCAN_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_440)
    .default(1),
  TRANSACTION_CATEGORIZATION_MINIMUM_AUTO_APPLY_CONFIDENCE: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.8),
  ACTUAL_AUTO_APPROVAL_ENABLED: booleanFromEnvironment,
  ACTUAL_UPDATE_SIGNING_KEY_FILE: z
    .string()
    .min(1)
    .default('/run/secrets/actual_update_signing_key'),
  ACTUAL_UPDATE_SIGNING_KEY_ID: categoryAlias.default('production-v1'),
});

export interface TalkIntakeConfig {
  baseUrl: string;
  secret: string;
  botActorId: string;
  roomToken: string;
  allowedUserIds: readonly string[];
}

export interface NextcloudArchiveConfig {
  baseUrl: string;
  serviceUser: string;
  appPassword: string;
  rootPath: string;
}

interface CommonAppConfig {
  host: string;
  port: number;
  dataDirectory: string;
}

export interface DisabledAppConfig extends CommonAppConfig {
  intakeMode: 'disabled';
}

export interface ProductionAppConfig extends CommonAppConfig {
  intakeMode: 'production';
  model: {
    name: string;
    reasoningEffort: 'low' | 'medium' | 'high';
    apiKey: string;
  };
  questionAnswering: {
    readerUrl: string;
    bankSyncIntervalMs: number;
    timeZone: string;
  };
  contextManagement: {
    profilePath: string;
  };
  householdFinanceRoomToken: string;
  categoryTaxonomyPath: string;
  transactionCategorization: {
    rollingWindowDays: number;
    scanIntervalMs: number;
    minimumAutoApplyConfidence: number;
  };
  actualUpdateIntents: {
    signingKeys: Readonly<Record<string, string>>;
    targetReferenceKey: string;
    signingKeyId: string;
  };
  actualUpdateTalk: {
    autoApprovalEnabled: boolean;
  };
  talk: TalkIntakeConfig;
  archive: NextcloudArchiveConfig;
}

export type AppConfig = DisabledAppConfig | ProductionAppConfig;

function readSecret(path: string): string {
  const value = readFileSync(path, 'utf8').trim();

  if (value.length === 0 || value.includes('\n') || value.includes('\r')) {
    throw new Error(
      `Secret file ${path} must contain exactly one non-empty line`,
    );
  }

  return value;
}

function commaSeparated(value: string | undefined, name: string): string[] {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0 || new Set(items).size !== items.length) {
    throw new Error(`${name} must contain unique comma-separated values`);
  }
  return items;
}

function nextcloudOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'NEXTCLOUD_BASE_URL must be a credential-free HTTPS origin',
    );
  }
  return parsed.origin;
}

function internalHttpOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('ACTUAL_READER_URL must be a credential-free HTTP origin');
  }
  return parsed.origin;
}

function safeRelativeNextcloudJsonPath(value: string, name: string): string {
  if (
    value.startsWith('/') ||
    !value.endsWith('.json') ||
    value
      .split('/')
      .some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment.includes('\0'),
      )
  ) {
    throw new Error(`${name} must be a safe relative Nextcloud JSON path`);
  }
  return value;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const productionEnabled = parsed.INTAKE_MODE === 'production';

  if (parsed.ACTUAL_AUTO_APPROVAL_ENABLED && !productionEnabled) {
    throw new Error(
      'Actual update auto-approval requires INTAKE_MODE=production',
    );
  }

  const common = {
    host: parsed.HOST,
    port: parsed.PORT,
    dataDirectory: parsed.DATA_DIR,
  } as const;

  if (!productionEnabled) {
    return {
      ...common,
      intakeMode: 'disabled',
    };
  }

  if (
    parsed.NEXTCLOUD_BASE_URL === undefined ||
    parsed.NEXTCLOUD_SERVICE_USER === undefined ||
    parsed.TALK_BOT_ACTOR_ID === undefined
  ) {
    throw new Error(
      'Production intake requires NEXTCLOUD_BASE_URL, NEXTCLOUD_SERVICE_USER, and TALK_BOT_ACTOR_ID',
    );
  }
  if (parsed.HOUSEHOLD_FINANCE_ROOM_TOKEN === undefined) {
    throw new Error('Production intake requires HOUSEHOLD_FINANCE_ROOM_TOKEN');
  }

  const allowedUserIds = commaSeparated(
    parsed.TALK_ALLOWED_USER_IDS,
    'TALK_ALLOWED_USER_IDS',
  );

  try {
    new Intl.DateTimeFormat('en-CA', {
      timeZone: parsed.HOUSEHOLD_TIME_ZONE,
    }).format(new Date(0));
  } catch {
    throw new Error('HOUSEHOLD_TIME_ZONE must be a valid IANA time zone');
  }
  safeRelativeNextcloudJsonPath(
    parsed.HOUSEHOLD_PROFILE_PATH,
    'HOUSEHOLD_PROFILE_PATH',
  );
  safeRelativeNextcloudJsonPath(
    parsed.CATEGORY_TAXONOMY_PATH,
    'CATEGORY_TAXONOMY_PATH',
  );
  const readerUrl = internalHttpOrigin(parsed.ACTUAL_READER_URL);
  const actualUpdateAuthentication = parseActualUpdateAuthenticationMaterial(
    readSecret(parsed.ACTUAL_UPDATE_SIGNING_KEY_FILE),
    parsed.ACTUAL_UPDATE_SIGNING_KEY_ID,
  );

  const baseUrl = nextcloudOrigin(parsed.NEXTCLOUD_BASE_URL);

  return {
    ...common,
    intakeMode: 'production',
    model: {
      name: parsed.MODEL_NAME,
      reasoningEffort: parsed.MODEL_REASONING_EFFORT,
      apiKey: readSecret(parsed.XAI_API_KEY_FILE),
    },
    questionAnswering: {
      readerUrl,
      bankSyncIntervalMs:
        parsed.ACTUAL_BANK_SYNC_INTERVAL_HOURS * 60 * 60 * 1_000,
      timeZone: parsed.HOUSEHOLD_TIME_ZONE,
    },
    contextManagement: {
      profilePath: parsed.HOUSEHOLD_PROFILE_PATH,
    },
    householdFinanceRoomToken: parsed.HOUSEHOLD_FINANCE_ROOM_TOKEN,
    categoryTaxonomyPath: parsed.CATEGORY_TAXONOMY_PATH,
    transactionCategorization: {
      rollingWindowDays: parsed.TRANSACTION_CATEGORIZATION_LOOKBACK_DAYS,
      scanIntervalMs:
        parsed.TRANSACTION_CATEGORIZATION_SCAN_INTERVAL_MINUTES * 60 * 1_000,
      minimumAutoApplyConfidence:
        parsed.TRANSACTION_CATEGORIZATION_MINIMUM_AUTO_APPLY_CONFIDENCE,
    },
    actualUpdateIntents: {
      signingKeys: actualUpdateAuthentication.signingKeys,
      targetReferenceKey: actualUpdateAuthentication.targetReferenceKey,
      signingKeyId: parsed.ACTUAL_UPDATE_SIGNING_KEY_ID,
    },
    actualUpdateTalk: {
      autoApprovalEnabled: parsed.ACTUAL_AUTO_APPROVAL_ENABLED,
    },
    talk: {
      baseUrl,
      secret: readSecret(parsed.TALK_BOT_SECRET_FILE),
      botActorId: parsed.TALK_BOT_ACTOR_ID,
      roomToken: parsed.HOUSEHOLD_FINANCE_ROOM_TOKEN,
      allowedUserIds,
    },
    archive: {
      baseUrl,
      serviceUser: parsed.NEXTCLOUD_SERVICE_USER,
      appPassword: readSecret(parsed.NEXTCLOUD_APP_PASSWORD_FILE),
      rootPath: parsed.NEXTCLOUD_ARCHIVE_PATH,
    },
  };
}
