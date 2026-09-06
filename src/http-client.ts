import { Fault } from './domain.js';

export async function readBytes(
  response: Response,
  limit: number,
): Promise<Buffer> {
  // Fetch decodes compressed responses but retains wire-size headers.
  const encoding = response.headers.get('content-encoding');
  const declared =
    !encoding || encoding === 'identity'
      ? response.headers.get('content-length')
      : null;
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    await response.body?.cancel();
    throw new Fault('response-size');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Fault('response-size');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault('network-error', true);
  }
  if (declared !== null && Number(declared) !== size)
    throw new Fault('response-incomplete', true);
  return Buffer.concat(chunks, size);
}
export async function request(
  url: string | URL,
  init: RequestInit,
  timeout = 30000,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Fault('network-error', true);
  }
}
