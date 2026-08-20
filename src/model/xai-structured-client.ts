import { z } from 'zod';

import {
  XaiResponsesTransport,
  XaiResponsesTransportError,
  xaiZdrPreflightBody,
} from './xai-responses-transport.js';

const DEFAULT_MODEL = 'grok-4.6';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_FINAL_TEXT_CHARACTERS = 1_600;
const MAX_FINAL_TEXT_CHARACTERS = 8_000;
const FINAL_AGENT_TURN_INSTRUCTION =
  'Answer the household now using the facts already available. Do not narrate more checking or work you might do later. If the request cannot be completed safely, say what you can conclude and ask at most one concrete question.';
const safeModelNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const reasoningEfforts = ['low', 'medium', 'high'] as const;
type ReasoningEffort = (typeof reasoningEfforts)[number];

const preflightAcknowledgementSchema = z.strictObject({
  acknowledged: z.literal(true),
});

const responseEnvelopeSchema = z
  .object({
    status: z.string(),
    model: z.string(),
    output: z.array(z.unknown()),
    usage: z.unknown(),
  })
  .passthrough();

const messageOutputSchema = z
  .object({
    type: z.literal('message'),
    content: z.array(z.unknown()),
  })
  .passthrough();

const outputTextSchema = z
  .object({
    type: z.literal('output_text'),
    text: z.string(),
  })
  .passthrough();

const refusalSchema = z
  .object({
    type: z.literal('refusal'),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    type: z.literal('function_call'),
    call_id: z.string().min(1).max(500),
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    arguments: z.string().max(128 * 1024),
  })
  .passthrough();

