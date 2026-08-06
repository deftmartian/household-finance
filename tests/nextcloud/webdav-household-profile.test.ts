import { describe, expect, it, vi } from 'vitest';

import { createEmptyHouseholdProfile } from '../../src/context/index.js';
import { WebDavHouseholdProfileRepository } from '../../src/nextcloud/index.js';
import type { WebDavHouseholdProfileError } from '../../src/nextcloud/index.js';

const profile = {
  ...createEmptyHouseholdProfile('2026-07-28T12:00:00-03:00'),
  revision: 1,
};

function profileResponse(
  value: unknown = profile,
  etag = '"profile-v1"',
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag,
    },
  });
}

describe('WebDavHouseholdProfileRepository', () => {
  it('reads and validates the versioned household profile', async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      profileResponse(),
    );
    const repository = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation,
    });

    await expect(repository.read()).resolves.toEqual({
      profile,
      etag: '"profile-v1"',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://cloud.example.test/remote.php/dav/files/finance-bot/Finance/Context/household-profile.json',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({
          accept: 'application/json',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(fetchImplementation.mock.calls)).not.toContain(
      'test-secret',
    );
  });

  it('returns undefined only for an absent profile', async () => {
    const repository = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation: vi.fn<typeof fetch>(
        async () => new Response('', { status: 404 }),
      ),
    });

    await expect(repository.read()).resolves.toBeUndefined();
  });

  it('creates collections and a profile without overwriting', async () => {
    const requests: RequestInit[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(init ?? {});
      if (init?.method === 'MKCOL') {
        return new Response('', { status: 405 });
      }
      if (init?.method === 'PUT') {
        return new Response('', { status: 201 });
      }
      return profileResponse();
    });
    const repository = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation,
    });

    await expect(repository.create(profile)).resolves.toEqual({
      profile,
      etag: '"profile-v1"',
    });
    expect(requests.find((request) => request.method === 'PUT')).toMatchObject({
      headers: expect.objectContaining({
        'content-type': 'application/json; charset=utf-8',
        'if-none-match': '*',
      }),
      body: expect.stringContaining(
        '"schemaVersion": "household-finance-profile.v1"',
      ),
    });
  });

  it('uses compare-and-set for replacement and verifies the result', async () => {
    const nextProfile = {
      ...profile,
      revision: 2,
      updatedAt: '2026-07-28T13:00:00-03:00',
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'PUT') {
        expect(init.headers).toMatchObject({
          'if-match': '"profile-v1"',
        });
        return new Response(null, { status: 204 });
      }
      return profileResponse(nextProfile, '"profile-v2"');
    });
    const repository = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation,
    });

    await expect(
      repository.replace('"profile-v1"', nextProfile),
    ).resolves.toEqual({
      profile: nextProfile,
      etag: '"profile-v2"',
    });
  });

  it.each([412, 404])(
    'reports an update conflict for HTTP %s',
    async (status) => {
      const repository = new WebDavHouseholdProfileRepository({
        baseUrl: 'https://cloud.example.test',
        userId: 'finance-bot',
        appPassword: 'test-secret',
        fetchImplementation: vi.fn<typeof fetch>(
          async () => new Response('', { status }),
        ),
      });

      await expect(
        repository.replace('"profile-v1"', profile),
      ).rejects.toMatchObject({
        code: 'conflict',
      } satisfies Partial<WebDavHouseholdProfileError>);
    },
  );

  it('rejects malformed, oversized, and weak-etag profiles', async () => {
    const malformed = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        profileResponse({ schemaVersion: 'wrong' }),
      ),
    });
    await expect(malformed.read()).rejects.toMatchObject({
      code: 'invalid-profile',
    });

    const oversized = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation: vi.fn<typeof fetch>(
        async () =>
          new Response('', {
            status: 200,
            headers: {
              'content-length': String(512 * 1024 + 1),
              etag: '"profile-v1"',
            },
          }),
      ),
    });
    await expect(oversized.read()).rejects.toMatchObject({
      code: 'profile-too-large',
    });

    const weak = new WebDavHouseholdProfileRepository({
      baseUrl: 'https://cloud.example.test',
      userId: 'finance-bot',
      appPassword: 'test-secret',
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        profileResponse(profile, 'W/"profile-v1"'),
      ),
    });
    await expect(weak.read()).rejects.toMatchObject({
      code: 'invalid-etag',
    });
  });

  it('rejects unsafe origins and paths before making requests', () => {
    expect(
      () =>
        new WebDavHouseholdProfileRepository({
          baseUrl: 'http://cloud.example.test',
          userId: 'finance-bot',
          appPassword: 'test-secret',
        }),
    ).toThrow(/invalid-configuration/);
    expect(
      () =>
        new WebDavHouseholdProfileRepository({
          baseUrl: 'https://cloud.example.test',
          userId: 'finance-bot',
          appPassword: 'test-secret',
          path: '../profile.json',
        }),
    ).toThrow(/invalid-configuration/);
  });
});
