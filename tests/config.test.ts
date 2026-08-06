import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

function productionEnvironment(directory: string): NodeJS.ProcessEnv {
  const xaiKeyPath = join(directory, 'xai_api_key');
  const talkSecretPath = join(directory, 'talk_secret');
  const appPasswordPath = join(directory, 'nextcloud_app_password');
  const signingKeyPath = join(directory, 'actual_update_signing_key');
  writeFileSync(xaiKeyPath, 'test-key\n', { mode: 0o600 });
  writeFileSync(talkSecretPath, 'talk-secret\n', { mode: 0o600 });
  writeFileSync(appPasswordPath, 'app-password\n', { mode: 0o600 });
  writeSigningKeyring(signingKeyPath);
  return {
    XAI_API_KEY_FILE: xaiKeyPath,
    INTAKE_MODE: 'production',
    NEXTCLOUD_BASE_URL: 'https://cloud.example.test',
    NEXTCLOUD_SERVICE_USER: 'finance-bot',
    NEXTCLOUD_APP_PASSWORD_FILE: appPasswordPath,
    TALK_BOT_SECRET_FILE: talkSecretPath,
    TALK_BOT_ACTOR_ID: talkBotActorId,
    TALK_ALLOWED_USER_IDS: 'test-user',
    HOUSEHOLD_FINANCE_ROOM_TOKEN: 'room-1',
    ACTUAL_UPDATE_SIGNING_KEY_FILE: signingKeyPath,
  };
}

function loadProductionConfig(environment: NodeJS.ProcessEnv) {
  const config = loadConfig(environment);
  expect(config.intakeMode).toBe('production');
  if (config.intakeMode !== 'production') {
    throw new Error('Expected production configuration');
  }
  return config;
}

const talkBotActorId = `bots/bot-${'d'.repeat(40)}`;