const usageSchema = z
  .object({
    input_tokens: z.number().int().safe().nonnegative().optional(),
    output_tokens: z.number().int().safe().nonnegative().optional(),
    total_tokens: z.number().int().safe().nonnegative().optional(),
    cost_in_usd_ticks: z.number().int().safe().nonnegative(),
    output_tokens_details: z
      .object({
        reasoning_tokens: z.number().int().safe().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface XaiStructuredUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly costInUsdTicks: number;
}

export interface XaiStructuredRunMetadata {
  readonly provider: 'xai';
  readonly requestedModel: string;
  readonly resolvedModel: string;
  readonly preflightAttempts: number;
  readonly requestAttempts: number;
  readonly durationMs: number;
  readonly zeroDataRetention: true;
  readonly usage: XaiStructuredUsage;
}

export interface XaiStructuredRun {
  readonly value: unknown;
  readonly metadata: XaiStructuredRunMetadata;
}

export interface XaiFunctionTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(argumentsValue: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface XaiAgentConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface XaiAgentRequest extends Omit<
  XaiStructuredRequest,
  'webSearch'
> {
  readonly tools: readonly XaiFunctionTool[];
  /**
   * Optional native dialogue preceding currentUserMessage. Payload remains a
   * bounded data-only context block and is never treated as write authority.
   */
  readonly conversationMessages?: readonly XaiAgentConversationMessage[];
  readonly currentUserMessage?: string;
  readonly maxTurns?: number;
  readonly requireInitialToolCall?: boolean;
  readonly initialToolName?: string;
  readonly finalResponseFormat?: 'structured' | 'text';
  readonly maxFinalResponseCharacters?: number;
}

export interface XaiAgentRunMetadata extends XaiStructuredRunMetadata {
  readonly turns: number;
  readonly toolCalls: readonly string[];
}

export interface XaiAgentRun {
  readonly value: unknown;
  readonly metadata: XaiAgentRunMetadata;
}

export interface XaiWebSearchOptions {
  /** Bound the provider-side research loop for one API request. */
  readonly maxTurns: number;
  /** Bound billable provider-side search and page-browse calls. */
  readonly maxToolCalls: number;
}

export interface XaiStructuredRequest {
  readonly schemaName: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly systemPrompt: string;
  readonly payload: unknown;
  readonly maxOutputTokens?: number;
  /** Optional xAI-hosted search. Receipt evidence remains unchanged. */
  readonly webSearch?: XaiWebSearchOptions;
}

export type XaiStructuredClientErrorCode =
  | 'invalid-configuration'
  | 'invalid-request'
  | 'request-aborted-before-send'
  | 'request-aborted'
  | 'request-timeout'
  | 'network-error'
  | 'http-error'
  | 'zdr-required'
  | 'response-incomplete'
  | 'response-refused'
  | 'invalid-response';

export type XaiStructuredClientResponseStage =
  | 'response-body'
  | 'response-envelope'
  | 'model-mismatch'
  | 'response-usage'
  | 'structured-output'
  | 'agent-output'
  | 'agent-final-text'
  | 'initial-tool'
  | 'tool-name'
  | 'tool-arguments'
  | 'tool-output'
  | 'preflight-acknowledgement';

export class XaiStructuredClientError extends Error {
  constructor(
    readonly code: XaiStructuredClientErrorCode,
    readonly phase: 'configuration' | 'preflight' | 'request',
    readonly httpStatus?: number,
    readonly responseStage?: XaiStructuredClientResponseStage,
  ) {
    super(
      `xAI structured request failed: ${code}${
        httpStatus === undefined ? '' : ` (HTTP ${String(httpStatus)})`
      }`,
    );
    this.name = 'XaiStructuredClientError';
  }
}

function invalidResponseError(
  phase: 'preflight' | 'request',
  responseStage: XaiStructuredClientResponseStage,
): XaiStructuredClientError {
  return new XaiStructuredClientError(
    'invalid-response',
    phase,
    undefined,
    responseStage,
  );
}

export interface XaiStructuredClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleepImplementation?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onRunCompleted?: (
    metadata: XaiStructuredRunMetadata | XaiAgentRunMetadata,
  ) => void;
  readonly onRequestFailure?: (error: XaiStructuredClientError) => void;
}

interface ParsedEnvelope {
  readonly value: unknown;
  readonly usage: XaiStructuredUsage;
}

interface ParsedAgentEnvelope {
  readonly output: readonly unknown[];
  readonly value?: unknown;
  readonly toolCalls: readonly z.infer<typeof functionCallSchema>[];
  readonly usage: XaiStructuredUsage;
}

function boundedPositiveInteger(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function decodedEnvelope(
  text: string,
  expectedModel: string,
  phase: 'preflight' | 'request',
): z.infer<typeof responseEnvelopeSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw invalidResponseError(phase, 'response-envelope');
  }
  const envelope = responseEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    throw invalidResponseError(phase, 'response-envelope');
  }
  if (envelope.data.status !== 'completed') {
    throw new XaiStructuredClientError(
      'response-incomplete',
      phase,
      undefined,
      'response-envelope',
    );
  }
  if (envelope.data.model !== expectedModel) {
    throw invalidResponseError(phase, 'model-mismatch');
  }
  return envelope.data;
}

function parsedUsage(
  value: unknown,
  phase: 'preflight' | 'request',
): XaiStructuredUsage {
  const usage = usageSchema.safeParse(value);
  if (!usage.success) {
    throw invalidResponseError(phase, 'response-usage');
  }
  return {
    ...(usage.data.input_tokens === undefined
      ? {}
      : { inputTokens: usage.data.input_tokens }),
    ...(usage.data.output_tokens === undefined
      ? {}
      : { outputTokens: usage.data.output_tokens }),
    ...(usage.data.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : {
          reasoningTokens: usage.data.output_tokens_details.reasoning_tokens,
        }),
    ...(usage.data.total_tokens === undefined
      ? {}
      : { totalTokens: usage.data.total_tokens }),
    costInUsdTicks: usage.data.cost_in_usd_ticks,
  };
}

function parseEnvelope(
  text: string,
  expectedModel: string,
  phase: 'preflight' | 'request',
): ParsedEnvelope {
  const envelope = decodedEnvelope(text, expectedModel, phase);
  const texts: string[] = [];
  let refused = false;
  for (const output of envelope.output) {
    const message = messageOutputSchema.safeParse(output);
    if (!message.success) {
      continue;
    }
    for (const content of message.data.content) {
      refused ||= refusalSchema.safeParse(content).success;
      const outputText = outputTextSchema.safeParse(content);
      if (outputText.success) {
        texts.push(outputText.data.text);
      }
    }
  }
  if (refused) {
    throw new XaiStructuredClientError('response-refused', phase);
  }
  if (texts.length !== 1) {
    throw invalidResponseError(phase, 'structured-output');
  }
  let value: unknown;
  try {
    value = JSON.parse(texts[0] ?? '') as unknown;
  } catch {
    throw invalidResponseError(phase, 'structured-output');
  }
  return {
    value,
    usage: parsedUsage(envelope.usage, phase),
  };
}

function parseAgentEnvelope(
  text: string,
  expectedModel: string,
  finalResponseFormat: 'structured' | 'text',
  maxFinalResponseCharacters: number,
): ParsedAgentEnvelope {
  const envelope = decodedEnvelope(text, expectedModel, 'request');
  const toolCalls: z.infer<typeof functionCallSchema>[] = [];
  const texts: string[] = [];
  let refused = false;
  for (const output of envelope.output) {
    const toolCall = functionCallSchema.safeParse(output);
    if (toolCall.success) {
      toolCalls.push(toolCall.data);
      continue;
    }
    const message = messageOutputSchema.safeParse(output);
    if (!message.success) continue;
    for (const content of message.data.content) {
      refused ||= refusalSchema.safeParse(content).success;
      const outputText = outputTextSchema.safeParse(content);
      if (outputText.success) texts.push(outputText.data.text);
    }
  }
  if (refused) {
    throw new XaiStructuredClientError('response-refused', 'request');
  }
  if (toolCalls.length > 0) {
    return {
      output: envelope.output,
      toolCalls,
      usage: parsedUsage(envelope.usage, 'request'),
    };
  }
  if (texts.length !== 1) {
    throw invalidResponseError('request', 'agent-output');
  }
  if (finalResponseFormat === 'text') {
    const value = texts[0] ?? '';
    if (
      value.length === 0 ||
      [...value].length > maxFinalResponseCharacters ||
      value !== value.normalize('NFC').trim() ||
      ![...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint === undefined ||
          codePoint >= 32 ||
          codePoint === 9 ||
          codePoint === 10 ||
          codePoint === 13
        );
      })
    ) {
      throw invalidResponseError('request', 'agent-final-text');
    }
    return {
      output: envelope.output,
      value,
      toolCalls,
      usage: parsedUsage(envelope.usage, 'request'),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(texts[0] ?? '') as unknown;
  } catch {
    throw invalidResponseError('request', 'agent-output');
  }
  return {
    output: envelope.output,
    value,
    toolCalls,
    usage: parsedUsage(envelope.usage, 'request'),
  };
}

