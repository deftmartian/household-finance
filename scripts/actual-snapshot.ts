import * as api from '@actual-app/api';
import { snapshotSchema } from './conversion.js';
import type { Snapshot } from './conversion.js';
export async function snapshot(sync = true): Promise<Snapshot> {
  if (sync) await api.sync();
  const accounts = await api.getAccounts(),
    transactions = [];
  for (const a of accounts)
    transactions.push(
      ...(await api.getTransactions(a.id, '1900-01-01', '2100-01-01')),
    );
  const { data: notes } = (await api.aqlQuery(
    api.q('notes').select(['id', 'note']),
  )) as { data: unknown[] };
  const categories = [
    ...new Map(
      [
        ...(await api.getCategories()),
        ...(await api.getCategories({ hidden: true })),
      ].map((c) => [c.id, c]),
    ).values(),
  ];
  return snapshotSchema.parse({
    version: 1,
    at: new Date().toISOString(),
    accounts,
    transactions,
    notes,
    categories,
    rules: await api.getRules(),
    schedules: await api.getSchedules(),
  });
}
export function quietSdk(): void {
  console.log =
    console.warn =
    console.error =
    console.info =
    console.debug =
      () => {};
}
