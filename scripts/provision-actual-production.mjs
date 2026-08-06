import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import process from 'node:process';

import * as api from '@actual-app/api';

import { ensureCategories } from './actual-category-provisioning.mjs';
import { permitsProductionContractRotation } from './actual-production-contract-rotation.mjs';

const aliasPattern = /^[a-z][a-z0-9-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
let productionContracts;

class ProvisioningStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisioningStoppedError';
  }
}

function required(name) {
  const value = process.env[name];
  if (
    value === undefined ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new ProvisioningStoppedError(`${name} must be one trimmed line`);
  }
  return value;
}

function absolutePath(name) {
  const value = required(name);
  if (!isAbsolute(value)) {
    throw new ProvisioningStoppedError(`${name} must be an absolute path`);
  }
  return value;
}

function exactOne(values, predicate, label) {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    throw new ProvisioningStoppedError(
      `${label} must resolve to exactly one live Actual identity`,
    );
  }
  return matches[0];
}

function parseJsonFile(path, label) {
  return readFile(path, 'utf8').then((text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new ProvisioningStoppedError(`${label} is not valid JSON`);
    }
  });
}

function validateAccountPlan(value, expectedBudgetName) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schemaVersion !== 'household-finance-account-plan.v1' ||
    value.budgetName !== expectedBudgetName ||
    !Array.isArray(value.accounts) ||
    value.accounts.length === 0 ||
    value.accounts.length > 50
  ) {
    throw new ProvisioningStoppedError('Actual account plan is invalid');
  }
  const aliases = new Set();
  const names = new Set();
  for (const account of value.accounts) {
    if (
      account === null ||
      typeof account !== 'object' ||
      typeof account.alias !== 'string' ||
      !aliasPattern.test(account.alias) ||
      typeof account.name !== 'string' ||
      account.name.length === 0 ||
      account.name !== account.name.trim() ||
      ![
        'spending',
        'credit-card',
        'cashback-staging',
        'savings',
        'debt',
        'other',
      ].includes(account.role) ||
      typeof account.onBudget !== 'boolean' ||
      typeof account.bankSyncEnabled !== 'boolean' ||
      typeof account.readEnabled !== 'boolean' ||
      typeof account.writerEnabled !== 'boolean' ||
      (account.lastFour !== undefined &&
        (typeof account.lastFour !== 'string' ||
          !/^\d{4}$/.test(account.lastFour))) ||
      aliases.has(account.alias) ||
      names.has(account.name.toLocaleLowerCase('en-CA')) ||
      (account.writerEnabled && (!account.readEnabled || !account.onBudget))
    ) {
      throw new ProvisioningStoppedError(
        'Actual account plan contains an invalid or duplicate entry',
      );
    }
    aliases.add(account.alias);
    names.add(account.name.toLocaleLowerCase('en-CA'));
  }
  if (
    !value.accounts.some(
      (account) => account.readEnabled && account.bankSyncEnabled,
    ) ||
    !value.accounts.some((account) => account.writerEnabled)
  ) {
    throw new ProvisioningStoppedError(
      'Actual account plan has no sync/read or write boundary',
    );
  }
  return value;
}

