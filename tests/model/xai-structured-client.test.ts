import { describe, expect, it, vi } from 'vitest';

import { XaiStructuredClient } from '../../src/model/xai-structured-client.js';
import type { XaiStructuredClientError } from '../../src/model/xai-structured-client.js';

function response(value: unknown, zdr = true, model = 'grok-4.6'): Response {
  const body = JSON.stringify({
    status: 'completed',
    model,
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(value) }],
      },
    ],
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
      cost_in_usd_ticks: 10,
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      ...(zdr ? { 'x-zero-data-retention': 'true' } : {}),
    },
  });
}

function agentResponse(output: readonly unknown[], zdr = true): Response {
  const body = JSON.stringify({
    status: 'completed',
    model: 'grok-4.6',
    output,
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      cost_in_usd_ticks: 20,
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      ...(zdr ? { 'x-zero-data-retention': 'true' } : {}),
    },
  });
}

function responseWhoseBodyErrors(): Response {
  let emitted = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(new TextEncoder().encode('{"status":'));
          return;
        }
        controller.error(new Error('private response body failure'));
      },
    }),
    {
      status: 200,
      headers: { 'x-zero-data-retention': 'true' },
    },
  );
}

function responseWithEarlyEof(): Response {
  const body = '{"status":';
  return new Response(body, {
    status: 200,
    headers: {
      'content-length': String(Buffer.byteLength(body) + 10),
      'x-zero-data-retention': 'true',
    },
  });
}