function addUsage(
  left: XaiStructuredUsage,
  right: XaiStructuredUsage,
): XaiStructuredUsage {
  const add = (
    first: number | undefined,
    second: number | undefined,
  ): number | undefined => {
    if (first === undefined && second === undefined) {
      return undefined;
    }
    const value = (first ?? 0) + (second ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidResponseError('request', 'response-usage');
    }
    return value;
  };
  const costInUsdTicks = add(left.costInUsdTicks, right.costInUsdTicks);
  if (costInUsdTicks === undefined) {
    throw invalidResponseError('request', 'response-usage');
  }
  const inputTokens = add(left.inputTokens, right.inputTokens);
  const outputTokens = add(left.outputTokens, right.outputTokens);
  const reasoningTokens = add(left.reasoningTokens, right.reasoningTokens);
  const totalTokens = add(left.totalTokens, right.totalTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    costInUsdTicks,
  };
}

function validWebSearchOptions(
  value: XaiWebSearchOptions | undefined,
): boolean {
  return (
    value === undefined ||
    (boundedPositiveInteger(value.maxTurns, 1, 4) &&
      boundedPositiveInteger(value.maxToolCalls, 1, 32))
  );
}

export class XaiStructuredClient {
  readonly #model: string;
  readonly #reasoningEffort: ReasoningEffort;
  readonly #transport: XaiResponsesTransport;
  readonly #now: () => number;
  readonly #overallTimeoutMs: number;
  readonly #onRunCompleted:
    | ((metadata: XaiStructuredRunMetadata | XaiAgentRunMetadata) => void)
    | undefined;
  readonly #onRequestFailure:
    ((error: XaiStructuredClientError) => void) | undefined;