function writeSigningKeyring(
  path: string,
  keyId = 'production-v1',
  key = 's'.repeat(48),
): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 'actual-update-signing-keyring.v1',
      targetReferenceKey: key,
      keys: { [keyId]: key },
    })}\n`,
    { mode: 0o400 },
  );
}

describe('loadConfig', () => {
  it('defaults to the health-only disabled runtime', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      host: '0.0.0.0',
      port: 4380,
      dataDirectory: '/data',
      intakeMode: 'disabled',
    });
  });

  it('does not read an xAI key while production intake is disabled', () => {
    const config = loadConfig({
      XAI_API_KEY_FILE: '/missing/key/is-not-read',
    });

    expect(config.intakeMode).toBe('disabled');
    expect('model' in config).toBe(false);
  });

  it('loads an xAI key for production intake', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));
    const config = loadProductionConfig(productionEnvironment(directory));

    expect(config.model.apiKey).toBe('test-key');
  });

  it('requires the exact bot identity for receipt acknowledgements', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));

    expect(() =>
      loadConfig({
        ...productionEnvironment(directory),
        TALK_BOT_ACTOR_ID: undefined,
      }),
    ).toThrow(/TALK_BOT_ACTOR_ID/);
  });

  it('loads the deployment-selected model and reasoning effort', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));
    const config = loadProductionConfig({
      ...productionEnvironment(directory),
      MODEL_NAME: 'different-model',
      MODEL_REASONING_EFFORT: 'high',
    });

    expect(config.model).toMatchObject({
      name: 'different-model',
      reasoningEffort: 'high',
    });
  });

  it('rejects an unsupported reasoning effort', () => {
    expect(() =>
      loadConfig({
        MODEL_REASONING_EFFORT: 'extreme',
      }),
    ).toThrow();
  });

  it('requires a readable xAI key for production intake', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));

    expect(() =>
      loadConfig({
        ...productionEnvironment(directory),
        XAI_API_KEY_FILE: join(directory, 'missing-xai-key'),
      }),
    ).toThrow();
  });

  it('loads the complete finance runtime in production mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));
    const signingKeyPath = join(directory, 'actual_update_signing_key_v2');
    writeSigningKeyring(signingKeyPath, 'production-v2');
    const config = loadProductionConfig({
      ...productionEnvironment(directory),
      HOUSEHOLD_FINANCE_ROOM_TOKEN: 'production-room',
      CATEGORY_TAXONOMY_PATH: 'Finance/Context/category-taxonomy.json',
      TRANSACTION_CATEGORIZATION_LOOKBACK_DAYS: '30',
      TRANSACTION_CATEGORIZATION_SCAN_INTERVAL_MINUTES: '10',
      TRANSACTION_CATEGORIZATION_MINIMUM_AUTO_APPLY_CONFIDENCE: '0.85',
      ACTUAL_AUTO_APPROVAL_ENABLED: 'true',
      ACTUAL_UPDATE_SIGNING_KEY_FILE: signingKeyPath,
      ACTUAL_UPDATE_SIGNING_KEY_ID: 'production-v2',
    });

    expect(config.questionAnswering).toEqual({
      readerUrl: 'http://actual-reader:4370',
      bankSyncIntervalMs: 4 * 60 * 60 * 1_000,
      timeZone: 'UTC',
    });
    expect(config.contextManagement).toEqual({
      profilePath: 'Finance/Context/household-profile.json',
    });
    expect(config.talk).toMatchObject({
      botActorId: talkBotActorId,
      roomToken: 'production-room',
    });
    expect(config.householdFinanceRoomToken).toBe('production-room');
    expect(config.transactionCategorization).toEqual({
      rollingWindowDays: 30,
      scanIntervalMs: 10 * 60 * 1_000,
      minimumAutoApplyConfidence: 0.85,
    });
    expect(config.actualUpdateIntents).toEqual({
      signingKeys: { 'production-v2': 's'.repeat(48) },
      targetReferenceKey: 's'.repeat(48),
      signingKeyId: 'production-v2',
    });
    expect(config.actualUpdateTalk).toEqual({
      autoApprovalEnabled: true,
    });
  });

  it('fails closed on incomplete production dependencies', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));
    const base = productionEnvironment(directory);

    expect(() =>
      loadConfig({
        ...base,
        TALK_BOT_ACTOR_ID: '',
      }),
    ).toThrow(/TALK_BOT_ACTOR_ID/);
    expect(() =>
      loadConfig({
        ...base,
        TALK_ALLOWED_USER_IDS: '',
      }),
    ).toThrow(/TALK_ALLOWED_USER_IDS/);
    expect(() =>
      loadConfig({
        ...base,
        HOUSEHOLD_FINANCE_ROOM_TOKEN: '',
      }),
    ).toThrow(/HOUSEHOLD_FINANCE_ROOM_TOKEN/);
    expect(() =>
      loadConfig({
        ...base,
        ACTUAL_READER_URL: 'https://actual-reader.example.test',
      }),
    ).toThrow(/credential-free HTTP origin/);
    expect(() =>
      loadConfig({
        ...base,
        HOUSEHOLD_TIME_ZONE: 'not-a-time-zone',
      }),
    ).toThrow(/valid IANA time zone/);
    expect(() =>
      loadConfig({
        ...base,
        ACTUAL_UPDATE_SIGNING_KEY_FILE: join(directory, 'missing-signing-key'),
      }),
    ).toThrow();
  });

  it('keeps auto-approval independent but production-only', () => {
    expect(() =>
      loadConfig({
        ACTUAL_AUTO_APPROVAL_ENABLED: 'true',
      }),
    ).toThrow(/INTAKE_MODE=production/);

    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));
    const config = loadProductionConfig({
      ...productionEnvironment(directory),
      ACTUAL_AUTO_APPROVAL_ENABLED: 'true',
    });

    expect(config.actualUpdateTalk).toEqual({
      autoApprovalEnabled: true,
    });
  });

  it('requires a credential-free HTTPS Nextcloud origin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'household-finance-test-'));
    const baseEnvironment = productionEnvironment(directory);

    for (const invalidUrl of [
      'http://cloud.example.test',
      'https://user:password@cloud.example.test',
      'https://cloud.example.test/unexpected-path',
    ]) {
      expect(() =>
        loadConfig({
          ...baseEnvironment,
          NEXTCLOUD_BASE_URL: invalidUrl,
        }),
      ).toThrow(/credential-free HTTPS origin/);
    }
  });
});
