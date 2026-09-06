import { expect, it } from 'vitest';
import { readBytes } from '../src/http-client.js';
it('bounds decoded data without comparing it to compressed wire length', async () => {
  const response = new Response('decoded payload', {
    headers: { 'content-encoding': 'gzip', 'content-length': '5' },
  });
  expect((await readBytes(response, 100)).toString()).toBe('decoded payload');
  await expect(
    readBytes(
      new Response('too large', {
        headers: { 'content-encoding': 'gzip', 'content-length': '1' },
      }),
      3,
    ),
  ).rejects.toThrow();
});
it('still rejects incomplete uncompressed responses', async () => {
  await expect(
    readBytes(
      new Response('short', { headers: { 'content-length': '20' } }),
      100,
    ),
  ).rejects.toThrow('incomplete');
});