function validateCategoryPlan(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.schemaVersion !== 'household-finance-category-plan.v1' ||
    value.currency !== 'CAD' ||
    typeof value.expenseGroupName !== 'string' ||
    typeof value.incomeGroupName !== 'string' ||
    value.expenseGroupName.length === 0 ||
    value.incomeGroupName.length === 0 ||
    value.expenseGroupName !== value.expenseGroupName.trim() ||
    value.incomeGroupName !== value.incomeGroupName.trim() ||
    value.expenseGroupName.toLocaleLowerCase('en-CA') ===
      value.incomeGroupName.toLocaleLowerCase('en-CA') ||
    !Array.isArray(value.categories) ||
    value.categories.length === 0 ||
    value.categories.length > 200
  ) {
    throw new ProvisioningStoppedError('Actual category plan is invalid');
  }
  const aliases = new Set();
  const names = new Set();
  for (const category of value.categories) {
    if (
      category === null ||
      typeof category !== 'object' ||
      typeof category.alias !== 'string' ||
      !aliasPattern.test(category.alias) ||
      typeof category.name !== 'string' ||
      category.name.length === 0 ||
      category.name !== category.name.trim() ||
      typeof category.description !== 'string' ||
      category.description.length === 0 ||
      category.description.length > 500 ||
      !['expense', 'income', 'savings', 'debt'].includes(category.kind) ||
      typeof category.modelSelectable !== 'boolean' ||
      typeof category.writerEnabled !== 'boolean' ||
      aliases.has(category.alias) ||
      names.has(category.name.toLocaleLowerCase('en-CA')) ||
      (category.writerEnabled && !['expense', 'income'].includes(category.kind))
    ) {
      throw new ProvisioningStoppedError(
        'Actual category plan contains an invalid or duplicate entry',
      );
    }
    aliases.add(category.alias);
    names.add(category.name.toLocaleLowerCase('en-CA'));
  }
  return value;
}

async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function recoverProvisioningIdentity(markerPath, existingContractPath) {
  let existing;
  try {
    existing = await parseJsonFile(existingContractPath, 'production contract');
  } catch (error) {
    if (!(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      throw error;
    }
  }
  if (existing !== undefined) {
    try {
      const existingContract =
        productionContracts.parseActualProductionContract(existing);
      return { nonce: existingContract.nonce, existingContract };
    } catch {
      throw new ProvisioningStoppedError(
        'Existing production contract is invalid',
      );
    }
  }
  try {
    const marker = await parseJsonFile(markerPath, 'provisioning marker');
    if (
      marker?.schemaVersion !==
        'household-finance-production-provisioning.v1' ||
      typeof marker.nonce !== 'string' ||
      !hashPattern.test(marker.nonce)
    ) {
      throw new ProvisioningStoppedError(
        'Production provisioning marker is invalid',
      );
    }
    return { nonce: marker.nonce, existingContract: undefined };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      const nonce = randomBytes(32).toString('hex');
      await writeAtomicJson(markerPath, {
        schemaVersion: 'household-finance-production-provisioning.v1',
        nonce,
      });
      return { nonce, existingContract: undefined };
    }
    throw error;
  }
}

function namedBudgetSyncId(budgets, budgetName) {
  const syncIds = new Set(
    budgets
      .filter((budget) => budget.name === budgetName)
      .map((budget) => budget.groupId)
      .filter((value) => typeof value === 'string' && value.length > 0),
  );
  if (syncIds.size !== 1) {
    throw new ProvisioningStoppedError(
      'Budget name does not resolve to exactly one server sync identity',
    );
  }
  return [...syncIds][0];
}

const mode = process.env.ACTUAL_PROVISION_MODE ?? 'inspect';
if (!['inspect', 'apply'].includes(mode)) {
  throw new ProvisioningStoppedError(
    'ACTUAL_PROVISION_MODE must be inspect or apply',
  );
}
const apply = mode === 'apply';
if (apply && process.env.ACTUAL_APPLY_PROVISIONING !== 'true') {
  throw new ProvisioningStoppedError(
    'Set ACTUAL_APPLY_PROVISIONING=true for category and sentinel creation',
  );
}

const serverURL = required('ACTUAL_SERVER_URL');
const passwordFile = absolutePath('ACTUAL_SERVER_PASSWORD_FILE');
const dataDir = required('ACTUAL_API_DATA_DIR');
if (!isAbsolute(dataDir)) {
  throw new ProvisioningStoppedError(
    'ACTUAL_API_DATA_DIR must be an absolute path',
  );
}
const budgetName = process.env.ACTUAL_BUDGET_NAME ?? 'My Finances';
const password = (await readFile(passwordFile, 'utf8')).trim();
if (password.length === 0 || password.includes('\n')) {
  throw new ProvisioningStoppedError(
    'Actual server password file is malformed',
  );
}