  constructor(options: XaiStructuredClientOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const overallTimeoutMs =
      options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    const retryBaseDelayMs =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const model = options.model ?? DEFAULT_MODEL;
    const reasoningEffort = options.reasoningEffort ?? 'low';
    if (
      !safeModelNamePattern.test(model) ||
      !reasoningEfforts.includes(reasoningEffort) ||
      !boundedPositiveInteger(timeoutMs, 100, 300_000) ||
      !boundedPositiveInteger(overallTimeoutMs, 100, 300_000) ||
      !boundedPositiveInteger(maxAttempts, 1, 3) ||
      !boundedPositiveInteger(retryBaseDelayMs, 0, 5_000)
    ) {
      throw new XaiStructuredClientError(
        'invalid-configuration',
        'configuration',
      );
    }
    this.#model = model;
    this.#reasoningEffort = reasoningEffort;
    this.#now = options.now ?? Date.now;
    this.#overallTimeoutMs = overallTimeoutMs;
    this.#onRunCompleted = options.onRunCompleted;
    this.#onRequestFailure = options.onRequestFailure;
    try {
      this.#transport = new XaiResponsesTransport({
        apiKey: options.apiKey,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        attemptTimeoutMs: timeoutMs,
        overallTimeoutMs,
        maxAttempts,
        retryBaseDelayMs,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        ...(options.fetchImplementation === undefined
          ? {}
          : { fetchImplementation: options.fetchImplementation }),
        ...(options.sleepImplementation === undefined
          ? {}
          : { sleepImplementation: options.sleepImplementation }),
        now: this.#now,
        ...(options.random === undefined ? {} : { random: options.random }),
      });
    } catch {
      throw new XaiStructuredClientError(
        'invalid-configuration',
        'configuration',
      );
    }
  }

  /**
   * Verify the provider's current team-level ZDR state without transmitting
   * household content. Other xAI media clients use this as a gate before they
   * retrieve or upload private source material.
   */
  async assertZeroDataRetention(signal?: AbortSignal): Promise<void> {
    await this.#preflight(signal);
  }

  async run(
    request: XaiStructuredRequest,
    signal?: AbortSignal,
  ): Promise<XaiStructuredRun> {
    const schemaNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
    const outputTokens = request.maxOutputTokens ?? 1_024;
    if (
      !schemaNamePattern.test(request.schemaName) ||
      request.systemPrompt.length < 1 ||
      request.systemPrompt.length > 16_000 ||
      !boundedPositiveInteger(outputTokens, 64, 4_096) ||
      !validWebSearchOptions(request.webSearch)
    ) {
      throw new XaiStructuredClientError('invalid-request', 'request');
    }
    const startedAt = this.#now();
    const operationDeadline = startedAt + this.#overallTimeoutMs;
    const preflight = await this.#preflight(signal, operationDeadline);

    const body = JSON.stringify({
      model: this.#model,
      store: false,
      max_output_tokens: outputTokens,
      reasoning: { effort: this.#reasoningEffort },
      input: [
        {
          role: 'system',
          content: request.systemPrompt,
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify(request.payload),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: request.schemaName,
          schema: request.schema,
          strict: true,
        },
      },
      ...(request.webSearch === undefined
        ? {}
        : {
            tools: [{ type: 'web_search' }],
            tool_choice: 'auto',
            parallel_tool_calls: true,
            max_turns: request.webSearch.maxTurns,
            max_tool_calls: request.webSearch.maxToolCalls,
          }),
    });
    const response = await this.#request(
      body,
      'request',
      (text) => parseEnvelope(text, this.#model, 'request'),
      signal,
      operationDeadline,
    );
    const parsed = response.value;
    const result: XaiStructuredRun = {
      value: parsed.value,
      metadata: {
        provider: 'xai',
        requestedModel: this.#model,
        resolvedModel: this.#model,
        preflightAttempts: preflight.attempts,
        requestAttempts: response.attempts,
        durationMs: Math.max(0, this.#now() - startedAt),
        zeroDataRetention: true,
        usage: addUsage(preflight.usage, parsed.usage),
      },
    };
    this.#notifyCompleted(result.metadata);
    return result;
  }

  async runAgent(
    request: XaiAgentRequest,
    signal?: AbortSignal,
  ): Promise<XaiAgentRun> {
    const schemaNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
    const outputTokens = request.maxOutputTokens ?? 1_024;
    const maxTurns = request.maxTurns ?? 6;
    const finalResponseFormat = request.finalResponseFormat ?? 'structured';
    const maxFinalResponseCharacters =
      request.maxFinalResponseCharacters ?? DEFAULT_MAX_FINAL_TEXT_CHARACTERS;
    const toolNames = request.tools.map((tool) => tool.name);
    const nativeConversation = request.conversationMessages ?? [];
    const usesNativeConversation =
      request.conversationMessages !== undefined ||
      request.currentUserMessage !== undefined;
    const validConversationText = (value: string): boolean =>
      value.length >= 1 &&
      value.length <= 8_000 &&
      value === value.normalize('NFC').trim();
    if (
      !schemaNamePattern.test(request.schemaName) ||
      request.systemPrompt.length < 1 ||
      request.systemPrompt.length > 16_000 ||
      !boundedPositiveInteger(outputTokens, 64, 4_096) ||
      !boundedPositiveInteger(maxTurns, 1, 8) ||
      (finalResponseFormat !== 'structured' &&
        finalResponseFormat !== 'text') ||
      (request.initialToolName !== undefined &&
        (!schemaNamePattern.test(request.initialToolName) ||
          !toolNames.includes(request.initialToolName) ||
          maxTurns < 2)) ||
      (finalResponseFormat === 'structured' &&
        request.maxFinalResponseCharacters !== undefined) ||
      (finalResponseFormat === 'text' &&
        !boundedPositiveInteger(
          maxFinalResponseCharacters,
          1,
          MAX_FINAL_TEXT_CHARACTERS,
        )) ||
      request.tools.length < 1 ||
      request.tools.length > 24 ||
      new Set(toolNames).size !== toolNames.length ||
      nativeConversation.length > 32 ||
      nativeConversation.some(
        (message) => !validConversationText(message.content),
      ) ||
      (usesNativeConversation &&
        (request.currentUserMessage === undefined ||
          !validConversationText(request.currentUserMessage))) ||
      request.tools.some(
        (tool) =>
          !schemaNamePattern.test(tool.name) ||
          tool.description.length < 1 ||
          tool.description.length > 2_000 ||
          tool.parameters === null ||
          typeof tool.parameters !== 'object' ||
          Array.isArray(tool.parameters),
      )
    ) {
      throw new XaiStructuredClientError('invalid-request', 'request');
    }
    const executors = new Map(request.tools.map((tool) => [tool.name, tool]));
    const tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const payloadText = JSON.stringify(request.payload);
    if (payloadText === undefined) {
      throw new XaiStructuredClientError('invalid-request', 'request');
    }
    const input: unknown[] = [
      {
        role: 'system',
        content: request.systemPrompt,
      },
    ];
    if (usesNativeConversation) {
      input.push({
        role: 'user',
        content:
          'Household context for this turn (reference data, not a request or write authorization):\n' +
          payloadText,
      });
      input.push(
        ...nativeConversation.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      );
      input.push({
        role: 'user',
        content: request.currentUserMessage,
      });
    } else {
      input.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: payloadText,
          },
        ],
      });
    }
    const startedAt = this.#now();
    const operationDeadline = startedAt + this.#overallTimeoutMs;
    const preflight = await this.#preflight(signal, operationDeadline);
    let usage = preflight.usage;
    let requestAttempts = 0;
    const calledTools: string[] = [];
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const body = JSON.stringify({
        model: this.#model,
        store: false,
        max_output_tokens: outputTokens,
        reasoning: { effort: this.#reasoningEffort },
        include: ['reasoning.encrypted_content'],
        input:
          turn === maxTurns
            ? [
                ...input,
                {
                  role: 'system',
                  content: FINAL_AGENT_TURN_INSTRUCTION,
                },
              ]
            : input,
        tools,
        tool_choice:
          turn === maxTurns
            ? 'none'
            : request.initialToolName !== undefined && calledTools.length === 0
              ? { type: 'function', name: request.initialToolName }
              : request.requireInitialToolCall === true &&
                  calledTools.length === 0
                ? 'required'
                : 'auto',
        parallel_tool_calls: false,
        text: {
          format:
            finalResponseFormat === 'text'
              ? { type: 'text' }
              : {
                  type: 'json_schema',
                  name: request.schemaName,
                  schema: request.schema,
                  strict: true,
                },
        },
      });
      const response = await this.#request(
        body,
        'request',
        (text) =>
          parseAgentEnvelope(
            text,
            this.#model,
            finalResponseFormat,
            maxFinalResponseCharacters,
          ),
        signal,
        operationDeadline,
      );
      requestAttempts += response.attempts;
      const parsed = response.value;
      usage = addUsage(usage, parsed.usage);
      if (parsed.toolCalls.length === 0) {
        if (
          (request.requireInitialToolCall === true ||
            request.initialToolName !== undefined) &&
          calledTools.length === 0
        ) {
          if (turn >= maxTurns - 1) {
            throw new XaiStructuredClientError(
              'response-incomplete',
              'request',
            );
          }
          input.push({
            role: 'system',
            content:
              'The prior response was invalid because it did not call a supplied tool. Call one relevant supplied tool now. Do not answer until its result is available.',
          });
          continue;
        }
        const result: XaiAgentRun = {
          value: parsed.value,
          metadata: {
            provider: 'xai',
            requestedModel: this.#model,
            resolvedModel: this.#model,
            preflightAttempts: preflight.attempts,
            requestAttempts,
            durationMs: Math.max(0, this.#now() - startedAt),
            zeroDataRetention: true,
            usage,
            turns: turn,
            toolCalls: calledTools,
          },
        };
        this.#notifyCompleted(result.metadata);
        return result;
      }
      if (turn === maxTurns) {
        throw new XaiStructuredClientError('response-incomplete', 'request');
      }
      if (
        request.initialToolName !== undefined &&
        calledTools.length === 0 &&
        (parsed.toolCalls.length !== 1 ||
          parsed.toolCalls[0]?.name !== request.initialToolName)
      ) {
        throw invalidResponseError('request', 'initial-tool');
      }
      input.push(...parsed.output);
      for (const call of parsed.toolCalls) {
        const tool = executors.get(call.name);
        if (tool === undefined) {
          throw invalidResponseError('request', 'tool-name');
        }
        let argumentsValue: unknown;
        try {
          argumentsValue = JSON.parse(call.arguments) as unknown;
        } catch {
          throw invalidResponseError('request', 'tool-arguments');
        }
        signal?.throwIfAborted();
        const result = await tool.execute(argumentsValue, signal);
        const output = JSON.stringify(result);
        if (
          output === undefined ||
          Buffer.byteLength(output, 'utf8') > MAX_TOOL_OUTPUT_BYTES
        ) {
          throw invalidResponseError('request', 'tool-output');
        }
        calledTools.push(call.name);
        input.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        });
      }
    }
    throw new XaiStructuredClientError('response-incomplete', 'request');
  }

  async #preflight(
    signal: AbortSignal | undefined,
    operationDeadline?: number,
  ): Promise<{
    readonly attempts: number;
    readonly usage: XaiStructuredUsage;
  }> {
    const body = xaiZdrPreflightBody(this.#model);
    const response = await this.#request(
      body,
      'preflight',
      (text) => {
        const parsed = parseEnvelope(text, this.#model, 'preflight');
        if (!preflightAcknowledgementSchema.safeParse(parsed.value).success) {
          throw invalidResponseError('preflight', 'preflight-acknowledgement');
        }
        return parsed;
      },
      signal,
      operationDeadline,
    );
    return { attempts: response.attempts, usage: response.value.usage };
  }

  async #request<T>(
    body: string,
    phase: 'preflight' | 'request',
    parse: (text: string) => T,
    externalSignal: AbortSignal | undefined,
    operationDeadline?: number,
  ) {
    try {
      return await this.#transport.request(
        body,
        parse,
        externalSignal,
        operationDeadline,
      );
    } catch (error) {
      if (!(error instanceof XaiResponsesTransportError)) {
        if (error instanceof XaiStructuredClientError) {
          this.#notifyFailure(error);
        }
        throw error;
      }
      if (
        error.code === 'response-size' ||
        error.code === 'response-encoding'
      ) {
        const mapped = invalidResponseError(phase, 'response-body');
        this.#notifyFailure(mapped);
        throw mapped;
      }
      const mapped = new XaiStructuredClientError(
        error.code,
        phase,
        error.httpStatus,
      );
      this.#notifyFailure(mapped);
      throw mapped;
    }
  }

  #notifyCompleted(
    metadata: XaiStructuredRunMetadata | XaiAgentRunMetadata,
  ): void {
    try {
      this.#onRunCompleted?.(metadata);
    } catch {
      // Observability must never change a household-finance outcome.
    }
  }

  #notifyFailure(error: XaiStructuredClientError): void {
    try {
      this.#onRequestFailure?.(error);
    } catch {
      // Observability must never replace the fixed safe model error.
    }
  }
}
