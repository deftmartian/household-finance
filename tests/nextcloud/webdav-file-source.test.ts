import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  WebDavFileSource,
  type WebDavFileSourceErrorCode,
} from '../../src/nextcloud/index.js';
import {
  MAX_TALK_RECEIPT_ATTACHMENT_BYTES,
  type TalkAttachmentMediaType,
  type TalkAttachmentReference,
  type TalkVoiceAttachmentReference,
} from '../../src/talk/index.js';

interface MediaFixture {
  extension: string;
  mediaType: TalkAttachmentMediaType;
  bytes: Buffer;
}

interface DavMetadata {
  href: string;
  fileId: string;
  etag: string;
  mediaType: string;
  sizeBytes: number;
}

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

const mediaFixtures: readonly MediaFixture[] = [
  {
    extension: 'jpg',
    mediaType: 'image/jpeg',
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xd9]),
  },
  {
    extension: 'png',
    mediaType: 'image/png',
    bytes: Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
    ]),
  },
  {
    extension: 'pdf',
    mediaType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n', 'ascii'),
  },
];

const jpegFixture = mediaFixtures[0] as MediaFixture;

function attachmentReference(
  fixture: MediaFixture = jpegFixture,
  overrides: Partial<TalkAttachmentReference> = {},
): TalkAttachmentReference {
  return {
    fileId: '12345',
    etag: `synthetic-${fixture.extension}-etag`,
    sizeBytes: fixture.bytes.length,
    mediaType: fixture.mediaType,
    ...overrides,
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function davMetadata(
  reference: TalkAttachmentReference | TalkVoiceAttachmentReference,
  extension = 'jpg',
  overrides: Partial<DavMetadata> = {},
): DavMetadata {
  return {
    href: `/remote.php/dav/files/finance-bot/Inbox/receipt.${extension}`,
    fileId: reference.fileId,
    etag: `"${reference.etag}"`,
    mediaType: reference.mediaType,
    sizeBytes: reference.sizeBytes,
    ...overrides,
  };
}

function multistatus(
  entries: readonly DavMetadata[],
  responseStatus = 'HTTP/1.1 200 OK',
): Response {
  const responses = entries
    .map(
      (entry) => `<d:response>
  <d:href>${xmlEscape(entry.href)}</d:href>
  <d:propstat>
    <d:prop>
      <d:getcontenttype>${xmlEscape(entry.mediaType)}</d:getcontenttype>
      <d:getetag>${xmlEscape(entry.etag)}</d:getetag>
      <oc:fileid>${xmlEscape(entry.fileId)}</oc:fileid>
      <oc:size>${String(entry.sizeBytes)}</oc:size>
    </d:prop>
    <d:status>${responseStatus}</d:status>
  </d:propstat>
</d:response>`,
    )
    .join('');

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses}</d:multistatus>`,
    {
      status: 207,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    },
  );
}

function source(fetchImplementation: typeof fetch): WebDavFileSource {
  return new WebDavFileSource({
    baseUrl: 'https://cloud.example.test',
    userId: 'finance-bot',
    appPassword: 'must-not-leak',
    fetchImplementation,
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: WebDavFileSourceErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('WebDavFileSource', () => {
  it.each(mediaFixtures)(
    'resolves, conditionally downloads, and sniffs a signed $mediaType file',
    async (fixture) => {
      const reference = attachmentReference(fixture);
      const metadata = davMetadata(reference, fixture.extension);
      const requests: RecordedRequest[] = [];
      const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
        requests.push({
          url: String(url),
          ...(init === undefined ? {} : { init }),
        });
        if (init?.method === 'SEARCH') {
          return multistatus([metadata]);
        }
        return new Response(new Uint8Array(fixture.bytes), {
          status: 200,
          headers: {
            'content-length': String(fixture.bytes.length),
            'content-type': fixture.mediaType,
          },
        });
      });

      await expect(
        source(fetchImplementation).retrieve(reference),
      ).resolves.toEqual({
        bytes: fixture.bytes,
        etag: reference.etag,
        mediaType: fixture.mediaType,
        sizeBytes: fixture.bytes.length,
        sourceSha256: createHash('sha256').update(fixture.bytes).digest('hex'),
      });

      expect(requests).toHaveLength(2);
      expect(requests[0]?.url).toBe(
        'https://cloud.example.test/remote.php/dav/',
      );
      expect(requests[0]?.init).toMatchObject({
        method: 'SEARCH',
        body: expect.stringContaining('<d:href>/files/finance-bot</d:href>'),
      });
      expect(requests[0]?.init?.body).toEqual(
        expect.stringContaining(`<d:literal>${reference.fileId}</d:literal>`),
      );
      expect(requests[1]?.url).toBe(
        `https://cloud.example.test${metadata.href}`,
      );
      expect(new Headers(requests[1]?.init?.headers).get('if-match')).toBe(
        `"${reference.etag}"`,
      );
      for (const request of requests) {
        expect(request.init).toMatchObject({
          redirect: 'error',
          signal: expect.any(AbortSignal),
        });
      }
      expect(JSON.stringify(requests)).not.toContain('must-not-leak');
    },
  );

  it('recognizes Talk M4A bytes that Nextcloud labels as MP3', async () => {
    const bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
    ]);
    const reference = {
      fileId: '6837799',
      etag: 'voice-etag',
      sizeBytes: bytes.length,
      mediaType: 'audio/mpeg',
    } satisfies TalkVoiceAttachmentReference;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'SEARCH'
        ? multistatus([davMetadata(reference, 'mp3')])
        : new Response(new Uint8Array(bytes), {
            status: 200,
            headers: {
              'content-length': String(bytes.length),
              'content-type': 'audio/mpeg',
            },
          }),
    );

    await expect(
      source(fetchImplementation).retrieveVoice(reference),
    ).resolves.toMatchObject({
      mediaType: 'audio/mp4',
      sizeBytes: bytes.length,
    });
  });

  it('uses metadata only from successful DAV propstats', async () => {
    const reference = attachmentReference();
    const metadata = davMetadata(reference);
    const responseBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>${metadata.href}</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontenttype>image/png</d:getcontenttype>
        <d:getetag>&quot;wrong-etag&quot;</d:getetag>
        <oc:fileid>99999</oc:fileid>
        <oc:size>999</oc:size>
      </d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop>
        <d:getcontenttype>${metadata.mediaType}</d:getcontenttype>
        <d:getetag>${xmlEscape(metadata.etag)}</d:getetag>
        <oc:fileid>${metadata.fileId}</oc:fileid>
        <oc:size>${String(metadata.sizeBytes)}</oc:size>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'SEARCH'
        ? new Response(responseBody, { status: 207 })
        : new Response(new Uint8Array(jpegFixture.bytes), {
            status: 200,
            headers: {
              'content-length': String(jpegFixture.bytes.length),
              'content-type': 'image/jpeg',
            },
          }),
    );

    await expect(
      source(fetchImplementation).retrieve(reference),
    ).resolves.toMatchObject({
      mediaType: 'image/jpeg',
      sizeBytes: jpegFixture.bytes.length,
    });
  });

  it('reports when SEARCH cannot see the signed file', async () => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      multistatus([]),
    );

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'file-not-found',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects multiple SEARCH resources for the signed file ID', async () => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      multistatus(
        Array.from({ length: 2 }, (_unused, index) =>
          davMetadata(reference, 'jpg', {
            href: `/remote.php/dav/files/finance-bot/Inbox/receipt-${String(
              index,
            )}.jpg`,
          }),
        ),
      ),
    );

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'ambiguous-file',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://attacker.invalid/remote.php/dav/files/finance-bot/receipt.jpg',
    '/remote.php/dav/files/alex/receipt.jpg',
    '/remote.php/dav/files/finance-bot/receipt.jpg?download=1',
    '/remote.php/dav/files/finance-bot/folder%2Freceipt.jpg',
    '/remote.php/dav/files/finance-bot/folder%252Freceipt.jpg',
    '/remote.php/dav/files/finance-bot/%2e%2e/alex/receipt.jpg',
    '/remote.php/dav/files/finance-bot/%252e%252e/alex/receipt.jpg',
  ])('rejects an unconstrained SEARCH href: %s', async (href) => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      multistatus([davMetadata(reference, 'jpg', { href })]),
    );

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'unsafe-file-url',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'etag',
      override: { etag: '"different-etag"' },
    },
    {
      label: 'size',
      override: { sizeBytes: jpegFixture.bytes.length + 1 },
    },
    {
      label: 'MIME type',
      override: { mediaType: 'image/png' },
    },
  ])('rejects signed-to-DAV $label drift', async ({ override }) => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      multistatus([davMetadata(reference, 'jpg', override)]),
    );

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'metadata-mismatch',
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects a changed file at conditional GET time', async () => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'SEARCH'
        ? multistatus([davMetadata(reference)])
        : new Response('', { status: 412 }),
    );

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'download-failed',
    );
  });

  it.each([
    { failurePoint: 'SEARCH', code: 'search-failed' as const },
    { failurePoint: 'GET', code: 'download-failed' as const },
  ])(
    'maps a $failurePoint transport failure to a safe error code',
    async ({ failurePoint, code }) => {
      const reference = attachmentReference();
      const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
        if (init?.method === failurePoint) {
          throw new Error('sensitive transport detail');
        }
        return multistatus([davMetadata(reference)]);
      });

      await expectCode(source(fetchImplementation).retrieve(reference), code);
    },
  );

  it.each([
    {
      label: 'Content-Length',
      headers: {
        'content-length': String(jpegFixture.bytes.length + 1),
        'content-type': 'image/jpeg',
      },
      bytes: jpegFixture.bytes,
      code: 'metadata-mismatch' as const,
    },
    {
      label: 'Content-Type',
      headers: {
        'content-length': String(jpegFixture.bytes.length),
        'content-type': 'image/png',
      },
      bytes: jpegFixture.bytes,
      code: 'media-type-mismatch' as const,
    },
    {
      label: 'magic bytes',
      headers: {
        'content-length': String(jpegFixture.bytes.length),
        'content-type': 'image/jpeg',
      },
      bytes: Buffer.alloc(jpegFixture.bytes.length, 0x41),
      code: 'media-type-mismatch' as const,
    },
  ])('rejects mismatched download $label', async ({ headers, bytes, code }) => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'SEARCH'
        ? multistatus([davMetadata(reference)])
        : new Response(new Uint8Array(bytes), { status: 200, headers }),
    );

    await expectCode(source(fetchImplementation).retrieve(reference), code);
  });

  it('enforces the streaming cap without trusting Content-Length', async () => {
    const reference = attachmentReference(jpegFixture, {
      sizeBytes: MAX_TALK_RECEIPT_ATTACHMENT_BYTES,
    });
    const oversized = new Uint8Array(MAX_TALK_RECEIPT_ATTACHMENT_BYTES + 1);
    oversized.set(jpegFixture.bytes.subarray(0, 3), 0);
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'SEARCH') {
        return multistatus([davMetadata(reference)]);
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        },
      );
    });

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'file-too-large',
    );
  });

  it('rejects invalid and oversized signed references before networking', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const fileSource = source(fetchImplementation);

    await expectCode(
      fileSource.retrieve(
        attachmentReference(jpegFixture, { etag: 'weak\r\netag' }),
      ),
      'invalid-reference',
    );
    await expectCode(
      fileSource.retrieve(
        attachmentReference(jpegFixture, { etag: 'W/"weak-etag"' }),
      ),
      'invalid-reference',
    );
    await expectCode(
      fileSource.retrieve(attachmentReference(jpegFixture, { sizeBytes: 0 })),
      'invalid-reference',
    );
    await expectCode(
      fileSource.retrieve(
        attachmentReference(jpegFixture, {
          sizeBytes: MAX_TALK_RECEIPT_ATTACHMENT_BYTES + 1,
        }),
      ),
      'file-too-large',
    );
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('uses the configured finite timeout for SEARCH and GET', async () => {
    const reference = attachmentReference();
    const timeoutSignal = new AbortController().signal;
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutSignal);
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({
        redirect: 'error',
        signal: timeoutSignal,
      });
      return init?.method === 'SEARCH'
        ? multistatus([davMetadata(reference)])
        : new Response(new Uint8Array(jpegFixture.bytes), {
            status: 200,
            headers: {
              'content-length': String(jpegFixture.bytes.length),
              'content-type': 'image/jpeg',
            },
          });
    });

    try {
      const fileSource = new WebDavFileSource({
        baseUrl: 'https://cloud.example.test',
        userId: 'finance-bot',
        appPassword: 'test-password',
        requestTimeoutMs: 1_234,
        fetchImplementation,
      });

      await fileSource.retrieve(reference);

      expect(timeout).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenNthCalledWith(1, 1_234);
      expect(timeout).toHaveBeenNthCalledWith(2, 1_234);
    } finally {
      timeout.mockRestore();
    }
  });

  it('rejects active XML constructs in a SEARCH response', async () => {
    const reference = attachmentReference();
    const fetchImplementation = vi.fn<typeof fetch>(
      async () =>
        new Response(
          '<!DOCTYPE d:multistatus [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:"/>',
          { status: 207 },
        ),
    );

    await expectCode(
      source(fetchImplementation).retrieve(reference),
      'search-failed',
    );
  });
});