await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
let initialized = false;
try {
  await api.init({ dataDir, serverURL, password, verbose: false });
  initialized = true;
  const syncId = namedBudgetSyncId(await api.getBudgets(), budgetName);
  await api.downloadBudget(syncId);
  await api.sync();

  if (!apply) {
    const accounts = (await api.getAccounts())
      .map((account) => ({
        name: account.name,
        onBudget: account.offbudget === false,
        closed: account.closed === true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const categories = (await api.getCategories())
      .filter((category) => typeof category.group_id === 'string')
      .map((category) => ({
        name: category.name,
        kind: category.is_income === true ? 'income' : 'expense',
        hidden: category.hidden === true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    process.stdout.write(
      `${JSON.stringify({ budgetName, accounts, categories }, null, 2)}\n`,
    );
  } else {
    productionContracts =
      await import('../dist/integrations/actual/production-contract.js');
    const readContracts = await import('../dist/actual-read/read-contract.js');
    const { categoryTaxonomySchema } =
      await import('../dist/categorization/taxonomy.js');
    const accountPlan = validateAccountPlan(
      await parseJsonFile(
        absolutePath('ACTUAL_ACCOUNT_PLAN_FILE'),
        'Actual account plan',
      ),
      budgetName,
    );
    const categoryPlan = validateCategoryPlan(
      await parseJsonFile(
        absolutePath('ACTUAL_CATEGORY_PLAN_FILE'),
        'Actual category plan',
      ),
    );
    const productionPath = absolutePath(
      'ACTUAL_PRODUCTION_CONTRACT_OUTPUT_PATH',
    );
    const readPath = absolutePath('ACTUAL_READ_CONTRACT_OUTPUT_PATH');
    const taxonomyPath = absolutePath('ACTUAL_CATEGORY_TAXONOMY_OUTPUT_PATH');
    const markerPath = `${productionPath}.provisioning-recovery`;
    const { nonce, existingContract } = await recoverProvisioningIdentity(
      markerPath,
      productionPath,
    );

    const actualAccounts = await api.getAccounts();
    const accounts = {};
    for (const planned of accountPlan.accounts) {
      const account = exactOne(
        actualAccounts,
        (candidate) =>
          candidate.name === planned.name &&
          candidate.closed === false &&
          candidate.offbudget === !planned.onBudget,
        `account ${planned.name}`,
      );
      accounts[planned.alias] = {
        id: account.id,
        name: account.name,
        role: planned.role,
        onBudget: planned.onBudget,
        bankSyncEnabled: planned.bankSyncEnabled,
        readEnabled: planned.readEnabled,
        writerEnabled: planned.writerEnabled,
        ...(planned.lastFour === undefined
          ? {}
          : { lastFour: planned.lastFour }),
      };
    }
    const categories = await ensureCategories(api, categoryPlan, true);
    const writerAccounts = Object.fromEntries(
      Object.entries(accounts)
        .filter(([, account]) => account.writerEnabled)
        .map(([alias, account]) => [
          alias,
          { id: account.id, name: account.name },
        ]),
    );
    const writerCategories = Object.fromEntries(
      Object.entries(categories)
        .filter(([, category]) => category.writerEnabled)
        .map(([alias, category]) => [
          alias,
          {
            id: category.id,
            name: category.name,
            kind: category.kind,
          },
        ]),
    );
    const productionIdentity = {
      schemaVersion:
        productionContracts.ACTUAL_PRODUCTION_CONTRACT_SCHEMA_VERSION,
      scope: productionContracts.ACTUAL_PRODUCTION_SCOPE,
      nonce,
      budget: { syncId, name: budgetName },
      accounts: writerAccounts,
      categories: writerCategories,
      expectedCurrency: 'CAD',
      maximumReceiptAmountMinorUnits: 1_000_000,
      receiptDateWindow: { pastDays: 120, futureDays: 7 },
    };
    const productionFingerprint =
      productionContracts.actualProductionContractFingerprint(
        productionIdentity,
      );
    const sentinelName = productionContracts.actualProductionSentinelPayeeName(
      productionFingerprint,
    );
    let livePayees = await api.getPayees();
    const productionSentinels = livePayees.filter((payee) =>
      payee.name.startsWith(
        productionContracts.ACTUAL_PRODUCTION_SENTINEL_PREFIX,
      ),
    );
    const foreignSentinels = productionSentinels.filter(
      (payee) => payee.name !== sentinelName,
    );
    const rotationAllowed = permitsProductionContractRotation({
      explicitlyAllowed:
        process.env.ACTUAL_ALLOW_PRODUCTION_CONTRACT_ROTATION === 'true',
      existingContract,
      nonce,
      budget: productionIdentity.budget,
      liveProductionSentinels: productionSentinels,
    });
    if (foreignSentinels.length > 0 && !rotationAllowed) {
      throw new ProvisioningStoppedError(
        'A different production sentinel already exists; stop for review',
      );
    }
    let sentinels = livePayees.filter((payee) => payee.name === sentinelName);
    if (sentinels.length === 0) {
      await api.createPayee({ name: sentinelName, transfer_acct: null });
      await api.sync();
      livePayees = await api.getPayees();
      sentinels = livePayees.filter((payee) => payee.name === sentinelName);
    }
    const sentinel = exactOne(sentinels, () => true, 'production sentinel');
    const productionContract =
      productionContracts.parseActualProductionContract({
        ...productionIdentity,
        fingerprint: productionFingerprint,
        sentinelPayee: { id: sentinel.id, name: sentinel.name },
      });
    const productionSentinelCount = livePayees.filter((payee) =>
      payee.name.startsWith(
        productionContracts.ACTUAL_PRODUCTION_SENTINEL_PREFIX,
      ),
    ).length;

    const readIdentity = {
      schemaVersion: readContracts.ACTUAL_READ_CONTRACT_SCHEMA_VERSION,
      scope: readContracts.ACTUAL_READ_CONTRACT_SCOPE,
      nonce,
      budget: { syncId, name: budgetName },
      accounts: Object.fromEntries(
        Object.entries(accounts)
          .filter(([, account]) => account.readEnabled)
          .map(([alias, account]) => [
            alias,
            {
              id: account.id,
              name: account.name,
              role: account.role,
              onBudget: account.onBudget,
              bankSyncEnabled: account.bankSyncEnabled,
              ...(account.lastFour === undefined
                ? {}
                : { lastFour: account.lastFour }),
            },
          ]),
      ),
      categories: Object.fromEntries(
        Object.entries(categories).map(([alias, category]) => [
          alias,
          { name: category.name },
        ]),
      ),
      expectedCurrency: 'CAD',
      maximumAggregateRangeDays: 366,
      maximumExplanationRangeDays: 366,
      maximumExplanationRows: 20,
      maximumObservationRangeDays: 90,
      maximumObservationRows: 500,
      freshnessMaximumAgeSeconds: 21_600,
      expectedBankDelayHours: 24,
      bankSyncMinimumIntervalSeconds: 300,
    };
    const readContract = readContracts.parseActualReadContract({
      ...readIdentity,
      fingerprint: readContracts.actualReadContractFingerprint(readIdentity),
    });
    const taxonomy = categoryTaxonomySchema.parse({
      schemaVersion: 'household-category-taxonomy.v1',
      currency: 'CAD',
      categories: categoryPlan.categories.map(
        ({ alias, name, description, kind, modelSelectable }) => ({
          alias,
          name,
          description,
          kind,
          modelSelectable,
        }),
      ),
    });
    await writeAtomicJson(productionPath, productionContract);
    await writeAtomicJson(readPath, readContract);
    await writeAtomicJson(taxonomyPath, taxonomy);
    await unlink(markerPath).catch(() => undefined);
    process.stdout.write(
      `${JSON.stringify({
        status: 'provisioned',
        writerAccountCount: Object.keys(writerAccounts).length,
        readAccountCount: Object.keys(readContract.accounts).length,
        writerCategoryCount: Object.keys(writerCategories).length,
        taxonomyCategoryCount: taxonomy.categories.length,
        productionSentinelCount,
      })}\n`,
    );
  }
} finally {
  if (initialized) {
    await api.shutdown().catch(() => undefined);
  }
}
