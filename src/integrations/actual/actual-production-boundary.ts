import { isAbsolute } from 'node:path';

import { ensurePrivateActualApiDataDirectory } from './actual-api-data-directory.js';
import { collapseActualBudgetRepresentations } from './actual-budget-representations.js';
import {
  parseActualProductionContract,
  type ActualProductionCategoryIdentity,
  type ActualProductionContract,
  type ActualProductionNamedIdentity,
} from './production-contract.js';

export interface ActualProductionApiInitConfig {
  readonly dataDir: string;
  readonly serverURL: string;
  readonly password: string;
  readonly verbose?: boolean;
}

export interface ActualProductionApiBudget {
  readonly id?: string;
  readonly cloudFileId?: string;
  readonly groupId?: string;
  readonly name: string;
  readonly state?: unknown;
}

export interface ActualProductionApiAccount {
  readonly id: string;
  readonly name: string;
  readonly offbudget?: boolean;
  readonly closed?: boolean;
}

export interface ActualProductionApiCategory {
  readonly id: string;
  readonly name: string;
  readonly group_id: string;
  readonly is_income?: boolean;
  readonly hidden?: boolean;
}

export interface ActualProductionApiPayee {
  readonly id: string;
  readonly name: string;
  readonly transfer_acct?: string | null;
}

/**
 * The exact read surface needed to establish the production write boundary.
 * Transaction mutation is intentionally absent.
 */
export interface ActualProductionApi {
  init(config: ActualProductionApiInitConfig): Promise<unknown>;
  shutdown(): Promise<void>;
  downloadBudget(syncId: string): Promise<void>;
  getBudgets(): Promise<readonly ActualProductionApiBudget[]>;
  getAccounts(): Promise<readonly ActualProductionApiAccount[]>;
  getCategories(): Promise<readonly unknown[]>;
  getPayees(): Promise<readonly ActualProductionApiPayee[]>;
  sync(): Promise<void>;
}

export interface ActualProductionBoundaryConfig {
  readonly dataDir: string;
  readonly serverURL: string;
  readonly serverPassword: string;
  readonly productionContract: ActualProductionContract;
}

interface NormalizedProductionBoundaryConfig {
  readonly dataDir: string;
  readonly serverURL: string;
  readonly serverPassword: string;
  readonly productionContract: ActualProductionContract;
  readonly expectedAccountsById: ReadonlyMap<
    string,
    ActualProductionNamedIdentity
  >;
  readonly expectedCategoriesById: ReadonlyMap<
    string,
    ActualProductionCategoryIdentity
  >;
}

type LifecycleState =
  'new' | 'initializing' | 'ready' | 'shutting-down' | 'closed' | 'failed';

export class ActualProductionBoundaryConfigurationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ActualProductionBoundaryConfigurationError';
    this.field = field;
  }
}

export class ActualProductionBoundaryLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualProductionBoundaryLifecycleError';
  }
}

function configText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new ActualProductionBoundaryConfigurationError(
      field,
      `${field} must be non-empty and cannot have surrounding whitespace`,
    );
  }
  return value;
}

function secret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActualProductionBoundaryConfigurationError(
      'serverPassword',
      'serverPassword must not be empty',
    );
  }
  return value;
}

function serverOrigin(value: unknown): string {
  const text = configText(value, 'serverURL');
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ActualProductionBoundaryConfigurationError(
      'serverURL',
      'serverURL must be a valid URL',
    );
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new ActualProductionBoundaryConfigurationError(
      'serverURL',
      'serverURL must be an HTTP(S) origin without credentials, path, query, or fragment',
    );
  }
  return text.replace(/\/+$/, '');
}

function normalizeConfig(
  config: ActualProductionBoundaryConfig,
): NormalizedProductionBoundaryConfig {
  const dataDir = configText(config.dataDir, 'dataDir');
  if (!isAbsolute(dataDir)) {
    throw new ActualProductionBoundaryConfigurationError(
      'dataDir',
      'dataDir must be an absolute path',
    );
  }

  let productionContract: ActualProductionContract;
  try {
    productionContract = parseActualProductionContract(
      config.productionContract,
    );
  } catch {
    throw new ActualProductionBoundaryConfigurationError(
      'productionContract',
      'productionContract is invalid or its fingerprint does not match',
    );
  }

  return {
    dataDir,
    serverURL: serverOrigin(config.serverURL),
    serverPassword: secret(config.serverPassword),
    productionContract,
    expectedAccountsById: new Map(
      Object.values(productionContract.accounts).map((identity) => [
        identity.id,
        identity,
      ]),
    ),
    expectedCategoriesById: new Map(
      Object.values(productionContract.categories).map((identity) => [
        identity.id,
        identity,
      ]),
    ),
  };
}

function categoryCandidate(
  value: unknown,
): ActualProductionApiCategory | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('name' in value) ||
    !('group_id' in value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.group_id !== 'string'
  ) {
    return undefined;
  }
  return value as ActualProductionApiCategory;
}

/**
 * Initializes one Actual API instance and proves that its live identities still
 * match the signed production contract before any writer is constructed.
 */
export class ActualProductionBoundary {
  readonly #config: NormalizedProductionBoundaryConfig;
  readonly #api: ActualProductionApi;
  #state: LifecycleState = 'new';
  #operationTail: Promise<void> = Promise.resolve();
  #apiActive = false;
  #initializedValue: unknown;

