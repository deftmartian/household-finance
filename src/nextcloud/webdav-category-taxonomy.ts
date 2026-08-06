import {
  categoryTaxonomySchema,
  type CategoryTaxonomy,
} from '../categorization/taxonomy.js';

export interface WebDavCategoryTaxonomyOptions {
  readonly baseUrl: string;
  readonly userId: string;
  readonly appPassword: string;
  readonly path?: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export type WebDavCategoryTaxonomyErrorCode =
  | 'invalid-configuration'
  | 'invalid-taxonomy'
  | 'read-failed'
  | 'taxonomy-not-found'
  | 'taxonomy-too-large';

export class WebDavCategoryTaxonomyError extends Error {
  constructor(readonly code: WebDavCategoryTaxonomyErrorCode) {
    super(`Nextcloud category taxonomy operation failed: ${code}`);
    this.name = 'WebDavCategoryTaxonomyError';
  }
}

const DEFAULT_PATH = 'Finance/Context/category-taxonomy.json';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_BYTES = 256 * 1_024;

function httpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new WebDavCategoryTaxonomyError('invalid-configuration');
  }
  return parsed.origin;
}

function pathSegments(value: string): readonly string[] {
  const segments = value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (
    segments.length < 2 ||
    !segments.at(-1)?.endsWith('.json') ||
    segments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        segment.length > 200 ||
        segment.includes('\0'),
    )
  ) {
    throw new WebDavCategoryTaxonomyError('invalid-configuration');
  }
  return segments;
}

function timeoutMilliseconds(value: number | undefined): number {
  const result = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(result) || result < 100 || result > 300_000) {
    throw new WebDavCategoryTaxonomyError('invalid-configuration');
  }
  return result;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAXIMUM_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebDavCategoryTaxonomyError('taxonomy-too-large');
  }
  if (response.body === null) {
    throw new WebDavCategoryTaxonomyError('invalid-taxonomy');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAXIMUM_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebDavCategoryTaxonomyError('taxonomy-too-large');
      }
      chunks.push(Uint8Array.from(item.value));
    }
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(combined),
      ) as unknown;
    } catch {
      throw new WebDavCategoryTaxonomyError('invalid-taxonomy');
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/**
 * Read-only model-facing taxonomy source. Actual identifiers live in the
 * isolated reader contract; this document contains only names and aliases.
 */
export class WebDavCategoryTaxonomySource {
  readonly #url: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: WebDavCategoryTaxonomyOptions) {
    const baseUrl = httpsOrigin(options.baseUrl);
    if (
      options.userId.length === 0 ||
      options.userId.length > 200 ||
      options.appPassword.length === 0 ||
      options.appPassword.length > 4_096
    ) {
      throw new WebDavCategoryTaxonomyError('invalid-configuration');
    }
    const segments = pathSegments(options.path ?? DEFAULT_PATH);
    this.#url = `${baseUrl}/remote.php/dav/files/${encodeURIComponent(
      options.userId,
    )}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
    this.#authorization = `Basic ${Buffer.from(
      `${options.userId}:${options.appPassword}`,
    ).toString('base64')}`;
    this.#timeoutMs = timeoutMilliseconds(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async read(signal?: AbortSignal): Promise<CategoryTaxonomy> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: this.#authorization,
        },
        signal:
          signal === undefined
            ? AbortSignal.timeout(this.#timeoutMs)
            : AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      });
    } catch {
      throw new WebDavCategoryTaxonomyError('read-failed');
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavCategoryTaxonomyError('taxonomy-not-found');
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavCategoryTaxonomyError('read-failed');
    }
    const parsed = categoryTaxonomySchema.safeParse(
      await boundedJson(response),
    );
    if (!parsed.success) {
      throw new WebDavCategoryTaxonomyError('invalid-taxonomy');
    }
    return parsed.data;
  }
}
