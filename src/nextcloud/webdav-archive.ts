import { createHash } from 'node:crypto';

export interface WebDavArchiveOptions {
  baseUrl: string;
  userId: string;
  appPassword: string;
  rootPath: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface PreserveOriginalInput {
  idempotencyKey: string;
  sourceText: string;
  receivedAt: string;
}

export type BinaryOriginalMediaType =
  'image/jpeg' | 'image/png' | 'application/pdf';

export interface PreserveBinaryOriginalInput {
  idempotencyKey: string;
  sourceBytes: Uint8Array;
  mediaType: BinaryOriginalMediaType;
  receivedAt: string;
}

export interface PreservedOriginal {
  path: string;
  created: boolean;
}

interface PreserveBytesInput {
  idempotencyKey: string;
  sourceBytes: Buffer;
  uploadBody: NonNullable<RequestInit['body']>;
  contentType: string;
  extension: string;
  receivedAt: string;
}

function pathSegments(path: string): string[] {
  const segments = path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('WebDAV archive path must contain safe path segments');
  }

  return segments;
}

function encodePath(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function requestTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('WebDAV request timeout must be a positive integer');
  }
  return timeoutMs;
}

function binaryExtension(mediaType: BinaryOriginalMediaType): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'application/pdf':
      return 'pdf';
    default:
      throw new Error('Cannot archive an unsupported binary media type');
  }
}

async function readExactBytes(
  response: Response,
  expectedLength: number,
): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = Buffer.from(chunk.value);
      size += bytes.length;
      if (size > expectedLength) {
        await reader.cancel().catch(() => undefined);
        bytes.fill(0);
        throw new Error(
          'WebDAV immutable-original collision failed exact-content verification',
        );
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
  }
}

export class WebDavOriginalArchive {
  readonly #baseUrl: string;
  readonly #userId: string;
  readonly #authorization: string;
  readonly #rootSegments: string[];
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: WebDavArchiveOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#userId = options.userId;
    this.#authorization = `Basic ${Buffer.from(
      `${options.userId}:${options.appPassword}`,
    ).toString('base64')}`;
    this.#rootSegments = pathSegments(options.rootPath);
    this.#requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async preserveOriginal(
    input: PreserveOriginalInput,
  ): Promise<PreservedOriginal> {
    return this.#preserveBytes({
      idempotencyKey: input.idempotencyKey,
      sourceBytes: Buffer.from(input.sourceText, 'utf8'),
      uploadBody: input.sourceText,
      contentType: 'text/plain; charset=utf-8',
      extension: 'txt',
      receivedAt: input.receivedAt,
    });
  }

  async preserveBinaryOriginal(
    input: PreserveBinaryOriginalInput,
    signal?: AbortSignal,
  ): Promise<PreservedOriginal> {
    const sourceBytes = Buffer.from(input.sourceBytes);
    if (sourceBytes.length === 0) {
      throw new Error('Cannot archive an empty binary original');
    }
    try {
      return await this.#preserveBytes(
        {
          idempotencyKey: input.idempotencyKey,
          sourceBytes,
          uploadBody: sourceBytes,
          contentType: input.mediaType,
          extension: binaryExtension(input.mediaType),
          receivedAt: input.receivedAt,
        },
        signal,
      );
    } finally {
      sourceBytes.fill(0);
    }
  }

  async #preserveBytes(
    input: PreserveBytesInput,
    signal?: AbortSignal,
  ): Promise<PreservedOriginal> {
    const date = new Date(input.receivedAt);
    if (Number.isNaN(date.valueOf())) {
      throw new Error('Cannot archive an original with an invalid timestamp');
    }

    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const digest = createHash('sha256')
      .update('finance-original-v1\0')
      .update(input.idempotencyKey)
      .update('\0')
      .update(input.sourceBytes)
      .digest('hex');
    const directory = [...this.#rootSegments, year, month];
    const filename = `${digest}.${input.extension}`;
    const fileSegments = [...directory, filename];

    await this.#ensureCollections(directory, signal);

    const response = await this.#request(
      this.#davUrl(fileSegments),
      {
        method: 'PUT',
        headers: {
          authorization: this.#authorization,
          'content-type': input.contentType,
          'if-none-match': '*',
        },
        body: input.uploadBody,
      },
      signal,
    );

    if (response.status === 412) {
      const existing = await this.#request(
        this.#davUrl(fileSegments),
        {
          method: 'GET',
          headers: { authorization: this.#authorization },
        },
        signal,
      );
      if (existing.status !== 200) {
        throw new Error(
          `WebDAV original verification failed with HTTP ${String(existing.status)}`,
        );
      }
      const existingBytes = await readExactBytes(
        existing,
        input.sourceBytes.length,
      );
      try {
        if (!existingBytes.equals(input.sourceBytes)) {
          throw new Error(
            'WebDAV immutable-original collision failed exact-content verification',
          );
        }
      } finally {
        existingBytes.fill(0);
      }
      return { path: fileSegments.join('/'), created: false };
    }
    if (response.status !== 201) {
      throw new Error(
        `WebDAV original preservation failed with HTTP ${String(response.status)}`,
      );
    }

    return { path: fileSegments.join('/'), created: true };
  }

  async #ensureCollections(
    segments: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (let index = 1; index <= segments.length; index += 1) {
      const response = await this.#request(
        this.#davUrl(segments.slice(0, index)),
        {
          method: 'MKCOL',
          headers: { authorization: this.#authorization },
        },
        signal,
      );

      if (response.status !== 201 && response.status !== 405) {
        throw new Error(
          `WebDAV collection creation failed with HTTP ${String(response.status)}`,
        );
      }
    }
  }

  #request(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal =
      externalSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([externalSignal, timeoutSignal]);
    return this.#fetch(url, {
      ...init,
      redirect: 'error',
      signal: requestSignal,
    });
  }

  #davUrl(segments: readonly string[]): string {
    return `${this.#baseUrl}/remote.php/dav/files/${encodeURIComponent(
      this.#userId,
    )}/${encodePath(segments)}`;
  }
}
