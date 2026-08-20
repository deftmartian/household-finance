import { describe, expect, it, vi } from 'vitest';

import {
  XaiResponsesTransport,
  XaiResponsesTransportError,
} from '../../src/model/xai-responses-transport.js';

function response(status: number, body: string, headers = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'x-zero-data-retention': 'true',
      ...headers,
    },
  });
}

describe('shared xAI Responses transport', () => {
  it('honors Retry-After before a bounded successful retry', async () => {
    let now = Date.parse('2026-08-20T12:00:00.000Z');
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, '{}', { 'retry-after': '7' }))
      .mockResolvedValueOnce(response(200, '{"ok":true}'));
    const transport = new XaiResponsesTransport({
      apiKey: 'test-key',
      attemptTimeoutMs: 10_000,
      overallTimeoutMs: 20_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      maxResponseBytes: 1_024,
      fetchImplementation,
      sleepImplementation: sleep,
      now: () => now,
      random: () => 0.25,
    });

    await expect(
      transport.request('{"test":true}', (text) => JSON.parse(text)),
    ).resolves.toMatchObject({ value: { ok: true }, attempts: 2 });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7_000);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('uses full jitter for retryable network errors', async () => {
    let now = 0;
    const delays: number[] = [];
    const transport = new XaiResponsesTransport({
      apiKey: 'test-key',
      attemptTimeoutMs: 10_000,
      overallTimeoutMs: 20_000,
      maxAttempts: 2,
      retryBaseDelayMs: 1_000,
      maxResponseBytes: 1_024,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error('synthetic network failure'))
        .mockResolvedValueOnce(response(200, 'ok')),
      sleepImplementation: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      now: () => now,
      random: () => 0.5,
    });

    await expect(transport.request('body', (text) => text)).resolves.toEqual({
      value: 'ok',
      attempts: 2,
    });
    expect(delays).toEqual([500]);
  });

  it('will not sleep past the overall deadline', async () => {
    const sleep = vi.fn(async () => undefined);
    const transport = new XaiResponsesTransport({
      apiKey: 'test-key',
      attemptTimeoutMs: 100,
      overallTimeoutMs: 100,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      maxResponseBytes: 1_024,
      fetchImplementation: vi.fn(async () =>
        response(429, '{}', { 'retry-after': '60' }),
      ),
      sleepImplementation: sleep,
      now: () => 0,
      random: () => 1,
    });

    const result = transport.request('body', (text) => text);
    await expect(result).rejects.toMatchObject({
      code: 'http-error',
      httpStatus: 429,
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails closed on a missing ZDR header without retrying', async () => {
    const fetchImplementation = vi.fn(
      async () => new Response('{}', { status: 503 }),
    );
    const transport = new XaiResponsesTransport({
      apiKey: 'test-key',
      attemptTimeoutMs: 1_000,
      maxAttempts: 3,
      retryBaseDelayMs: 0,
      maxResponseBytes: 1_024,
      fetchImplementation,
    });

    await expect(
      transport.request('body', (text) => text),
    ).rejects.toBeInstanceOf(XaiResponsesTransportError);
    await expect(
      transport.request('body', (text) => text),
    ).rejects.toMatchObject({ code: 'zdr-required' });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
