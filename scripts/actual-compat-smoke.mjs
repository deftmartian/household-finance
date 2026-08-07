import assert from 'node:assert/strict';
import process from 'node:process';

import * as api from '@actual-app/api';

const serverURL = process.env.ACTUAL_SMOKE_SERVER_URL;
const password = process.env.ACTUAL_SMOKE_PASSWORD;
const dataRoot = process.env.ACTUAL_SMOKE_DATA_ROOT;
assert.ok(
  serverURL && password && dataRoot,
  'Actual smoke environment is incomplete',
);

const budgetName = 'Household Finance CI compatibility smoke';
const date = '2026-01-15';
let serverVersion;

await api.init({
  dataDir: `${dataRoot}/client-a`,
  serverURL,
  password,
  verbose: false,
});
try {
  const versionResult = await api.getServerVersion();
  assert.ok(
    !('error' in versionResult),
    'Actual server version must be available',
  );
  serverVersion = versionResult.version;

  await api.runImport(budgetName, async () => {
    const accountId = await api.createAccount({
      name: 'Synthetic checking',
      offbudget: false,
    });
    await api.addTransactions(accountId, [
      {
        date,
        amount: -1234,
        payee_name: 'Synthetic store',
        imported_id: 'actual-compat-smoke-transaction',
        notes: 'before compatibility write',
        cleared: true,
      },
    ]);
  });
  await api.sync();
  const budget = (await api.getBudgets()).find(
    (candidate) => candidate.name === budgetName,
  );
  assert.ok(budget?.groupId, 'created budget must have a remote sync id');

  await api.shutdown();
  const client = await api.init({
    dataDir: `${dataRoot}/client-b`,
    serverURL,
    password,
    verbose: false,
  });
  await api.downloadBudget(budget.groupId);
  await api.sync();

  const [account] = await api.getAccounts();
  assert.ok(account, 'downloaded budget must contain the synthetic account');
  const [transaction] = await api.getTransactions(account.id, date, date);
  assert.ok(
    transaction,
    'downloaded budget must contain the synthetic transaction',
  );

  const result = await client.send('transactions-batch-update', {
    added: [],
    updated: [{ id: transaction.id, notes: 'after compatibility write' }],
    deleted: [],
    learnCategories: false,
    runTransfers: false,
  });
  assert.ok(result && typeof result === 'object');
  assert.deepEqual(result.errors, []);
  await api.sync();

  const [updated] = await api.getTransactions(account.id, date, date);
  assert.equal(updated?.notes, 'after compatibility write');
  process.stdout.write(
    `${JSON.stringify({ serverVersion, status: 'compatible' })}\n`,
  );
} finally {
  await api.shutdown();
}
