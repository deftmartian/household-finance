export type XaiResponsesTransportFailureCode =
  | 'invalid-configuration'
  | 'request-aborted-before-send'
  | 'request-aborted'
  | 'request-timeout'
  | 'network-error'
  | 'zdr-required'
  | 'http-error'
  | 'response-size'
  | 'response-encoding';

export class XaiResponsesTransportError extends Error {
  constructor(
    readonly code: XaiResponsesTransportFailureCode,
    readonly httpStatus?: number,
  ) {
    super(
      `xAI transport failed: ${code}${
        httpStatus === undefined ? '' : ` (HTTP ${String(httpStatus)})`
      }`,
    );
    this.name = 'XaiResponsesTransportError';
  }
}

export interface XaiResponsesTransportOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly attemptTimeoutMs: number;
  readonly overallTimeoutMs?: number;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maxResponseBytes: number;
  readonly fetchImplementation?: typeof fetch;
  readonly sleepImplementation?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface XaiResponsesTransportResult<T> {
  readonly value: T;
  readonly attempts: number;
}

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_OVERALL_TIMEOUT_MS = 300_000;
const MAX_RETRY_DELAY_MS = 60_000;

const preflightJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    acknowledged: { const: true },
  },
  required: ['acknowledged'],
  additionalProperties: false,
} as const;

export function xaiZdrPreflightBody(model: string): string {
  return JSON.stringify({
    model,
    store: false,
    max_output_tokens: 128,
    reasoning: { effort: 'low' },
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Return the required structured acknowledgement.',
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'zdr_preflight_v1',
        schema: preflightJsonSchema,
        strict: true,
      },
    },
  });
}

function normalizedBaseUrl(value: string): string {
  const parsed = new URL(value);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    pathname !== '/v1'
  ) {
    throw new XaiResponsesTransportError('invalid-configuration');
  }
  return `${parsed.origin}/v1`;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function hasZeroDataRetention(response: Response): boolean {
  return (
    response.headers.get('x-zero-data-retention')?.trim().toLowerCase() ===
    'true'
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort; callers receive only the fixed transport error.
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  let expectedSize: number | undefined;
  if (declaredLength !== null) {
    const parsedLength = /^(?:0|[1-9]\d*)$/.test(declaredLength)
      ? Number(declaredLength)
      : Number.NaN;
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      await cancelBody(response);
      throw new XaiResponsesTransportError('response-size');
    }
    expectedSize = parsedLength;
  }
  if (response.body === null) {
    if (expectedSize !== undefined && expectedSize !== 0) {
      throw new XaiResponsesTransportError('network-error');
    }
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new XaiResponsesTransportError('response-size');
      }
      chunks.push(Uint8Array.from(next.value));
    }
    if (expectedSize !== undefined && size !== expectedSize) {
      throw new XaiResponsesTransportError('network-error');
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new XaiResponsesTransportError('response-encoding');
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof XaiResponsesTransportError) throw error;
    throw new XaiResponsesTransportError('network-error');
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function retryAfterMilliseconds(
  response: Response,
  now: number,
): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (value === undefined || value === '') return undefined;
  if (/^(?:0|[1-9]\d*)$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds)
      ? Math.min(milliseconds, MAX_RETRY_DELAY_MS)
      : undefined;
  }
  const target = Date.parse(value);
  if (!Number.isFinite(target)) return undefined;
  return Math.min(Math.max(0, target - now), MAX_RETRY_DELAY_MS);
}

