import { createHash } from 'node:crypto';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDocumentPreparerHttpServer,
  MAX_DOCUMENT_PREPARER_SOURCE_BYTES,
  parseDocumentPreparerServiceConfig,
  RemoteReceiptDocumentPreparer,
  type DocumentPreparer,
  type DocumentPreparerServiceReportCode,
} from '../../src/documents/index.js';
import type { PreparedReceiptDocument } from '../../src/model/index.js';

interface TestResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function jpegSource(label = 'synthetic receipt'): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(label, 'utf8'),
  ]);
}

function preparedDocument(sourceSha256: string): PreparedReceiptDocument {
  const page = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
  return {
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
  };
}

async function startService(
  preparer: DocumentPreparer,
  reportError?: (code: DocumentPreparerServiceReportCode) => void,
): Promise<string> {
  const server = createDocumentPreparerHttpServer({
    preparer,
    ...(reportError === undefined ? {} : { reportError }),
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function send(
  baseUrl: string,
  bytes: Buffer,
  overrides: Record<string, string> = {},
): Promise<TestResponse> {
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const url = new URL('/prepare', baseUrl);
  return new Promise<TestResponse>((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': 'image/jpeg',
          'x-source-sha256': sourceSha256,
          ...overrides,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.once('error', reject);
    request.end(bytes);
  });
}

describe('document preparer HTTP service', () => {
  it('serves fixed liveness and readiness responses', async () => {
    const baseUrl = await startService({
      prepare: vi.fn(),
    });

    const [live, ready] = await Promise.all([
      fetch(`${baseUrl}/health/live`),
      fetch(`${baseUrl}/health/ready`),
    ]);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
  });

  it('accepts one canonical raw document and returns validated base64 pages', async () => {
    const bytes = jpegSource();
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const prepare = vi.fn(async () => preparedDocument(sourceSha256));
    const baseUrl = await startService({ prepare });

    const response = await send(baseUrl, bytes);
    const payload = JSON.parse(response.body.toString('utf8')) as {
      sourceSha256: string;
      pages: Array<{ bytesBase64: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers['content-length']).toBe(
      String(response.body.byteLength),
    );
    expect(payload.sourceSha256).toBe(sourceSha256);
    expect(Buffer.from(payload.pages[0]?.bytesBase64 ?? '', 'base64')).toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0x01]),
    );
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('interoperates end to end with the strict remote client', async () => {
    const inputBytes = jpegSource();
    const sourceSha256 = createHash('sha256').update(inputBytes).digest('hex');
    const baseUrl = await startService({
      prepare: async () => preparedDocument(sourceSha256),
    });
    const client = new RemoteReceiptDocumentPreparer({
      endpoint: baseUrl,
      fetchImplementation: fetch,
    });

    const prepared = await client.prepare({
      bytes: inputBytes,
      mediaType: 'image/jpeg',
      sourceSha256,
    });

    expect(prepared.sourceSha256).toBe(sourceSha256);
    expect(prepared.pages[0]?.bytes).toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0x01]),
    );
  });

  it('rejects noncanonical metadata, caps, hash drift, and MIME drift before preparation', async () => {
    const bytes = jpegSource();
    const prepare = vi.fn(async () =>
      preparedDocument(createHash('sha256').update(bytes).digest('hex')),
    );
    const baseUrl = await startService({ prepare });

    const [noncanonicalLength, oversized, hashMismatch, mimeMismatch] =
      await Promise.all([
        send(baseUrl, bytes, {
          'content-length': `0${String(bytes.byteLength)}`,
        }),
        send(baseUrl, Buffer.alloc(0), {
          'content-length': String(MAX_DOCUMENT_PREPARER_SOURCE_BYTES + 1),
        }),
        send(baseUrl, bytes, { 'x-source-sha256': '0'.repeat(64) }),
        send(baseUrl, bytes, { 'content-type': 'image/png' }),
      ]);

    expect(noncanonicalLength.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(hashMismatch.status).toBe(422);
    expect(mimeMismatch.status).toBe(415);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('allows only one preparation at a time', async () => {
    const bytes = jpegSource();
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    let release: (() => void) | undefined;
    let announceStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = vi.fn(async () => {
      announceStart?.();
      await blocked;
      return preparedDocument(sourceSha256);
    });
    const baseUrl = await startService({ prepare });

    const first = send(baseUrl, bytes);
    await started;
    const second = await send(baseUrl, bytes);
    release?.();
    const firstResponse = await first;

    expect(second.status).toBe(503);
    expect(second.body.toString('utf8')).toBe('{"error":"busy"}');
    expect(firstResponse.status).toBe(200);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('uses fixed errors and report codes without leaking content or paths', async () => {
    const privateMarker = 'private-card-marker /private/source/path';
    const bytes = jpegSource(privateMarker);
    const reported: DocumentPreparerServiceReportCode[] = [];
    const baseUrl = await startService(
      {
        prepare: async () => {
          throw new Error(privateMarker);
        },
      },
      (code) => reported.push(code),
    );

    const response = await send(baseUrl, bytes);

    expect(response.status).toBe(500);
    expect(response.body.toString('utf8')).toBe('{"error":"internal_error"}');
    expect(JSON.stringify(reported)).not.toContain(privateMarker);
    expect(response.body.toString('utf8')).not.toContain(privateMarker);
  });

  it('does not let a failing fixed-code reporter break safe responses', async () => {
    const privateMarker = 'private reporter implementation detail';
    const bytes = jpegSource();
    const baseUrl = await startService(
      {
        prepare: async () => {
          throw new Error(privateMarker);
        },
      },
      () => {
        throw new Error(privateMarker);
      },
    );

    const response = await send(baseUrl, bytes);

    expect(response.status).toBe(500);
    expect(response.body.toString('utf8')).toBe('{"error":"internal_error"}');
    expect(response.body.toString('utf8')).not.toContain(privateMarker);
  });
});

describe('document preparer service configuration', () => {
  it('defaults to 0.0.0.0:4390 and accepts bounded explicit values', () => {
    expect(parseDocumentPreparerServiceConfig({})).toEqual({
      host: '0.0.0.0',
      port: 4390,
    });
    expect(
      parseDocumentPreparerServiceConfig({
        HOST: '127.0.0.1',
        PORT: '5432',
      }),
    ).toEqual({ host: '127.0.0.1', port: 5432 });
  });

  it.each([
    { HOST: 'host/name' },
    { HOST: 'host\nname' },
    { PORT: '04390' },
    { PORT: '0' },
    { PORT: '65536' },
  ])('rejects unsafe or noncanonical environment values', (environment) => {
    expect(() => parseDocumentPreparerServiceConfig(environment)).toThrowError(
      'Document preparer service configuration is invalid',
    );
  });
});