  constructor(
    config: ActualProductionBoundaryConfig,
    api: ActualProductionApi,
  ) {
    this.#config = normalizeConfig(config);
    this.#api = api;
  }

  get lifecycleState(): LifecycleState {
    return this.#state;
  }

  initialize(): Promise<unknown> {
    return this.#runExclusive(async () => {
      if (this.#state === 'ready') {
        return this.#initializedValue;
      }
      if (this.#state !== 'new') {
        throw new ActualProductionBoundaryLifecycleError(
          `Cannot initialize Actual production boundary from ${this.#state} state`,
        );
      }

      this.#state = 'initializing';
      let initializationAttempted = false;
      try {
        await ensurePrivateActualApiDataDirectory(this.#config.dataDir);
        initializationAttempted = true;
        this.#initializedValue = await this.#api.init({
          dataDir: this.#config.dataDir,
          serverURL: this.#config.serverURL,
          password: this.#config.serverPassword,
          verbose: false,
        });
        this.#apiActive = true;
        await this.#api.downloadBudget(
          this.#config.productionContract.budget.syncId,
        );
        await this.#api.sync();
        await this.#validateLiveContract();
        this.#state = 'ready';
        return this.#initializedValue;
      } catch (error) {
        this.#state = 'failed';
        if (initializationAttempted) {
          try {
            await this.#api.shutdown();
          } catch {
            // The initialization failure is the actionable error.
          }
        }
        this.#apiActive = false;
        throw error;
      }
    });
  }

  shutdown(): Promise<void> {
    return this.#runExclusive(async () => {
      if (this.#state === 'closed') {
        return;
      }
      if (this.#state === 'new') {
        this.#state = 'closed';
        return;
      }
      if (this.#state !== 'ready' && this.#state !== 'failed') {
        throw new ActualProductionBoundaryLifecycleError(
          `Cannot shut down Actual production boundary from ${this.#state} state`,
        );
      }

      this.#state = 'shutting-down';
      try {
        if (this.#apiActive) {
          await this.#api.shutdown();
        }
      } finally {
        this.#apiActive = false;
        this.#state = 'closed';
      }
    });
  }

  async #validateLiveContract(): Promise<void> {
    const contract = this.#config.productionContract;
    const budgets = await this.#api.getBudgets();
    const matchingBudgets = (() => {
      try {
        return collapseActualBudgetRepresentations(
          budgets.map((candidate) => {
            const source =
              candidate.state === undefined
                ? 'local'
                : candidate.state === 'remote'
                  ? 'remote'
                  : (() => {
                      throw new Error('Unexpected Actual budget state');
                    })();
            return {
              source,
              id: candidate.id,
              cloudFileId: candidate.cloudFileId,
              groupId: candidate.groupId,
              name: candidate.name,
            };
          }),
        ).filter((candidate) => candidate.groupId === contract.budget.syncId);
      } catch {
        throw new ActualProductionBoundaryConfigurationError(
          'productionContract.budget',
          'Actual budget representations could not be reconciled safely',
        );
      }
    })();
    if (
      matchingBudgets.length !== 1 ||
      matchingBudgets[0]?.name !== contract.budget.name ||
      !matchingBudgets[0].localRepresentationPresent ||
      !matchingBudgets[0].remoteRepresentationPresent
    ) {
      throw new ActualProductionBoundaryConfigurationError(
        'productionContract.budget',
        'Downloaded Actual budget does not exactly match the production contract',
      );
    }

    const accounts = await this.#api.getAccounts();
    for (const [id, expected] of this.#config.expectedAccountsById) {
      const matches = accounts.filter((candidate) => candidate.id === id);
      const account = matches[0];
      if (
        matches.length !== 1 ||
        account?.name !== expected.name ||
        account.closed !== false ||
        account.offbudget !== false
      ) {
        throw new ActualProductionBoundaryConfigurationError(
          'productionContract.accounts',
          'Actual account does not exactly match the production contract',
        );
      }
    }

    const categories = (await this.#api.getCategories())
      .map(categoryCandidate)
      .filter((candidate) => candidate !== undefined);
    for (const [id, expected] of this.#config.expectedCategoriesById) {
      const matches = categories.filter((candidate) => candidate.id === id);
      const category = matches[0];
      if (
        matches.length !== 1 ||
        category?.name !== expected.name ||
        category.is_income !== (expected.kind === 'income') ||
        category.hidden !== false
      ) {
        throw new ActualProductionBoundaryConfigurationError(
          'productionContract.categories',
          'Actual category does not exactly match the production contract',
        );
      }
    }

    const payees = await this.#api.getPayees();
    const expectedSentinel = contract.sentinelPayee;
    const matchingIds = payees.filter(
      (candidate) => candidate.id === expectedSentinel.id,
    );
    const matchingNames = payees.filter(
      (candidate) => candidate.name === expectedSentinel.name,
    );
    if (
      matchingIds.length !== 1 ||
      matchingIds[0]?.name !== expectedSentinel.name ||
      matchingNames.length !== 1 ||
      matchingNames[0]?.id !== expectedSentinel.id
    ) {
      throw new ActualProductionBoundaryConfigurationError(
        'productionContract.sentinelPayee',
        'Actual sentinel does not exactly match the production contract',
      );
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