export class XaiResponsesTransport {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #attemptTimeoutMs: number;
  readonly #overallTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(options: XaiResponsesTransportOptions) {
    const overallTimeoutMs =
      options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    if (
      options.apiKey.length === 0 ||
      options.apiKey.length > 4_096 ||
      options.apiKey !== options.apiKey.trim() ||
      options.apiKey.includes('\n') ||
      options.apiKey.includes('\r') ||
      !boundedInteger(options.attemptTimeoutMs, 1, 300_000) ||
      !boundedInteger(overallTimeoutMs, 100, 300_000) ||
      !boundedInteger(options.maxAttempts, 1, 3) ||
      !boundedInteger(options.retryBaseDelayMs, 0, 5_000) ||
      !boundedInteger(options.maxResponseBytes, 1_024, 4 * 1_024 * 1_024)
    ) {
      throw new XaiResponsesTransportError('invalid-configuration');
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = normalizedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#attemptTimeoutMs = options.attemptTimeoutMs;
    this.#overallTimeoutMs = overallTimeoutMs;
    this.#maxAttempts = options.maxAttempts;
    this.#retryBaseDelayMs = options.retryBaseDelayMs;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#sleep =
      options.sleepImplementation ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  async request<T>(
    body: string,
    parse: (text: string) => T,
    externalSignal?: AbortSignal,
    operationDeadline?: number,
  ): Promise<XaiResponsesTransportResult<T>> {
    const transportDeadline = this.#now() + this.#overallTimeoutMs;
    const deadline = Math.min(
      transportDeadline,
      operationDeadline ?? transportDeadline,
    );
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (isAborted(externalSignal)) {
        throw new XaiResponsesTransportError('request-aborted-before-send');
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        throw new XaiResponsesTransportError('request-timeout');
      }
      const timeoutSignal = AbortSignal.timeout(
        Math.max(1, Math.min(this.#attemptTimeoutMs, remaining)),
      );
      const signal =
        externalSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([externalSignal, timeoutSignal]);
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
          },
          body,
          redirect: 'error',
          signal,
        });
      } catch {
        const code = isAborted(externalSignal)
          ? 'request-aborted'
          : timeoutSignal.aborted
            ? 'request-timeout'
            : 'network-error';
        if (
          code !== 'request-aborted' &&
          attempt < this.#maxAttempts &&
          (await this.#sleepBeforeRetry(attempt, undefined, deadline))
        ) {
          continue;
        }
        throw new XaiResponsesTransportError(code);
      }
      if (!hasZeroDataRetention(response)) {
        await cancelBody(response);
        throw new XaiResponsesTransportError('zdr-required');
      }
      if (response.ok) {
        let text: string;
        try {
          text = await readBoundedText(response, this.#maxResponseBytes);
        } catch (error) {
          if (
            error instanceof XaiResponsesTransportError &&
            (error.code === 'response-size' ||
              error.code === 'response-encoding')
          ) {
            throw error;
          }
          await cancelBody(response);
          const code = isAborted(externalSignal)
            ? 'request-aborted'
            : timeoutSignal.aborted
              ? 'request-timeout'
              : 'network-error';
          if (
            code !== 'request-aborted' &&
            attempt < this.#maxAttempts &&
            (await this.#sleepBeforeRetry(attempt, undefined, deadline))
          ) {
            continue;
          }
          throw new XaiResponsesTransportError(code);
        }
        return { value: parse(text), attempts: attempt };
      }
      const status = response.status;
      const retryAfter = retryAfterMilliseconds(response, this.#now());
      await cancelBody(response);
      if (
        isRetryableStatus(status) &&
        attempt < this.#maxAttempts &&
        (await this.#sleepBeforeRetry(attempt, retryAfter, deadline))
      ) {
        continue;
      }
      throw new XaiResponsesTransportError('http-error', status);
    }
    throw new XaiResponsesTransportError('network-error');
  }

  async #sleepBeforeRetry(
    attempt: number,
    retryAfter: number | undefined,
    deadline: number,
  ): Promise<boolean> {
    const ceiling = Math.min(
      MAX_RETRY_DELAY_MS,
      this.#retryBaseDelayMs * 2 ** (attempt - 1),
    );
    const jitter = Math.floor(
      Math.max(0, Math.min(1, this.#random())) * ceiling,
    );
    const delay = Math.max(retryAfter ?? 0, jitter);
    if (this.#now() + delay >= deadline) return false;
    await this.#sleep(delay);
    return true;
  }
}
