import { describe, expect, it, vi } from 'vitest';

import type {
  XaiStructuredRequest,
  XaiStructuredRun,
} from '../../src/model/xai-structured-client.js';
import { costcoItemLookupTool } from '../../src/questions/costco-item-lookup-tool.js';

function run(value: unknown): XaiStructuredRun {
  return {
    value,
    metadata: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      preflightAttempts: 1,
      requestAttempts: 1,
      durationMs: 10,
      zeroDataRetention: true,
      usage: { costInUsdTicks: 1 },
    },
  };
}

describe('Costco item lookup tool', () => {
  it('sends only the bounded receipt label in a ZDR structured web-search request', async () => {
    const clientRun = vi.fn(
      async (
        request: XaiStructuredRequest,
        signal?: AbortSignal,
      ): Promise<XaiStructuredRun> => {
        void request;
        void signal;
        return run({
          status: 'resolved',
          matchedItemNumber: '253230',
          productName: 'Kirkland Signature parchment paper',
          evidence: 'Costco Canada item 253230 is parchment paper.',
        });
      },
    );
    const tool = costcoItemLookupTool({ client: { run: clientRun } });
    const signal = new AbortController().signal;

    await expect(
      tool.execute(
        { itemNumber: '253230', rawDescription: 'KS PARCH PAPER' },
        signal,
      ),
    ).resolves.toEqual({
      status: 'resolved',
      itemNumber: '253230',
      productName: 'Kirkland Signature parchment paper',
      evidence: 'exact_item_number',
    });

    expect(tool.name).toBe('lookup_costco_item');
    expect(clientRun).toHaveBeenCalledTimes(1);
    const [request, forwardedSignal] = clientRun.mock.calls[0]!;
    expect(request).toMatchObject({
      schemaName: 'costco_item_lookup_v1',
      maxOutputTokens: 512,
      payload: {
        itemNumber: '253230',
        rawDescription: 'KS PARCH PAPER',
      },
      webSearch: { maxTurns: 2, maxToolCalls: 4 },
    });
    expect(Object.keys(request.payload as object)).toEqual([
      'itemNumber',
      'rawDescription',
    ]);
    expect(request.systemPrompt).not.toMatch(/household context|ledger data/iu);
    expect(forwardedSignal).toBe(signal);
  });

  it.each([
    {
      status: 'resolved',
      matchedItemNumber: '253231',
      productName: 'A different product',
      evidence: 'Costco item 253231 is a different product.',
    },
    {
      status: 'resolved',
      matchedItemNumber: '253230',
      productName: 'Parchment paper',
      evidence: 'This result does not repeat the printed code.',
    },
    {
      status: 'resolved',
      matchedItemNumber: '253230',
      productName: 'Parchment paper',
      evidence: 'The result contains larger item number 12532309 only.',
    },
    {
      status: 'unresolved',
      matchedItemNumber: null,
      productName: null,
      evidence: null,
    },
  ])('does not resolve without exact-code evidence', async (modelValue) => {
    const clientRun = vi.fn(async () => run(modelValue));
    const tool = costcoItemLookupTool({ client: { run: clientRun } });

    await expect(
      tool.execute({ itemNumber: '253230', rawDescription: 'KS PARCH PAPER' }),
    ).resolves.toEqual({
      status: 'unresolved',
      itemNumber: '253230',
      reason: 'no_exact_item_number_evidence',
    });
  });

  it.each([
    null,
    {},
    { itemNumber: '253230' },
    { itemNumber: '25-3230', rawDescription: 'KS PARCH PAPER' },
    { itemNumber: '1234', rawDescription: 'KS PARCH PAPER' },
    { itemNumber: '253230', rawDescription: ' KS PARCH PAPER' },
    {
      itemNumber: '253230',
      rawDescription: 'KS PARCH PAPER',
      householdContext: 'private',
    },
  ])('rejects invalid or excess arguments without searching', async (input) => {
    const clientRun = vi.fn();
    const tool = costcoItemLookupTool({ client: { run: clientRun } });

    await expect(tool.execute(input)).resolves.toEqual({
      status: 'error',
      error: 'invalid_arguments',
    });
    expect(clientRun).not.toHaveBeenCalled();
  });

  it('allows at most four lookup calls per tool instance', async () => {
    const clientRun = vi.fn(async () =>
      run({
        status: 'unresolved',
        matchedItemNumber: null,
        productName: null,
        evidence: null,
      }),
    );
    const tool = costcoItemLookupTool({ client: { run: clientRun } });
    const input = { itemNumber: '253230', rawDescription: 'KS PARCH PAPER' };

    for (let index = 0; index < 4; index += 1) {
      await expect(tool.execute(input)).resolves.toMatchObject({
        status: 'unresolved',
      });
    }
    await expect(tool.execute(input)).resolves.toEqual({
      status: 'error',
      error: 'lookup_limit_reached',
    });
    expect(clientRun).toHaveBeenCalledTimes(4);
  });

  it('returns a safe error when the ZDR client rejects the lookup', async () => {
    const clientRun = vi.fn(async () => {
      throw new Error('private provider detail');
    });
    const tool = costcoItemLookupTool({ client: { run: clientRun } });

    await expect(
      tool.execute({ itemNumber: '253230', rawDescription: 'KS PARCH PAPER' }),
    ).resolves.toEqual({ status: 'error', error: 'lookup_failed' });
  });
});
