import type { Store } from './store.js';
export function metrics(
  store: Store,
  ready: boolean,
  build: { revision: string; model: string; effort: string },
): string {
  const lines: string[] = [];
  const metric = (
    name: string,
    value: number,
    labels: Record<string, string> = {},
  ) => {
    const suffix = Object.keys(labels).length
      ? '{' +
        Object.entries(labels)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(',') +
        '}'
      : '';
    lines.push(
      `household_finance_${name}${suffix} ${Number.isFinite(value) ? value : 0}`,
    );
  };
  metric('ready', ready ? 1 : 0);
  metric('build_info', 1, {
    revision: build.revision,
    model: build.model,
    reasoning_effort: build.effort,
  });
  for (const state of ['ready', 'running', 'done', 'attention']) {
    const row = store.db
      .prepare('SELECT count(*) AS n FROM jobs WHERE state=?')
      .get(state) as { n: number };
    metric('jobs', row.n, { state });
  }
  const row = (sql: string) =>
    store.db.prepare(sql).get() as { n: number | null };
  metric(
    'oldest_runnable_timestamp_seconds',
    (row("SELECT min(due) AS n FROM jobs WHERE state IN ('ready','running')")
      .n ?? 0) / 1000,
  );
  metric(
    'reply_attention',
    row(
      'SELECT count(*) AS n FROM replies WHERE delivered IS NULL AND attempts>=8',
    ).n ?? 0,
  );
  metric(
    'operation_attention',
    row("SELECT count(*) AS n FROM operations WHERE state='attention'").n ?? 0,
  );
  metric(
    'model_calls_total',
    row('SELECT count(*) AS n FROM model_calls').n ?? 0,
  );
  metric(
    'model_cost_usd_total',
    (row('SELECT sum(actual) AS n FROM model_calls').n ?? 0) / 1e10,
  );
  for (const reason of ['privacy', 'model', 'transport', 'other'])
    metric(
      'failures_total',
      Number(store.getMeta('metric-failure:' + reason) ?? 0),
      { reason },
    );
  return lines.join('\n') + '\n';
}
