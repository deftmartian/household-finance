import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
  ACTUAL_PRODUCTION_SCOPE,
  ActualApiDataDirectoryError,
  ActualProductionBoundary,
  ActualProductionBoundaryConfigurationError,
  ActualProductionBoundaryLifecycleError,
  actualProductionContractFingerprint,
  actualProductionSentinelPayeeName,
} from '../../../src/integrations/actual/index.js';
import type {
  ActualProductionApi,
  ActualProductionApiAccount,
  ActualProductionApiBudget,
  ActualProductionApiInitConfig,
  ActualProductionApiPayee,
  ActualProductionContract,
} from '../../../src/integrations/actual/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const contractIdentity = {
  schemaVersion: ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
  scope: ACTUAL_PRODUCTION_SCOPE,
  nonce: '2'.repeat(64),
  budget: {
    syncId: 'production-budget-sync-id',
    name: 'Synthetic Household Budget',
  },
  accounts: {
    daily: { id: 'actual-daily-account', name: 'Daily Account' },
    visa: { id: 'actual-visa-account', name: 'Household Visa' },
  },
  categories: {
    groceries: {
      id: 'actual-groceries',
      name: 'Groceries',
      kind: 'expense',
    },
    dining: {
      id: 'actual-dining',
      name: 'Dining',
      kind: 'expense',
    },
    cashback: {
      id: 'actual-cashback',
      name: 'Cashback',
      kind: 'income',
    },
  },
  expectedCurrency: 'CAD',
  maximumReceiptAmountMinorUnits: 100_000,
  receiptDateWindow: { pastDays: 90, futureDays: 7 },
} as const;

const contractFingerprint =
  actualProductionContractFingerprint(contractIdentity);
const productionContract: ActualProductionContract = {
  ...contractIdentity,
  fingerprint: contractFingerprint,
  sentinelPayee: {
    id: 'production-sentinel-payee',
    name: actualProductionSentinelPayeeName(contractFingerprint),
  },
};

class FakeActualProductionApi implements ActualProductionApi {
  readonly initializedValue = {
    send: async () => ({ errors: [] }),
  };
  readonly initCalls: ActualProductionApiInitConfig[] = [];
  readonly downloadCalls: string[] = [];
  budgets: ActualProductionApiBudget[] = [
    {
      id: 'local-budget-id',
      cloudFileId: 'cloud-budget-id',
      groupId: contractIdentity.budget.syncId,
      name: contractIdentity.budget.name,
    },
    {
      cloudFileId: 'cloud-budget-id',
      groupId: contractIdentity.budget.syncId,
      name: contractIdentity.budget.name,
      state: 'remote',
    },
  ];
  accounts: ActualProductionApiAccount[] = Object.values(
    contractIdentity.accounts,
  ).map((account) => ({
    ...account,
    offbudget: false,
    closed: false,
  }));
  categories: unknown[] = [
    {
      id: contractIdentity.categories.groceries.id,
      name: contractIdentity.categories.groceries.name,
      group_id: 'expense-group-id',
      is_income: false,
      hidden: false,
    },
    {
      id: contractIdentity.categories.dining.id,
      name: contractIdentity.categories.dining.name,
      group_id: 'expense-group-id',
      is_income: false,
      hidden: false,
    },
    {
      id: contractIdentity.categories.cashback.id,
      name: contractIdentity.categories.cashback.name,
      group_id: 'income-group-id',
      is_income: true,
      hidden: false,
    },
  ];
  payees: ActualProductionApiPayee[] = [productionContract.sentinelPayee];
  shutdownCount = 0;
  syncCount = 0;
  initFailure: Error | undefined;

  async init(config: ActualProductionApiInitConfig): Promise<unknown> {
    this.initCalls.push(structuredClone(config));
    if (this.initFailure !== undefined) {
      throw this.initFailure;
    }
    return this.initializedValue;
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
  }

  async downloadBudget(syncId: string): Promise<void> {
    this.downloadCalls.push(syncId);
  }

  async getBudgets(): Promise<readonly ActualProductionApiBudget[]> {
    return structuredClone(this.budgets);
  }