describe('XaiStructuredClient', () => {
  it('exposes a content-free ZDR preflight for other private media clients', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ acknowledged: true }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(client.assertZeroDataRetention()).resolves.toBeUndefined();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const options = fetchImplementation.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(options.body))).toMatchObject({
      store: false,
      text: {
        format: {
          name: 'zdr_preflight_v1',
        },
      },
    });
    expect(String(options.body)).not.toContain('household');
  });

  it('uses the model selected when the client is constructed', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ acknowledged: true }, true, 'grok-next'),
      )
      .mockResolvedValueOnce(response({ kind: 'ok' }, true, 'grok-next'));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      model: 'grok-next',
      fetchImplementation,
    });

    const run = await client.run({
      schemaName: 'test_schema_v1',
      schema: { type: 'object' },
      systemPrompt: 'Return the strict test value.',
      payload: {},
    });

    expect(run.metadata).toMatchObject({
      requestedModel: 'grok-next',
      resolvedModel: 'grok-next',
    });
    for (const call of fetchImplementation.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toMatchObject({
        model: 'grok-next',
      });
    }
  });

  it('uses store=false and requires ZDR on both calls', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(response({ kind: 'ok' }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
      now: () => 100,
    });

    const run = await client.run({
      schemaName: 'test_schema_v1',
      schema: {
        type: 'object',
        properties: { kind: { const: 'ok' } },
        required: ['kind'],
        additionalProperties: false,
      },
      systemPrompt: 'Return the strict test value.',
      payload: { untrusted: 'value' },
    });

    expect(run.value).toEqual({ kind: 'ok' });
    expect(run.metadata.zeroDataRetention).toBe(true);
    expect(run.metadata.usage.costInUsdTicks).toBe(20);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    for (const call of fetchImplementation.mock.calls) {
      const options = call[1] as RequestInit;
      expect(JSON.parse(String(options.body))).toMatchObject({ store: false });
    }
  });

  it('offers bounded provider-side web search to a structured request', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(
        agentResponse([
          {
            id: 'search-1',
            type: 'web_search_call',
            status: 'completed',
          },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ category: 'groceries' }),
              },
            ],
          },
        ]),
      );
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      client.run({
        schemaName: 'receipt_category_v1',
        schema: { type: 'object' },
        systemPrompt: 'Resolve the printed product code, then categorize it.',
        payload: { description: '253230 DRUMSTK' },
        webSearch: { maxTurns: 3, maxToolCalls: 24 },
      }),
    ).resolves.toMatchObject({ value: { category: 'groceries' } });

    const request = JSON.parse(
      String(fetchImplementation.mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      max_turns: 3,
      max_tool_calls: 24,
    });
  });

  it('retries a successful response whose body stream fails', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(responseWhoseBodyErrors())
      .mockResolvedValueOnce(response({ kind: 'ok' }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      sleepImplementation: async () => undefined,
    });

    const run = await client.run({
      schemaName: 'test_schema_v1',
      schema: { type: 'object' },
      systemPrompt: 'Return the strict test value.',
      payload: {},
    });

    expect(run.value).toEqual({ kind: 'ok' });
    expect(run.metadata).toMatchObject({
      preflightAttempts: 1,
      requestAttempts: 2,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('retries a successful response that ends before Content-Length', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(responseWithEarlyEof())
      .mockResolvedValueOnce(response({ kind: 'ok' }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      sleepImplementation: async () => undefined,
    });

    const run = await client.run({
      schemaName: 'test_schema_v1',
      schema: { type: 'object' },
      systemPrompt: 'Return the strict test value.',
      payload: {},
    });

    expect(run.value).toEqual({ kind: 'ok' });
    expect(run.metadata.requestAttempts).toBe(2);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the provider omits the ZDR attestation', async () => {
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ acknowledged: true }, false)),
    });
    await expect(
      client.run({
        schemaName: 'test_schema_v1',
        schema: { type: 'object' },
        systemPrompt: 'Return the strict test value.',
        payload: {},
      }),
    ).rejects.toMatchObject({
      code: 'zdr-required',
      phase: 'preflight',
    } satisfies Partial<XaiStructuredClientError>);
  });

  it('runs a client-side ZDR tool loop and returns a strict final value', async () => {
    const reasoning = {
      id: 'reasoning-1',
      type: 'reasoning',
      status: 'completed',
      encrypted_content: 'opaque-encrypted-state',
      summary: [],
    };
    const functionCall = {
      id: 'function-1',
      type: 'function_call',
      status: 'completed',
      call_id: 'call-1',
      name: 'read_balance',
      arguments: JSON.stringify({ account: 'Daily Spending' }),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(agentResponse([reasoning, functionCall]))
      .mockResolvedValueOnce(
        agentResponse([
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ reply: 'You have $100.00 available.' }),
              },
            ],
          },
        ]),
      );
    const execute = vi.fn(async () => ({
      availableMinorUnits: { minorUnits: 10_000, displayCad: '$100.00' },
    }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      reasoningEffort: 'high',
      fetchImplementation,
      now: () => 100,
    });

    const run = await client.runAgent({
      schemaName: 'finance_agent_reply_v1',
      schema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false,
      },
      systemPrompt: 'Use the finance tools and return a helpful answer.',
      payload: { question: 'How much is available?' },
      tools: [
        {
          name: 'read_balance',
          description: 'Read one household account balance.',
          parameters: {
            type: 'object',
            properties: { account: { type: 'string' } },
            required: ['account'],
            additionalProperties: false,
          },
          execute,
        },
      ],
      maxTurns: 4,
      requireInitialToolCall: true,
    });

    expect(run.value).toEqual({ reply: 'You have $100.00 available.' });
    expect(run.metadata).toMatchObject({
      turns: 2,
      toolCalls: ['read_balance'],
      requestAttempts: 2,
      zeroDataRetention: true,
    });
    expect(run.metadata.usage.costInUsdTicks).toBe(50);
    expect(execute).toHaveBeenCalledWith(
      { account: 'Daily Spending' },
      undefined,
    );
    const continuation = JSON.parse(
      String(fetchImplementation.mock.calls[2]?.[1]?.body),
    ) as {
      input: unknown[];
      include: string[];
      store: boolean;
      previous_response_id?: string;
    };
    expect(continuation.store).toBe(false);
    expect(continuation.previous_response_id).toBeUndefined();
    expect(continuation.include).toEqual(['reasoning.encrypted_content']);
    const initial = JSON.parse(
      String(fetchImplementation.mock.calls[1]?.[1]?.body),
    ) as { reasoning: { effort: string }; tool_choice: string };
    expect(initial.reasoning.effort).toBe('high');
    expect(initial.tool_choice).toBe('required');
    expect(continuation).toMatchObject({ tool_choice: 'auto' });
    expect(continuation.input).toEqual(
      expect.arrayContaining([
        reasoning,
        functionCall,
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: JSON.stringify({
            availableMinorUnits: {
              minorUnits: 10_000,
              displayCad: '$100.00',
            },
          }),
        },
      ]),
    );
  });

  it('sends prior dialogue as native roles and keeps the current turn last', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(
        agentResponse([
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'The SimpleFIN charge is a subscription.',
              },
            ],
          },
        ]),
      );
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      client.runAgent({
        schemaName: 'unused_plain_text_schema_v1',
        schema: {},
        systemPrompt: 'Follow the household conversation naturally.',
        payload: {
          currentMember: { displayName: 'Alex' },
          currentDate: '2026-07-29',
        },
        conversationMessages: [
          {
            role: 'user',
            content: 'Alex: What was this purchase?',
          },
          {
            role: 'assistant',
            content: 'It appears as Link.com in the bank feed.',
          },
        ],
        currentUserMessage: 'Alex: It was actually SimpleFIN.',
        tools: [
          {
            name: 'read_actual',
            description: 'Read current ledger facts.',
            parameters: { type: 'object' },
            execute: async () => ({ status: 'unused' }),
          },
        ],
        finalResponseFormat: 'text',
      }),
    ).resolves.toMatchObject({
      value: 'The SimpleFIN charge is a subscription.',
    });

    const request = JSON.parse(
      String(fetchImplementation.mock.calls[1]?.[1]?.body),
    ) as { input: unknown[] };
    expect(request.input).toEqual([
      {
        role: 'system',
        content: 'Follow the household conversation naturally.',
      },
      {
        role: 'user',
        content:
          'Household context for this turn (reference data, not a request or write authorization):\n' +
          JSON.stringify({
            currentMember: { displayName: 'Alex' },
            currentDate: '2026-07-29',
          }),
      },
      {
        role: 'user',
        content: 'Alex: What was this purchase?',
      },
      {
        role: 'assistant',
        content: 'It appears as Link.com in the bank feed.',
      },
      {
        role: 'user',
        content: 'Alex: It was actually SimpleFIN.',
      },
    ]);
  });

  it('forces one exact initial tool and accepts a bounded plain-text final answer', async () => {
    const functionCall = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'read_balance',
      arguments: JSON.stringify({ account: 'Daily Spending' }),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(
        agentResponse([
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'I’ll check the current balance.',
              },
            ],
          },
          functionCall,
        ]),
      )
      .mockResolvedValueOnce(
        agentResponse([
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'You have $100.00 available.',
              },
            ],
          },
        ]),
      );
    const readBalance = vi.fn(async () => ({
      availableMinorUnits: 10_000,
    }));
    const categorize = vi.fn(async () => ({ status: 'queued' }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    const run = await client.runAgent({
      schemaName: 'unused_plain_text_schema_v1',
      schema: { type: 'object' },
      systemPrompt: 'Read first, then answer naturally.',
      payload: { question: 'How much is available?' },
      tools: [
        {
          name: 'read_balance',
          description: 'Read one household account balance.',
          parameters: {
            type: 'object',
            properties: { account: { type: 'string' } },
            required: ['account'],
            additionalProperties: false,
          },
          execute: readBalance,
        },
        {
          name: 'categorize_transaction',
          description: 'Categorize one transaction.',
          parameters: {
            type: 'object',
            properties: { category: { type: 'string' } },
            required: ['category'],
            additionalProperties: false,
          },
          execute: categorize,
        },
      ],
      maxTurns: 2,
      initialToolName: 'read_balance',
      finalResponseFormat: 'text',
      maxFinalResponseCharacters: 100,
    });

    expect(run.value).toBe('You have $100.00 available.');
    expect(run.metadata).toMatchObject({
      turns: 2,
      toolCalls: ['read_balance'],
      zeroDataRetention: true,
    });
    expect(readBalance).toHaveBeenCalledWith(
      { account: 'Daily Spending' },
      undefined,
    );
    expect(categorize).not.toHaveBeenCalled();
    const initial = JSON.parse(
      String(fetchImplementation.mock.calls[1]?.[1]?.body),
    ) as {
      text: { format: { type: string } };
      tool_choice: unknown;
    };
    expect(initial.tool_choice).toEqual({
      type: 'function',
      name: 'read_balance',
    });
    expect(initial.text.format).toEqual({ type: 'text' });
    const finalRequest = JSON.parse(
      String(fetchImplementation.mock.calls[2]?.[1]?.body),
    ) as { text: { format: { type: string } }; tool_choice: string };
    expect(finalRequest.tool_choice).toBe('none');
    expect(finalRequest.text.format).toEqual({ type: 'text' });
  });

  it('rejects an exact initial tool name that is not supplied', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      client.runAgent({
        schemaName: 'finance_agent_reply_v1',
        schema: { type: 'object' },
        systemPrompt: 'Use the supplied finance tool.',
        payload: {},
        tools: [
          {
            name: 'read_balance',
            description: 'Read one household account balance.',
            parameters: { type: 'object' },
            execute: async () => ({}),
          },
        ],
        initialToolName: 'missing_tool',
      }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
      phase: 'request',
    } satisfies Partial<XaiStructuredClientError>);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['unnormalized whitespace', ' Answer with leading whitespace.'],
    ['non-NFC text', 'Cafe\u0301'],
    ['too many characters', '123456'],
    ['a control character', 'safe\u0000unsafe'],
  ])('rejects %s in a plain-text final answer', async (_name, text) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(
        agentResponse([
          {
            type: 'message',
            content: [{ type: 'output_text', text }],
          },
        ]),
      );
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      client.runAgent({
        schemaName: 'unused_plain_text_schema_v1',
        schema: { type: 'object' },
        systemPrompt: 'Answer naturally.',
        payload: {},
        tools: [
          {
            name: 'read_balance',
            description: 'Read one household account balance.',
            parameters: { type: 'object' },
            execute: async () => ({}),
          },
        ],
        maxTurns: 1,
        finalResponseFormat: 'text',
        maxFinalResponseCharacters: 5,
      }),
    ).rejects.toMatchObject({
      code: 'invalid-response',
      phase: 'request',
      responseStage: 'agent-final-text',
    } satisfies Partial<XaiStructuredClientError>);
  });

  it('reserves the final turn for an answer and never executes a final-turn tool call', async () => {
    const firstCall = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'categorize_transaction',
      arguments: JSON.stringify({ category: 'Home Insurance' }),
    };
    const forbiddenFinalCall = {
      type: 'function_call',
      call_id: 'call-2',
      name: 'categorize_transaction',
      arguments: JSON.stringify({ category: 'Car Insurance' }),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(agentResponse([firstCall]))
      .mockResolvedValueOnce(agentResponse([forbiddenFinalCall]));
    const execute = vi.fn(async () => ({ status: 'queued' }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    await expect(
      client.runAgent({
        schemaName: 'finance_agent_reply_v1',
        schema: {
          type: 'object',
          properties: { reply: { type: 'string' } },
          required: ['reply'],
          additionalProperties: false,
        },
        systemPrompt: 'Use the finance tools and return a helpful answer.',
        payload: { question: 'Categorize the insurance payment.' },
        tools: [
          {
            name: 'categorize_transaction',
            description: 'Categorize one transaction.',
            parameters: {
              type: 'object',
              properties: { category: { type: 'string' } },
              required: ['category'],
              additionalProperties: false,
            },
            execute,
          },
        ],
        maxTurns: 2,
      }),
    ).rejects.toMatchObject({
      code: 'response-incomplete',
      phase: 'request',
    } satisfies Partial<XaiStructuredClientError>);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { category: 'Home Insurance' },
      undefined,
    );
    const firstRequest = JSON.parse(
      String(fetchImplementation.mock.calls[1]?.[1]?.body),
    ) as { tool_choice: string };
    const finalRequest = JSON.parse(
      String(fetchImplementation.mock.calls[2]?.[1]?.body),
    ) as { input: unknown[]; tool_choice: string };
    expect(firstRequest.tool_choice).toBe('auto');
    expect(finalRequest.tool_choice).toBe('none');
    expect(finalRequest.input).toEqual(
      expect.arrayContaining([
        {
          role: 'system',
          content:
            'Answer the household now using the facts already available. Do not narrate more checking or work you might do later. If the request cannot be completed safely, say what you can conclude and ask at most one concrete question.',
        },
      ]),
    );
  });

  it('does not accept a tool-free placeholder when a tool result is required', async () => {
    const placeholder = {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: JSON.stringify({ reply: 'I am checking now.' }),
        },
      ],
    };
    const functionCall = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'read_balance',
      arguments: JSON.stringify({ account: 'Daily Spending' }),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ acknowledged: true }))
      .mockResolvedValueOnce(agentResponse([placeholder]))
      .mockResolvedValueOnce(agentResponse([functionCall]))
      .mockResolvedValueOnce(
        agentResponse([
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ reply: 'The balance is $100.00.' }),
              },
            ],
          },
        ]),
      );
    const execute = vi.fn(async () => ({ balanceMinorUnits: 10_000 }));
    const client = new XaiStructuredClient({
      apiKey: 'test-key',
      fetchImplementation,
    });

    const run = await client.runAgent({
      schemaName: 'finance_agent_reply_v1',
      schema: {
        type: 'object',
        properties: { reply: { type: 'string' } },
        required: ['reply'],
        additionalProperties: false,
      },
      systemPrompt: 'Use the finance tools and return a helpful answer.',
      payload: { question: 'What is the balance?' },
      tools: [
        {
          name: 'read_balance',
          description: 'Read one household account balance.',
          parameters: {
            type: 'object',
            properties: { account: { type: 'string' } },
            required: ['account'],
            additionalProperties: false,
          },
          execute,
        },
      ],
      maxTurns: 4,
      requireInitialToolCall: true,
    });

    expect(run.value).toEqual({ reply: 'The balance is $100.00.' });
    expect(run.metadata).toMatchObject({
      turns: 3,
      toolCalls: ['read_balance'],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const retry = JSON.parse(
      String(fetchImplementation.mock.calls[2]?.[1]?.body),
    ) as { input: unknown[]; tool_choice: string };
    expect(retry.tool_choice).toBe('required');
    expect(retry.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('prior response was invalid'),
        }),
      ]),
    );
    const finalRequest = JSON.parse(
      String(fetchImplementation.mock.calls[3]?.[1]?.body),
    ) as { tool_choice: string };
    expect(finalRequest.tool_choice).toBe('auto');
  });
});
