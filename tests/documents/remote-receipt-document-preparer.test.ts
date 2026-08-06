import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
  MAX_DOCUMENT_PREPARER_RESPONSE_BYTES,
  RemoteReceiptDocumentPreparationError,
  RemoteReceiptDocumentPreparer,
  ReceiptDocumentPreparationError,
  serializePreparedReceiptDocument,
  type ReceiptDocumentSource,
} from '../../src/documents/index.js';

function source(label = 'synthetic receipt'): ReceiptDocumentSource {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(label, 'utf8'),
  ]);
  return {
    bytes,
    mediaType: 'image/jpeg',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function successfulPayload(
  sourceSha256: string,
  overrides: Record<string, unknown> = {},
): Buffer {
  const page = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
  const serialized = serializePreparedReceiptDocument({
    schemaVersion: 'prepared-receipt-document.v1',
    sourceSha256,
    pages: [
      {
        position: 0,
        mediaType: 'image/jpeg',
        sha256: createHash('sha256').update(page).digest('hex'),
        bytes: page,
      },
    ],
  });
  if (Object.keys(overrides).length === 0) {
    return serialized;
  }
  const parsed = JSON.parse(serialized.toString('utf8')) as Record<
    string,
    unknown
  >;
  return Buffer.from(JSON.stringify({ ...parsed, ...overrides }), 'utf8');
}

function jsonResponse(body: Buffer, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    ...init,
    headers: {
      'content-length': String(body.byteLength),
      'content-type': DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
      ...init.headers,
    },
  });
}

