import {
  householdProfileSchema,
  type HouseholdProfile,
} from '../context/index.js';

export interface WebDavHouseholdProfileOptions {
  baseUrl: string;
  userId: string;
  appPassword: string;
  path?: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface HouseholdProfileSnapshot {
  profile: HouseholdProfile;
  etag: string;
}

export type WebDavHouseholdProfileErrorCode =
  | 'conflict'
  | 'invalid-configuration'
  | 'invalid-etag'
  | 'invalid-profile'
  | 'profile-too-large'
  | 'read-failed'
  | 'write-failed';

export class WebDavHouseholdProfileError extends Error {
  constructor(readonly code: WebDavHouseholdProfileErrorCode) {
    super(`Nextcloud household profile operation failed: ${code}`);
    this.name = 'WebDavHouseholdProfileError';
  }
}

const DEFAULT_PROFILE_PATH = 'Finance/Context/household-profile.json';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PROFILE_BYTES = 512 * 1024;

function credentialFreeHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new WebDavHouseholdProfileError('invalid-configuration');
  }
  return parsed.origin;
}

function safePathSegments(value: string): string[] {
  const segments = value
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === '.' ||
        segment === '..' ||
        segment.length > 200 ||
        segment.includes('\0'),
    ) ||
    !segments.at(-1)?.endsWith('.json')
  ) {
    throw new WebDavHouseholdProfileError('invalid-configuration');
  }
  return segments;
}

function finiteTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 300_000) {
    throw new WebDavHouseholdProfileError('invalid-configuration');
  }
  return timeout;
}

function strongEtag(value: string | null): string {
  const etag = value?.trim() ?? '';
  if (
    etag.length < 3 ||
    etag.length > 256 ||
    etag.includes('\r') ||
    etag.includes('\n') ||
    etag.startsWith('W/') ||
    !etag.startsWith('"') ||
    !etag.endsWith('"') ||
    etag.slice(1, -1).includes('"')
  ) {
    throw new WebDavHouseholdProfileError('invalid-etag');
  }
  return etag;
}

async function readBoundedProfile(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^(?:0|[1-9]\d*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_PROFILE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebDavHouseholdProfileError('profile-too-large');
  }
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_PROFILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WebDavHouseholdProfileError('profile-too-large');
      }
      chunks.push(Uint8Array.from(chunk.value));
    }
    const combined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(combined);
    } catch {
      throw new WebDavHouseholdProfileError('invalid-profile');
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

function serializedProfile(profile: HouseholdProfile): string {
  const parsed = householdProfileSchema.parse(profile);
  const value = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(value, 'utf8') > MAX_PROFILE_BYTES) {
    throw new WebDavHouseholdProfileError('profile-too-large');
  }
  return value;
}

export class WebDavHouseholdProfileRepository {
  readonly #baseUrl: string;
  readonly #userId: string;
  readonly #authorization: string;
  readonly #segments: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: WebDavHouseholdProfileOptions) {
    this.#baseUrl = credentialFreeHttpsOrigin(options.baseUrl);
    if (
      options.userId.length === 0 ||
      options.userId.length > 200 ||
      options.appPassword.length === 0 ||
      options.appPassword.length > 4_096
    ) {
      throw new WebDavHouseholdProfileError('invalid-configuration');
    }
    this.#userId = options.userId;
    this.#authorization = `Basic ${Buffer.from(
      `${options.userId}:${options.appPassword}`,
    ).toString('base64')}`;
    this.#segments = safePathSegments(options.path ?? DEFAULT_PROFILE_PATH);
    this.#timeoutMs = finiteTimeout(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async read(
    signal?: AbortSignal,
  ): Promise<HouseholdProfileSnapshot | undefined> {
    const response = await this.#request(
      this.#davUrl(this.#segments),
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: this.#authorization,
        },
      },
      signal,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavHouseholdProfileError('read-failed');
    }

    const etag = strongEtag(response.headers.get('etag'));
    const body = await readBoundedProfile(response);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body) as unknown;
    } catch {
      throw new WebDavHouseholdProfileError('invalid-profile');
    }
    const parsed = householdProfileSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new WebDavHouseholdProfileError('invalid-profile');
    }
    return { profile: parsed.data, etag };
  }

  async create(
    profile: HouseholdProfile,
    signal?: AbortSignal,
  ): Promise<HouseholdProfileSnapshot> {
    await this.#ensureCollections(signal);
    const response = await this.#request(
      this.#davUrl(this.#segments),
      {
        method: 'PUT',
        headers: {
          authorization: this.#authorization,
          'content-type': 'application/json; charset=utf-8',
          'if-none-match': '*',
        },
        body: serializedProfile(profile),
      },
      signal,
    );
    if (response.status === 412) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavHouseholdProfileError('conflict');
    }
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavHouseholdProfileError('write-failed');
    }
    return this.#readAndVerify(profile, signal);
  }

  async replace(
    expectedEtag: string,
    profile: HouseholdProfile,
    signal?: AbortSignal,
  ): Promise<HouseholdProfileSnapshot> {
    const response = await this.#request(
      this.#davUrl(this.#segments),
      {
        method: 'PUT',
        headers: {
          authorization: this.#authorization,
          'content-type': 'application/json; charset=utf-8',
          'if-match': strongEtag(expectedEtag),
        },
        body: serializedProfile(profile),
      },
      signal,
    );
    if (response.status === 412 || response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavHouseholdProfileError('conflict');
    }
    if (response.status !== 204) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebDavHouseholdProfileError('write-failed');
    }
    return this.#readAndVerify(profile, signal);
  }

  async #readAndVerify(
    expected: HouseholdProfile,
    signal?: AbortSignal,
  ): Promise<HouseholdProfileSnapshot> {
    const snapshot = await this.read(signal);
    if (
      snapshot === undefined ||
      JSON.stringify(snapshot.profile) !== JSON.stringify(expected)
    ) {
      throw new WebDavHouseholdProfileError('write-failed');
    }
    return snapshot;
  }

  async #ensureCollections(signal?: AbortSignal): Promise<void> {
    const directorySegments = this.#segments.slice(0, -1);
    for (let index = 1; index <= directorySegments.length; index += 1) {
      const response = await this.#request(
        this.#davUrl(directorySegments.slice(0, index)),
        {
          method: 'MKCOL',
          headers: { authorization: this.#authorization },
        },
        signal,
      );
      if (response.status !== 201 && response.status !== 405) {
        await response.body?.cancel().catch(() => undefined);
        throw new WebDavHouseholdProfileError('write-failed');
      }
    }
  }

  #request(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    return this.#fetch(url, {
      ...init,
      redirect: 'error',
      signal:
        externalSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([externalSignal, timeoutSignal]),
    });
  }

  #davUrl(segments: readonly string[]): string {
    return `${this.#baseUrl}/remote.php/dav/files/${encodeURIComponent(
      this.#userId,
    )}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  }
}
