/* global process, console */
// Offline cutover/rehearsal tool. Run inside the old reader with its existing
// credentials. Outputs only aggregate counts; private artifacts stay mode 0600.
import * as api from '@actual-app/api';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
const out = process.env.HF_EXPORT_DIR ?? '/tmp/hf-replacement-preservation';
mkdirSync(out, { recursive: true, mode: 0o700 });
const contract = JSON.parse(
  readFileSync(
    process.env.ACTUAL_READ_CONTRACT_FILE ??
      '/run/secrets/actual_read_contract',
    'utf8',
  ),
);
const password = readFileSync(
  process.env.ACTUAL_SERVER_PASSWORD_FILE ??
    '/run/secrets/actual_server_password',
  'utf8',
).trim();
const print = console.log;
console.log =
  console.warn =
  console.error =
  console.info =
  console.debug =
    () => {};
try {
  await api.init({
    dataDir: mkdtempSync('/tmp/hf-preservation-cache-'),
    serverURL: process.env.ACTUAL_SERVER_URL ?? 'http://actual-server:5006',
    password,
  });
  await api.downloadBudget(contract.budget.syncId);
  await api.sync();
  const accounts = await api.getAccounts(),
    transactions = [];
  for (const a of accounts)
    transactions.push(
      ...(await api.getTransactions(a.id, '1900-01-01', '2100-01-01')),
    );
  const { data: notes } = await api.aqlQuery(
    api.q('notes').select(['id', 'note']),
  );
  const categories = [
    ...new Map(
      [
        ...(await api.getCategories()),
        ...(await api.getCategories({ hidden: true })),
      ].map((c) => [c.id, c]),
    ).values(),
  ];
  const snapshot = {
    version: 1,
    at: new Date().toISOString(),
    accounts,
    transactions,
    notes,
    categories,
    rules: await api.getRules(),
    schedules: await api.getSchedules(),
    readContract: contract,
  };
  const body = JSON.stringify(snapshot);
  writeFileSync(out + '/snapshot.json', body, { mode: 0o600 });
  const archive = await api.exportBudget();
  writeFileSync(out + '/actual.zip', archive, { mode: 0o600 });
  const summary = {
    accounts: accounts.length,
    transactions: transactions.length,
    receiptNotes: notes.filter((n) =>
      n.id.startsWith('household-finance:receipt:'),
    ).length,
    linkedTransactions: transactions.filter((t) =>
      t.notes?.includes('[[household-finance:receipt-link:'),
    ).length,
    categories: categories.length,
    rules: snapshot.rules.length,
    schedules: snapshot.schedules.length,
    snapshotSha256: createHash('sha256').update(body).digest('hex'),
    exportSha256: createHash('sha256').update(archive).digest('hex'),
  };
  writeFileSync(out + '/summary.json', JSON.stringify(summary), {
    mode: 0o600,
  });
  print(JSON.stringify(summary));
} finally {
  await api.shutdown();
}