describe('RemoteReceiptDocumentPreparer', () => {
  it('posts exact raw bytes to the pinned internal service and revalidates the response', async () => {
    const input = source();
    let sentBytes: Buffer | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      sentBytes = Buffer.from(init?.body as Uint8Array);
      return jsonResponse(successfulPayload(input.sourceSha256));
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const preparer = new RemoteReceiptDocumentPreparer({
      requestTimeoutMs: 123_456,
      fetchImplementation,
    });

    try {
      const prepared = await preparer.prepare(input);
      const [url, init] = fetchImplementation.mock.calls[0] ?? [];
      const headers = new Headers(init?.headers);

      expect(String(url)).toBe('http://document-preparer:4390/prepare');
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
      expect(headers.get('content-length')).toBe(
        String(input.bytes.byteLength),
      );
      expect(headers.get('content-type')).toBe('image/jpeg');
      expect(headers.get('x-source-sha256')).toBe(input.sourceSha256);
      expect(sentBytes).toEqual(input.bytes);
      expect(prepared.sourceSha256).toBe(input.sourceSha256);
      expect(prepared.pages[0]?.bytes).toEqual(
        Buffer.from([0xff, 0xd8, 0xff, 0x01]),
      );
      expect(timeout).toHaveBeenCalledWith(123_456);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    'https://document-preparer:4390',
    'http://user:password@document-preparer:4390',
    'http://document-preparer:4390/other',
    'http://127.0.0.1:4390',
    'http://[::1]:4390',
    'http://document-preparer.example.test:4390',
    'http://other-service:4390',
    'http://document-preparer',
  ])('rejects an unsafe live endpoint: %s', (endpoint) => {
    expect(
      () => new RemoteReceiptDocumentPreparer({ endpoint }),
    ).toThrowError();
  });

  it('permits an injected test transport to target a local HTTP origin', async () => {
    const input = source();
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(successfulPayload(input.sourceSha256)));
    const preparer = new RemoteReceiptDocumentPreparer({
      endpoint: 'http://127.0.0.1:4390',
      fetchImplementation,
    });

    await preparer.prepare(input);

    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:4390/prepare',
    );
  });

  it('rejects invalid source hash and MIME before networking', async () => {
    const input = source();
    const fetchImplementation = vi.fn<typeof fetch>();
    const preparer = new RemoteReceiptDocumentPreparer({
      fetchImplementation,
    });

    await expect(
      preparer.prepare({ ...input, sourceSha256: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(ReceiptDocumentPreparationError);
    await expect(
      preparer.prepare({ ...input, mediaType: 'image/png' }),
    ).rejects.toMatchObject({ code: 'image-invalid' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('propagates caller cancellation and maps it to a retryable safe error', async () => {
    const input = source();
    const controller = new AbortController();
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('private transport cancellation detail'));
          });
        }),
    );
    const preparer = new RemoteReceiptDocumentPreparer({
      fetchImplementation,
    });

    const pending = preparer.prepare(input, controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: 'request-aborted',
      retryable: true,
    });
  });

  it('maps its bounded timeout to a retryable safe error', async () => {
    const input = source();
    const timeoutController = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutController.signal);
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('private timeout detail'));
          });
        }),
    );
    const preparer = new RemoteReceiptDocumentPreparer({
      requestTimeoutMs: 1_234,
      fetchImplementation,
    });

    try {
      const pending = preparer.prepare(input);
      timeoutController.abort();
      await expect(pending).rejects.toMatchObject({
        code: 'request-timeout',
        retryable: true,
      });
    } finally {
      timeout.mockRestore();
    }
  });

  it('maps fixed preparation failures from the service', async () => {
    const input = source();
    const body = Buffer.from(
      JSON.stringify({
        error: 'preparation_failed',
        code: 'image-limits-exceeded',
      }),
    );
    const preparer = new RemoteReceiptDocumentPreparer({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(body, { status: 422 })),
    });

    await expect(preparer.prepare(input)).rejects.toMatchObject({
      code: 'image-limits-exceeded',
    });
  });

  it.each([
    {
      name: 'wrong source hash',
      mutate: (body: Record<string, unknown>) => ({
        ...body,
        sourceSha256: '0'.repeat(64),
      }),
    },
    {
      name: 'extra document field',
      mutate: (body: Record<string, unknown>) => ({
        ...body,
        privatePath: '/private/source/path',
      }),
    },
    {
      name: 'noncanonical base64',
      mutate: (body: Record<string, unknown>) => ({
        ...body,
        pages: [
          {
            ...((body.pages as Array<Record<string, unknown>>)[0] ?? {}),
            bytesBase64: '/9j/ ',
          },
        ],
      }),
    },
    {
      name: 'page hash mismatch',
      mutate: (body: Record<string, unknown>) => ({
        ...body,
        pages: [
          {
            ...((body.pages as Array<Record<string, unknown>>)[0] ?? {}),
            sha256: '0'.repeat(64),
          },
        ],
      }),
    },
    {
      name: 'page MIME magic mismatch',
      mutate: (body: Record<string, unknown>) => ({
        ...body,
        pages: [
          {
            ...((body.pages as Array<Record<string, unknown>>)[0] ?? {}),
            mediaType: 'image/png',
          },
        ],
      }),
    },
  ])('rejects an invalid $name response', async ({ mutate }) => {
    const input = source();
    const valid = successfulPayload(input.sourceSha256);
    const parsed = JSON.parse(valid.toString('utf8')) as Record<
      string,
      unknown
    >;
    const invalid = Buffer.from(JSON.stringify(mutate(parsed)), 'utf8');
    const preparer = new RemoteReceiptDocumentPreparer({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(invalid)),
    });

    await expect(preparer.prepare(input)).rejects.toMatchObject({
      code: 'invalid-response',
      retryable: false,
    });
  });

  it('rejects oversized declared and streamed responses', async () => {
    const input = source();
    const declared = new RemoteReceiptDocumentPreparer({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('', {
          status: 200,
          headers: {
            'content-length': String(MAX_DOCUMENT_PREPARER_RESPONSE_BYTES + 1),
            'content-type': DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
          },
        }),
      ),
    });
    await expect(declared.prepare(input)).rejects.toMatchObject({
      code: 'invalid-response',
    });

    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const streamed = new RemoteReceiptDocumentPreparer({
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent > MAX_DOCUMENT_PREPARER_RESPONSE_BYTES) {
                controller.close();
                return;
              }
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
            },
          },
        ),
      ),
    });
    await expect(streamed.prepare(input)).rejects.toMatchObject({
      code: 'invalid-response',
    });
  });

  it('never includes response or transport content in safe errors', async () => {
    const privateMarker = 'private-card-marker /private/source/path';
    const input = source(privateMarker);
    const preparer = new RemoteReceiptDocumentPreparer({
      fetchImplementation: vi.fn<typeof fetch>(async () => {
        throw new Error(privateMarker);
      }),
    });

    try {
      await preparer.prepare(input);
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteReceiptDocumentPreparationError);
      expect(String(error)).not.toContain(privateMarker);
      return;
    }
    throw new Error('Expected remote preparation to fail');
  });

  it('maps a malformed injected transport result to a fixed safe error', async () => {
    const privateMarker = 'private malformed response detail';
    const input = source(privateMarker);
    const preparer = new RemoteReceiptDocumentPreparer({
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue({ status: 200 } as Response),
    });

    try {
      await preparer.prepare(input);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid-response' });
      expect(String(error)).not.toContain(privateMarker);
      return;
    }
    throw new Error('Expected malformed response to fail');
  });
});
