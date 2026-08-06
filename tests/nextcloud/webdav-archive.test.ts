import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { WebDavOriginalArchive } from '../../src/nextcloud/index.js';

describe('WebDavOriginalArchive', () => {
  it('creates private archive collections and preserves exact source text', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({
        url: String(url),
        ...(init === undefined ? {} : { init }),
      });
      return new Response('', {
        status: init?.method === 'PUT' ? 201 : 405,
      });
    });
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test/',
      userId: 'finance-bot',
      appPassword: 'must-not-leak',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });
    const sourceText = 'merchant: Synthetic Hardware\namount: 12.99\n';

    const result = await archive.preserveOriginal({
      idempotencyKey: 'receipt-key',
      sourceText,
      receivedAt: '2026-07-26T12:00:00.000Z',
    });

    const digest = createHash('sha256')
      .update('finance-original-v1\0')
      .update('receipt-key')
      .update('\0')
      .update(sourceText)
      .digest('hex');
    expect(result).toEqual({
      path: `Finance Test/Receipts/2026/07/${digest}.txt`,
      created: true,
    });
    expect(requests.at(-1)?.init).toMatchObject({
      method: 'PUT',
      body: sourceText,
    });
    expect(requests.at(-1)?.url).toContain(
      `/Finance%20Test/Receipts/2026/07/${digest}.txt`,
    );
    for (const request of requests) {
      expect(request.init).toMatchObject({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      });
    }
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('uses the configured finite timeout for every WebDAV request', async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutSignal);
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({
        redirect: 'error',
        signal: timeoutSignal,
      });
      return new Response('', {
        status: init?.method === 'PUT' ? 201 : 405,
      });
    });

    try {
      const archive = new WebDavOriginalArchive({
        baseUrl: 'https://cloud.example.test',
        userId: 'finance-bot',
        appPassword: 'test-password',
        rootPath: 'Finance Test/Receipts',
        requestTimeoutMs: 1_234,
        fetchImplementation,
      });

      await archive.preserveOriginal({
        idempotencyKey: 'receipt-key',
        sourceText: 'synthetic',
        receivedAt: '2026-07-26T12:00:00.000Z',
      });

      expect(timeout).toHaveBeenCalledTimes(
        fetchImplementation.mock.calls.length,
      );
      expect(timeout).toHaveBeenCalledWith(1_234);
    } finally {
      timeout.mockRestore();
    }
  });

  it('defaults WebDAV requests to a finite ten-second timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation: vi.fn<typeof fetch>(
        async (_url, init) =>
          new Response('', {
            status: init?.method === 'PUT' ? 201 : 405,
          }),
      ),
    });

    try {
      await archive.preserveOriginal({
        idempotencyKey: 'receipt-key',
        sourceText: 'synthetic',
        receivedAt: '2026-07-26T12:00:00.000Z',
      });

      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('treats an existing immutable original as an idempotent success', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(init?.method === 'GET' ? 'synthetic' : '', {
          status:
            init?.method === 'PUT' ? 412 : init?.method === 'GET' ? 200 : 405,
        }),
    );
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });

    await expect(
      archive.preserveOriginal({
        idempotencyKey: 'receipt-key',
        sourceText: 'synthetic',
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).resolves.toMatchObject({ created: false });
    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.stringContaining('/Finance%20Test/Receipts/2026/07/'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it.each([
    { mediaType: 'image/jpeg' as const, extension: 'jpg' },
    { mediaType: 'image/png' as const, extension: 'png' },
    { mediaType: 'application/pdf' as const, extension: 'pdf' },
  ])(
    'preserves exact $mediaType bytes with a MIME-derived .$extension extension',
    async ({ mediaType, extension }) => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
        const capturedInit =
          init === undefined
            ? undefined
            : {
                ...init,
                ...(init.body instanceof Uint8Array
                  ? { body: Buffer.from(init.body) }
                  : {}),
              };
        requests.push({
          url: String(url),
          ...(capturedInit === undefined ? {} : { init: capturedInit }),
        });
        return new Response('', {
          status: init?.method === 'PUT' ? 201 : 405,
        });
      });
      const archive = new WebDavOriginalArchive({
        baseUrl: 'https://cloud.example.test',
        userId: 'finance-bot',
        appPassword: 'test-password',
        rootPath: 'Finance Test/Receipts',
        fetchImplementation,
      });
      const sourceBytes = Buffer.from([
        0x00, 0xff, 0x80, 0x0a, 0x73, 0x79, 0x6e, 0x74, 0x68,
      ]);

      const result = await archive.preserveBinaryOriginal({
        idempotencyKey: 'binary-receipt-key',
        sourceBytes,
        mediaType,
        receivedAt: '2026-07-26T12:00:00.000Z',
      });

      const digest = createHash('sha256')
        .update('finance-original-v1\0')
        .update('binary-receipt-key')
        .update('\0')
        .update(sourceBytes)
        .digest('hex');
      expect(result).toEqual({
        path: `Finance Test/Receipts/2026/07/${digest}.${extension}`,
        created: true,
      });
      const put = requests.find((request) => request.init?.method === 'PUT');
      expect(put?.init).toMatchObject({
        method: 'PUT',
        headers: expect.objectContaining({
          'content-type': mediaType,
          'if-none-match': '*',
        }),
      });
      expect(Buffer.from(put?.init?.body as Uint8Array)).toEqual(sourceBytes);
      expect(put?.url).toContain(`/${digest}.${extension}`);
    },
  );

  it('treats an exact pre-existing binary original as idempotent', async () => {
    const sourceBytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'PUT') {
        return new Response('', { status: 412 });
      }
      if (init?.method === 'GET') {
        return new Response(new Uint8Array(sourceBytes), { status: 200 });
      }
      return new Response('', { status: 405 });
    });
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });

    await expect(
      archive.preserveBinaryOriginal({
        idempotencyKey: 'binary-receipt-key',
        sourceBytes,
        mediaType: 'image/png',
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).resolves.toMatchObject({ created: false });
  });

  it('rejects a binary collision whose exact bytes differ', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'PUT') {
        return new Response('', { status: 412 });
      }
      if (init?.method === 'GET') {
        return new Response(new Uint8Array([0x00, 0xff, 0x80, 0x42]), {
          status: 200,
        });
      }
      return new Response('', { status: 405 });
    });
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });

    await expect(
      archive.preserveBinaryOriginal({
        idempotencyKey: 'binary-receipt-key',
        sourceBytes: Buffer.from([0x00, 0xff, 0x80, 0x41]),
        mediaType: 'image/png',
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).rejects.toThrow(/exact-content verification/);
  });

  it('rejects an empty binary original without making a request', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });

    await expect(
      archive.preserveBinaryOriginal({
        idempotencyKey: 'binary-receipt-key',
        sourceBytes: Buffer.alloc(0),
        mediaType: 'image/jpeg',
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).rejects.toThrow(/empty binary original/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects an unsupported binary media type at the runtime boundary', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });

    await expect(
      archive.preserveBinaryOriginal({
        idempotencyKey: 'binary-receipt-key',
        sourceBytes: Buffer.from([0x01]),
        mediaType: 'image/gif' as never,
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).rejects.toThrow(/unsupported binary media type/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects a pre-existing path whose bytes do not match the original', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(init?.method === 'GET' ? 'different bytes' : '', {
          status:
            init?.method === 'PUT' ? 412 : init?.method === 'GET' ? 200 : 405,
        }),
    );
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation,
    });

    await expect(
      archive.preserveOriginal({
        idempotencyKey: 'receipt-key',
        sourceText: 'synthetic',
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).rejects.toThrow(/exact-content verification/);
  });

  it('rejects an overwrite-like WebDAV success response', async () => {
    const archive = new WebDavOriginalArchive({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-password',
      rootPath: 'Finance Test/Receipts',
      fetchImplementation: vi.fn<typeof fetch>(
        async (_url, init) =>
          new Response(init?.method === 'PUT' ? null : '', {
            status: init?.method === 'PUT' ? 204 : 405,
          }),
      ),
    });

    await expect(
      archive.preserveOriginal({
        idempotencyKey: 'receipt-key',
        sourceText: 'synthetic',
        receivedAt: '2026-07-26T12:00:00.000Z',
      }),
    ).rejects.toThrow(/HTTP 204/);
  });
});
