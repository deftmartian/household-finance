import { describe, expect, it, vi } from 'vitest';

import { WebDavCategoryTaxonomySource } from '../../src/nextcloud/webdav-category-taxonomy.js';
import type { WebDavCategoryTaxonomyError } from '../../src/nextcloud/webdav-category-taxonomy.js';

const taxonomy = {
  schemaVersion: 'household-category-taxonomy.v1',
  currency: 'CAD',
  categories: [
    {
      alias: 'groceries',
      name: 'Groceries',
      description: 'Food and ordinary household groceries.',
      kind: 'expense',
      modelSelectable: true,
    },
  ],
} as const;

function source(fetchImplementation: typeof fetch) {
  return new WebDavCategoryTaxonomySource({
    baseUrl: 'https://cloud.example.test',
    userId: 'finance-bot',
    appPassword: 'secret',
    fetchImplementation,
  });
}

describe('WebDavCategoryTaxonomySource', () => {
  it('reads a bounded alias-only taxonomy over authenticated WebDAV', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      const body = JSON.stringify(taxonomy);
      return new Response(body, {
        status: 200,
        headers: {
          'content-length': String(Buffer.byteLength(body)),
          'content-type': 'application/json',
        },
      });
    });

    await expect(source(fetchImplementation).read()).resolves.toEqual(taxonomy);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://cloud.example.test/remote.php/dav/files/finance-bot/Finance/Context/category-taxonomy.json',
    );
    expect((init?.headers as Record<string, string>).authorization).toMatch(
      /^Basic /,
    );
  });

  it('fails closed for missing, invalid, and oversized taxonomy files', async () => {
    const missing = source(async () => new Response(null, { status: 404 }));
    await expect(missing.read()).rejects.toMatchObject({
      code: 'taxonomy-not-found',
    } satisfies Partial<WebDavCategoryTaxonomyError>);

    const invalidBody = JSON.stringify({ ...taxonomy, currency: 'USD' });
    const invalid = source(
      async () =>
        new Response(invalidBody, {
          status: 200,
          headers: { 'content-length': String(invalidBody.length) },
        }),
    );
    await expect(invalid.read()).rejects.toMatchObject({
      code: 'invalid-taxonomy',
    } satisfies Partial<WebDavCategoryTaxonomyError>);

    const oversized = source(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(300 * 1_024) },
        }),
    );
    await expect(oversized.read()).rejects.toMatchObject({
      code: 'taxonomy-too-large',
    } satisfies Partial<WebDavCategoryTaxonomyError>);
  });
});