  async getAccounts(): Promise<readonly ActualProductionApiAccount[]> {
    return structuredClone(this.accounts);
  }

  async getCategories(): Promise<readonly unknown[]> {
    return structuredClone(this.categories);
  }

  async getPayees(): Promise<readonly ActualProductionApiPayee[]> {
    return structuredClone(this.payees);
  }

  async sync(): Promise<void> {
    this.syncCount += 1;
  }
}

function createBoundary(
  api: FakeActualProductionApi,
  dataDir = join(
    temporaryDirectory('actual-production-boundary-'),
    'actual-api',
  ),
): ActualProductionBoundary {
  return new ActualProductionBoundary(
    {
      dataDir,
      serverURL: 'http://actual.test/',
      serverPassword: 'synthetic-server-password',
      productionContract,
    },
    api,
  );
}

describe('Actual production boundary', () => {
  it('exposes only lifecycle operations', () => {
    expect(
      Object.getOwnPropertyNames(ActualProductionBoundary.prototype).sort(),
    ).toEqual(['constructor', 'initialize', 'lifecycleState', 'shutdown']);
  });

  it('initializes and validates the production contract once', async () => {
    const api = new FakeActualProductionApi();
    const dataDir = join(
      temporaryDirectory('actual-production-boundary-'),
      'absent-actual-api',
    );
    const boundary = createBoundary(api, dataDir);

    expect(existsSync(dataDir)).toBe(false);
    await expect(boundary.initialize()).resolves.toBe(api.initializedValue);
    await expect(boundary.initialize()).resolves.toBe(api.initializedValue);

    expect(boundary.lifecycleState).toBe('ready');
    expect(api.initCalls).toEqual([
      {
        dataDir,
        serverURL: 'http://actual.test',
        password: 'synthetic-server-password',
        verbose: false,
      },
    ]);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(api.downloadCalls).toEqual([contractIdentity.budget.syncId]);
    expect(api.syncCount).toBe(1);

    await boundary.shutdown();
    await boundary.shutdown();
    expect(boundary.lifecycleState).toBe('closed');
    expect(api.shutdownCount).toBe(1);
    await expect(boundary.initialize()).rejects.toBeInstanceOf(
      ActualProductionBoundaryLifecycleError,
    );
  });

  it.each([
    {
      label: 'budget',
      alter: (api: FakeActualProductionApi) => {
        api.budgets = api.budgets.map((budget) => ({
          ...budget,
          name: 'Changed household budget',
        }));
      },
    },
    {
      label: 'account',
      alter: (api: FakeActualProductionApi) => {
        api.accounts[0] = { ...api.accounts[0]!, name: 'Changed account' };
      },
    },
    {
      label: 'category',
      alter: (api: FakeActualProductionApi) => {
        api.categories[0] = {
          ...(api.categories[0] as object),
          name: 'Changed category',
        };
      },
    },
    {
      label: 'sentinel',
      alter: (api: FakeActualProductionApi) => {
        api.payees[0] = { ...api.payees[0]!, name: 'Changed sentinel' };
      },
    },
  ])('fails closed when the production $label drifts', async ({ alter }) => {
    const api = new FakeActualProductionApi();
    alter(api);
    const boundary = createBoundary(api);

    await expect(boundary.initialize()).rejects.toBeInstanceOf(
      ActualProductionBoundaryConfigurationError,
    );
    expect(boundary.lifecycleState).toBe('failed');
    expect(api.shutdownCount).toBe(1);
  });

  it('uses the remote-authoritative budget name', async () => {
    const api = new FakeActualProductionApi();
    api.budgets[0] = {
      ...api.budgets[0]!,
      name: 'Stale local budget name',
    };
    const boundary = createBoundary(api);

    await boundary.initialize();
    expect(boundary.lifecycleState).toBe('ready');
    await boundary.shutdown();
  });

  it.each([
    {
      label: 'missing local representation',
      alter: (api: FakeActualProductionApi) => {
        api.budgets = api.budgets.filter((budget) => budget.state === 'remote');
      },
    },
    {
      label: 'missing remote representation',
      alter: (api: FakeActualProductionApi) => {
        api.budgets = api.budgets.filter(
          (budget) => budget.state === undefined,
        );
      },
    },
    {
      label: 'conflicting remote identity',
      alter: (api: FakeActualProductionApi) => {
        api.budgets[1] = {
          ...api.budgets[1]!,
          groupId: 'conflicting-sync-id',
        };
      },
    },
    {
      label: 'unexpected representation state',
      alter: (api: FakeActualProductionApi) => {
        api.budgets[0] = { ...api.budgets[0]!, state: 'unexpected' };
      },
    },
  ])('rejects a $label', async ({ alter }) => {
    const api = new FakeActualProductionApi();
    alter(api);
    const boundary = createBoundary(api);

    await expect(boundary.initialize()).rejects.toMatchObject({
      name: 'ActualProductionBoundaryConfigurationError',
      field: 'productionContract.budget',
    });
    expect(api.shutdownCount).toBe(1);
  });

  it('does not accept an Actual category-group row as a category', async () => {
    const api = new FakeActualProductionApi();
    api.categories[0] = {
      id: contractIdentity.categories.groceries.id,
      name: contractIdentity.categories.groceries.name,
      is_income: false,
      hidden: false,
    };
    const boundary = createBoundary(api);

    await expect(boundary.initialize()).rejects.toMatchObject({
      field: 'productionContract.categories',
    });
  });

  it('rejects an invalid contract and unsafe configuration before API init', () => {
    const api = new FakeActualProductionApi();
    const invalidContract = {
      ...productionContract,
      accounts: {
        ...productionContract.accounts,
        daily: {
          ...productionContract.accounts.daily!,
          name: 'Changed after fingerprinting',
        },
      },
    };

    expect(
      () =>
        new ActualProductionBoundary(
          {
            dataDir: '/tmp/actual-production-boundary',
            serverURL: 'http://actual.test',
            serverPassword: 'synthetic',
            productionContract: invalidContract,
          },
          api,
        ),
    ).toThrow(ActualProductionBoundaryConfigurationError);
    expect(
      () =>
        new ActualProductionBoundary(
          {
            dataDir: 'relative/data',
            serverURL: 'http://actual.test/path',
            serverPassword: 'synthetic',
            productionContract,
          },
          api,
        ),
    ).toThrow(ActualProductionBoundaryConfigurationError);
    expect(api.initCalls).toHaveLength(0);
  });

  it('rejects insecure or symlinked API data directories before API init', async () => {
    const parent = temporaryDirectory('actual-production-boundary-');
    const permissiveDirectory = join(parent, 'permissive');
    mkdirSync(permissiveDirectory, { mode: 0o700 });
    chmodSync(permissiveDirectory, 0o755);
    const permissiveApi = new FakeActualProductionApi();

    await expect(
      createBoundary(permissiveApi, permissiveDirectory).initialize(),
    ).rejects.toBeInstanceOf(ActualApiDataDirectoryError);
    expect(permissiveApi.initCalls).toHaveLength(0);

    const targetDirectory = join(parent, 'target');
    const symlinkDirectory = join(parent, 'symlink');
    mkdirSync(targetDirectory, { mode: 0o700 });
    symlinkSync(targetDirectory, symlinkDirectory);
    const symlinkApi = new FakeActualProductionApi();

    await expect(
      createBoundary(symlinkApi, symlinkDirectory).initialize(),
    ).rejects.toBeInstanceOf(ActualApiDataDirectoryError);
    expect(symlinkApi.initCalls).toHaveLength(0);
  });

  it('shuts the API down after an initialization attempt fails', async () => {
    const api = new FakeActualProductionApi();
    api.initFailure = new Error('synthetic initialization failure');
    const boundary = createBoundary(api);

    await expect(boundary.initialize()).rejects.toThrow(
      'synthetic initialization failure',
    );
    expect(boundary.lifecycleState).toBe('failed');
    expect(api.shutdownCount).toBe(1);
    await boundary.shutdown();
    expect(api.shutdownCount).toBe(1);
  });
});
