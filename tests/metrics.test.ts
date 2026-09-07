import { expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { metrics } from '../src/metrics.js';
import { Fault } from '../src/domain.js';
it('exports only aggregate metrics with durable bounded failure labels', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue('private-id', 'question', {
      message: 'private household text',
    });
    store.fail(store.next()!, new Fault('model-zdr-required'));
    const text = metrics(store, true, {
      revision: 'test',
      model: 'grok-4.6',
      effort: 'low',
    });
    expect(text).toContain(
      'household_finance_failures_total{reason="privacy"} 1',
    );
    expect(text).toContain('household_finance_jobs{state="attention"} 1');
    expect(text).not.toContain('private');
  } finally {
    store.close();
  }
});
