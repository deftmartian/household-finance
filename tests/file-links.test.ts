import { afterEach, expect, it, vi } from 'vitest';
import { Talk } from '../src/talk.js';
afterEach(() => vi.unstubAllGlobals());
const config = {
  url: 'https://cloud.example.test',
  room: 'room',
  secret: 'secret',
  users: ['one', 'two'],
  user: 'service',
  password: 'password',
  archive: 'Finance/Receipts',
  botActor: 'bots/bot-' + 'a'.repeat(40),
};
it('publishes user-independent authenticated file links for originals and details', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) =>
      init.method === 'PROPFIND'
        ? new Response(
            '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>12345</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
            { status: 207 },
          )
        : new Response(null, { status: 201 }),
    ),
  );
  const talk = new Talk(config);
  const source = await talk.archive(Buffer.from('{"synthetic":true}'), '1');
  expect(source.url).toBe('https://cloud.example.test/index.php/f/12345');
  expect(await talk.details('purchase', 1, 'synthetic details')).toBe(
    source.url,
  );
});
it('refuses to emit a link when the server has not confirmed a file identity', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: unknown, init: RequestInit) =>
        new Response(null, { status: init.method === 'PROPFIND' ? 403 : 201 }),
    ),
  );
  await expect(
    new Talk(config).details('purchase', 1, 'synthetic details'),
  ).rejects.toThrow('link');
});
it('requests the original representation to preserve the conditional-download ETag', async () => {
  const bytes = Buffer.from('{"synthetic":true}');
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    if (init.method === 'SEARCH')
      return new Response(
        `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/files/service/upload.json</d:href><d:propstat><d:prop><oc:fileid>12345</oc:fileid><d:getetag>"original"</d:getetag><oc:size>${bytes.length}</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        { status: 207 },
      );
    const headers = new Headers(init.headers);
    expect(headers.get('accept-encoding')).toBe('identity');
    expect(headers.get('if-match')).toBe('"original"');
    return new Response(bytes, {
      status: 200,
      headers: { etag: '"original"', 'content-length': String(bytes.length) },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(
    await new Talk(config).download({
      fileId: '12345',
      etag: 'original',
      size: bytes.length,
      mediaType: 'application/json',
    }),
  ).toEqual(bytes);
});
it('fetches an archived original by its stored link, only inside the service files', async () => {
  const bytes = Buffer.from('synthetic original');
  const fetcher = vi.fn(async (url: unknown, init: RequestInit) => {
    if (init.method === 'SEARCH')
      return new Response(
        `<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>/remote.php/dav/files/service/Finance/a.pdf</d:href><d:propstat><d:prop><oc:fileid>12345</oc:fileid><d:getetag>"e"</d:getetag><oc:size>1</oc:size></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
        { status: 207 },
      );
    expect(String(url)).toBe(
      'https://cloud.example.test/remote.php/dav/files/service/Finance/a.pdf',
    );
    return new Response(bytes, { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const talk = new Talk(config);
  expect(
    await talk.original('https://cloud.example.test/index.php/f/12345'),
  ).toEqual(bytes);
  await expect(
    talk.original('https://other.example.test/index.php/f/12345'),
  ).rejects.toThrow('source-url-unsupported');
  await expect(
    talk.original(
      'https://cloud.example.test/remote.php/dav/files/someone/a.pdf',
    ),
  ).rejects.toThrow('source-url-unsupported');
  await expect(
    talk.original('https://cloud.example.test/index.php/f/12345', 4),
  ).rejects.toThrow('response-size');
});
