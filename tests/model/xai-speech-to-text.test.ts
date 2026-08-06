import { describe, expect, it, vi } from 'vitest';

import { XaiSpeechToTextTranscriber } from '../../src/model/xai-speech-to-text.js';
import type {
  XaiSpeechToTextError,
  XaiZeroDataRetentionVerifier,
} from '../../src/model/xai-speech-to-text.js';
import type { TalkVoiceAttachmentReference } from '../../src/talk/index.js';

const reference = {
  fileId: '123',
  etag: 'voice-etag',
  sizeBytes: 128,
  mediaType: 'audio/mpeg',
} satisfies TalkVoiceAttachmentReference;

function providerResponse(
  value: unknown,
  options: {
    zdr?: 'true' | 'false' | 'missing';
    contentType?: string;
    contentLength?: string;
    status?: number;
  } = {},
): Response {
  const body = JSON.stringify(value);
  const zdr = options.zdr ?? 'true';
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': options.contentType ?? 'application/json',
      'content-length':
        options.contentLength ?? String(Buffer.byteLength(body)),
      ...(zdr === 'missing' ? {} : { 'x-zero-data-retention': zdr }),
    },
  });
}

function fixture(bytes: Buffer) {
  return {
    bytes,
    etag: reference.etag,
    mediaType: reference.mediaType,
    sizeBytes: bytes.byteLength,
    sourceSha256: 'a'.repeat(64),
  } as const;
}

function successfulVerifier(): XaiZeroDataRetentionVerifier {
  return {
    assertZeroDataRetention: vi.fn(async () => undefined),
  };
}

function transcriber(options: {
  bytes: Buffer;
  fetchImplementation: typeof fetch;
  verifier?: XaiZeroDataRetentionVerifier;
  timeoutMs?: number;
}) {
  const retrieveVoice = vi.fn(async () => fixture(options.bytes));
  const verifier = options.verifier ?? successfulVerifier();
  return {
    retrieveVoice,
    verifier,
    value: new XaiSpeechToTextTranscriber({
      apiKey: 'synthetic-api-key',
      source: { retrieveVoice },
      zeroDataRetentionVerifier: verifier,
      fetchImplementation: options.fetchImplementation,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    }),
  };
}

describe('XaiSpeechToTextTranscriber', () => {
  it('blocks private retrieval and upload when the content-free preflight fails', async () => {
    const preflightError = new Error('synthetic preflight failure');
    const verifier = {
      assertZeroDataRetention: vi.fn(async () => {
        throw preflightError;
      }),
    };
    const fetchImplementation = vi.fn<typeof fetch>();
    const setup = transcriber({
      bytes: Buffer.from('private voice bytes'),
      fetchImplementation,
      verifier,
    });

    await expect(setup.value.transcribe(reference)).rejects.toBe(
      preflightError,
    );
    expect(verifier.assertZeroDataRetention).toHaveBeenCalledOnce();
    expect(setup.retrieveVoice).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['missing', 'false'] as const)(
    'fails closed and wipes source bytes when the STT ZDR header is %s',
    async (zdr) => {
      const bytes = Buffer.from('private voice bytes');
      const setup = transcriber({
        bytes,
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(providerResponse({ text: 'hello' }, { zdr })),
      });

      await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
        code: 'zdr-required',
      } satisfies Partial<XaiSpeechToTextError>);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('requires an application/json response and wipes source bytes', async () => {
    const bytes = Buffer.from('private voice bytes');
    const setup = transcriber({
      bytes,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          providerResponse({ text: 'hello' }, { contentType: 'text/plain' }),
        ),
    });

    await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
      code: 'invalid-response',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects redirects as a safe network failure and wipes source bytes', async () => {
    const bytes = Buffer.from('private voice bytes');
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) => {
        expect(init?.redirect).toBe('error');
        throw new TypeError('synthetic redirect rejection');
      });
    const setup = transcriber({ bytes, fetchImplementation });

    await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
      code: 'network-error',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects an oversized declared response before reading it', async () => {
    const bytes = Buffer.from('private voice bytes');
    const setup = transcriber({
      bytes,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        providerResponse(
          { text: 'hello' },
          {
            contentLength: String(1024 * 1024 + 1),
          },
        ),
      ),
    });

    await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
      code: 'invalid-response',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('cancels a streamed response that exceeds one MiB', async () => {
    const bytes = Buffer.from('private voice bytes');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array([0x20]));
        controller.close();
      },
    });
    const setup = transcriber({
      bytes,
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: {
            'content-type': 'application/json',
            'x-zero-data-retention': 'true',
          },
        }),
      ),
    });

    await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
      code: 'invalid-response',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    [
      'malformed JSON',
      () =>
        new Response('{not-json', {
          headers: {
            'content-type': 'application/json',
            'x-zero-data-retention': 'true',
          },
        }),
    ],
    [
      'an overlong transcript',
      () => providerResponse({ text: 'x'.repeat(2_001) }),
    ],
  ])('rejects %s and wipes source bytes', async (_case, responseFactory) => {
    const bytes = Buffer.from('private voice bytes');
    const setup = transcriber({
      bytes,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(responseFactory()),
    });

    await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
      code: 'invalid-response',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('reports a bounded timeout and wipes source bytes', async () => {
    const bytes = Buffer.from('private voice bytes');
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!(signal instanceof AbortSignal)) {
            reject(new TypeError('missing request signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const setup = transcriber({
      bytes,
      fetchImplementation,
      timeoutMs: 5,
    });

    await expect(setup.value.transcribe(reference)).rejects.toMatchObject({
      code: 'request-timeout',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('honours an external abort before retrieving private bytes', async () => {
    const controller = new AbortController();
    controller.abort();
    const setup = transcriber({
      bytes: Buffer.from('private voice bytes'),
      fetchImplementation: vi.fn<typeof fetch>(),
    });

    await expect(
      setup.value.transcribe(reference, controller.signal),
    ).rejects.toMatchObject({
      code: 'request-aborted',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(setup.retrieveVoice).not.toHaveBeenCalled();
  });

  it('wipes retrieved bytes when an external abort wins during retrieval', async () => {
    const controller = new AbortController();
    const bytes = Buffer.from('private voice bytes');
    const retrieveVoice = vi.fn(async () => {
      controller.abort();
      return fixture(bytes);
    });
    const fetchImplementation = vi.fn<typeof fetch>();
    const value = new XaiSpeechToTextTranscriber({
      apiKey: 'synthetic-api-key',
      source: { retrieveVoice },
      zeroDataRetentionVerifier: successfulVerifier(),
      fetchImplementation,
    });

    await expect(
      value.transcribe(reference, controller.signal),
    ).rejects.toMatchObject({
      code: 'request-aborted',
    } satisfies Partial<XaiSpeechToTextError>);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('returns a bounded transcript while tolerating provider-added fields', async () => {
    const bytes = Buffer.from('private voice bytes');
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      providerResponse(
        {
          text: '  How much did we spend?  ',
          language: 'en',
          duration: 1.25,
          provider_extension: { version: 2 },
          words: [
            {
              text: 'How',
              start: 0,
              end: 0.2,
              confidence: 0.99,
              provider_word_extension: true,
            },
          ],
        },
        { contentLength: '1' },
      ),
    );
    const setup = transcriber({ bytes, fetchImplementation });

    await expect(setup.value.transcribe(reference)).resolves.toBe(
      'How much did we spend?',
    );
    expect(setup.verifier.assertZeroDataRetention).toHaveBeenCalledWith(
      undefined,
    );
    expect(setup.retrieveVoice).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      'https://api.x.ai/v1/stt',
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});
