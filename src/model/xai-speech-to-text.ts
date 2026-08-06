import { z } from 'zod';

import type { WebDavFileSource } from '../nextcloud/index.js';
import type { TalkVoiceAttachmentReference } from '../talk/index.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;

const transcriptTextSchema = z
  .string()
  .max(2_000)
  .transform((value) => value.normalize('NFC').trim())
  .pipe(z.string().min(1).max(2_000));

const transcriptWordSchema = z
  .object({
    text: z.string().max(2_000),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
    confidence: z.number().finite().min(0).max(1).optional(),
    speaker: z.number().int().safe().nonnegative().optional(),
  })
  .passthrough()
  .refine((word) => word.end >= word.start);

const responseSchema = z
  .object({
    text: transcriptTextSchema,
    language: z.string().max(32).optional(),
    duration: z.number().finite().nonnegative().max(86_400).optional(),
    words: z.array(transcriptWordSchema).max(10_000).optional(),
  })
  .passthrough();

export interface XaiZeroDataRetentionVerifier {
  assertZeroDataRetention(signal?: AbortSignal): Promise<void>;
}

export type XaiSpeechToTextErrorCode =
  | 'http-error'
  | 'invalid-configuration'
  | 'invalid-response'
  | 'network-error'
  | 'request-aborted'
  | 'request-timeout'
  | 'zdr-required';

export class XaiSpeechToTextError extends Error {
  constructor(
    readonly code: XaiSpeechToTextErrorCode,
    readonly httpStatus?: number,
  ) {
    super(
      `xAI speech transcription failed: ${code}${
        httpStatus === undefined ? '' : ` (HTTP ${String(httpStatus)})`
      }`,
    );
    this.name = 'XaiSpeechToTextError';
  }
}

export interface XaiSpeechToTextOptions {
  apiKey: string;
  baseUrl?: string;
  source: Pick<WebDavFileSource, 'retrieveVoice'>;
  zeroDataRetentionVerifier: XaiZeroDataRetentionVerifier;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}

function speechEndpoint(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new XaiSpeechToTextError('invalid-configuration');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    path !== '/v1'
  ) {
    throw new XaiSpeechToTextError('invalid-configuration');
  }
  return new URL(`${parsed.origin}/v1/stt`);
}

function requestFailure(
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): XaiSpeechToTextError {
  return new XaiSpeechToTextError(
    externalSignal?.aborted === true
      ? 'request-aborted'
      : timeoutSignal.aborted
        ? 'request-timeout'
        : 'network-error',
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort; callers still receive a bounded, content-free error.
  }
}

function hasZeroDataRetention(response: Response): boolean {
  return (
    response.headers.get('x-zero-data-retention')?.trim().toLowerCase() ===
    'true'
  );
}

function hasJsonContentType(response: Response): boolean {
  return (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() === 'application/json'
  );
}

async function readBoundedResponseText(
  response: Response,
  externalSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) {
      await cancelBody(response);
      throw new XaiSpeechToTextError('invalid-response');
    }
    const declaredBytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_RESPONSE_BYTES
    ) {
      await cancelBody(response);
      throw new XaiSpeechToTextError('invalid-response');
    }
  }
  if (response.body === null) {
    throw new XaiSpeechToTextError('invalid-response');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (externalSignal?.aborted === true || timeoutSignal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw requestFailure(externalSignal, timeoutSignal);
      }
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const chunk = Uint8Array.from(next.value);
      next.value.fill(0);
      if (size + chunk.byteLength > MAX_RESPONSE_BYTES) {
        chunk.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new XaiSpeechToTextError('invalid-response');
      }
      size += chunk.byteLength;
      chunks.push(chunk);
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
      throw new XaiSpeechToTextError('invalid-response');
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof XaiSpeechToTextError) {
      throw error;
    }
    throw requestFailure(externalSignal, timeoutSignal);
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

export class XaiSpeechToTextTranscriber {
  readonly #apiKey: string;
  readonly #endpoint: URL;
  readonly #source: Pick<WebDavFileSource, 'retrieveVoice'>;
  readonly #zeroDataRetentionVerifier: XaiZeroDataRetentionVerifier;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: XaiSpeechToTextOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      options.apiKey.length === 0 ||
      options.apiKey.length > 4_096 ||
      options.apiKey !== options.apiKey.trim() ||
      options.apiKey.includes('\n') ||
      options.apiKey.includes('\r') ||
      typeof options.source?.retrieveVoice !== 'function' ||
      typeof options.zeroDataRetentionVerifier?.assertZeroDataRetention !==
        'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 120_000
    ) {
      throw new XaiSpeechToTextError('invalid-configuration');
    }
    this.#apiKey = options.apiKey;
    this.#endpoint = speechEndpoint(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#source = options.source;
    this.#zeroDataRetentionVerifier = options.zeroDataRetentionVerifier;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = timeoutMs;
  }

  async transcribe(
    reference: TalkVoiceAttachmentReference,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.#zeroDataRetentionVerifier.assertZeroDataRetention(signal);
    if (isAborted(signal)) {
      throw new XaiSpeechToTextError('request-aborted');
    }

    const file = await this.#source.retrieveVoice(reference, signal);
    try {
      if (isAborted(signal)) {
        throw new XaiSpeechToTextError('request-aborted');
      }
      const form = new FormData();
      form.append('format', 'true');
      form.append('language', 'en');
      form.append(
        'file',
        new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
        file.mediaType === 'audio/mpeg'
          ? 'voice.mp3'
          : file.mediaType === 'audio/mp4'
            ? 'voice.m4a'
            : 'voice.wav',
      );

      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const requestSignal =
        signal === undefined
          ? timeoutSignal
          : AbortSignal.any([signal, timeoutSignal]);
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
          },
          body: form,
          redirect: 'error',
          signal: requestSignal,
        });
      } catch {
        throw requestFailure(signal, timeoutSignal);
      }
      if (!hasZeroDataRetention(response)) {
        await cancelBody(response);
        throw new XaiSpeechToTextError('zdr-required');
      }
      if (!response.ok) {
        const status = response.status;
        await cancelBody(response);
        throw new XaiSpeechToTextError('http-error', status);
      }
      if (!hasJsonContentType(response)) {
        await cancelBody(response);
        throw new XaiSpeechToTextError('invalid-response');
      }

      const text = await readBoundedResponseText(
        response,
        signal,
        timeoutSignal,
      );
      let decoded: unknown;
      try {
        decoded = JSON.parse(text) as unknown;
      } catch {
        throw new XaiSpeechToTextError('invalid-response');
      }
      const transcript = responseSchema.safeParse(decoded);
      if (!transcript.success) {
        throw new XaiSpeechToTextError('invalid-response');
      }
      return transcript.data.text;
    } finally {
      file.bytes.fill(0);
    }
  }
}
