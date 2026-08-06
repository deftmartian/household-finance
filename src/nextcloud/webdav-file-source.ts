import { createHash } from 'node:crypto';

import {
  MAX_TALK_RECEIPT_ATTACHMENT_BYTES,
  talkAttachmentMediaTypes,
  talkVoiceAttachmentMediaTypes,
  type TalkAttachmentMediaType,
  type TalkAttachmentReference,
  type TalkVoiceAttachmentMediaType,
  type TalkVoiceAttachmentReference,
} from '../talk/index.js';

export interface WebDavFileSourceOptions {
  baseUrl: string;
  userId: string;
  appPassword: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface RetrievedNextcloudFile {
  bytes: Buffer;
  etag: string;
  mediaType: TalkAttachmentMediaType;
  sizeBytes: number;
  sourceSha256: string;
}

export interface RetrievedNextcloudVoiceFile {
  bytes: Buffer;
  etag: string;
  mediaType: TalkVoiceAttachmentMediaType;
  sizeBytes: number;
  sourceSha256: string;
}

export type WebDavFileSourceErrorCode =
  | 'ambiguous-file'
  | 'download-failed'
  | 'file-not-found'
  | 'file-too-large'
  | 'invalid-reference'
  | 'media-type-mismatch'
  | 'metadata-mismatch'
  | 'search-failed'
  | 'unsafe-file-url';

export class WebDavFileSourceError extends Error {
  constructor(readonly code: WebDavFileSourceErrorCode) {
    super(`Nextcloud file retrieval failed: ${code}`);
    this.name = 'WebDavFileSourceError';
  }
}

interface SearchResult {
  href: URL;
  etag: string;
  mediaType: string;
  sizeBytes: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_SEARCH_RESPONSE_BYTES = 1_000_000;
const supportedMediaTypes: ReadonlySet<string> = new Set([
  ...talkAttachmentMediaTypes,
  ...talkVoiceAttachmentMediaTypes,
]);
const xmlPrefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_.-]*:)?`;

function requestTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('WebDAV request timeout must be a positive integer');
  }
  return timeoutMs;
}

function nextcloudOrigin(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('WebDAV base URL must be a credential-free HTTPS origin');
  }
  return parsed;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeXmlText(value: string): string {
  return value
    .replace(
      /&#(?:x([0-9a-fA-F]+)|([0-9]+));/g,
      (
        _match,
        hexadecimal: string | undefined,
        decimal: string | undefined,
      ) => {
        const codePoint = Number.parseInt(
          hexadecimal ?? decimal ?? '',
          hexadecimal === undefined ? 10 : 16,
        );
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint < 0 ||
          codePoint > 0x10ffff
        ) {
          throw new WebDavFileSourceError('search-failed');
        }
        return String.fromCodePoint(codePoint);
      },
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function elementText(xml: string, localName: string): string | undefined {
  const expression = new RegExp(
    `<${xmlPrefix}${localName}\\b[^>]*>([\\s\\S]*?)<\\/${xmlPrefix}${localName}\\s*>`,
    'i',
  );
  const match = expression.exec(xml);
  return match?.[1] === undefined ? undefined : decodeXmlText(match[1].trim());
}

function elementBlocks(xml: string, localName: string): string[] {
  const expression = new RegExp(
    `<${xmlPrefix}${localName}\\b[^>]*>([\\s\\S]*?)<\\/${xmlPrefix}${localName}\\s*>`,
    'gi',
  );
  return [...xml.matchAll(expression)]
    .map((match) => match[1])
    .filter((block): block is string => block !== undefined);
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  tooLargeCode: WebDavFileSourceErrorCode,
  readFailureCode: WebDavFileSourceErrorCode,
): Promise<Buffer> {
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const bytes = Buffer.from(chunk.value);
      size += bytes.length;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        bytes.fill(0);
        for (const buffered of chunks) {
          buffered.fill(0);
        }
        throw new WebDavFileSourceError(tooLargeCode);
      }
      chunks.push(bytes);
    }
  } catch (error) {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    if (error instanceof WebDavFileSourceError) {
      throw error;
    }
    throw new WebDavFileSourceError(readFailureCode);
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) {
    chunk.fill(0);
  }
  return result;
}

function canonicalInteger(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizedMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function normalizedEtag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function ifMatchHeader(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes('\r') ||
    trimmed.includes('\n') ||
    trimmed.startsWith('W/')
  ) {
    throw new WebDavFileSourceError('invalid-reference');
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed;
  }
  if (trimmed.includes('"')) {
    throw new WebDavFileSourceError('invalid-reference');
  }
  return `"${trimmed}"`;
}

function sniffMediaType(
  bytes: Buffer,
): TalkAttachmentMediaType | TalkVoiceAttachmentMediaType | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  if (
    (bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3') ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  ) {
    return 'audio/mpeg';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'audio/mp4';
  }
  return undefined;
}

function mediaTypeMatches(
  declared: TalkAttachmentMediaType | TalkVoiceAttachmentMediaType,
  sniffed: TalkAttachmentMediaType | TalkVoiceAttachmentMediaType | undefined,
): boolean {
  return (
    declared === sniffed ||
    (declared === 'audio/mpeg' && sniffed === 'audio/mp4')
  );
}

type SupportedTalkAttachmentReference =
  TalkAttachmentReference | TalkVoiceAttachmentReference;

function validateReference(reference: SupportedTalkAttachmentReference): void {
  if (
    !/^[1-9]\d{0,19}$/.test(reference.fileId) ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= 0 ||
    reference.sizeBytes > MAX_TALK_RECEIPT_ATTACHMENT_BYTES ||
    !supportedMediaTypes.has(reference.mediaType) ||
    reference.etag.length === 0 ||
    reference.etag.length > 256 ||
    reference.etag.includes('\r') ||
    reference.etag.includes('\n')
  ) {
    throw new WebDavFileSourceError(
      reference.sizeBytes > MAX_TALK_RECEIPT_ATTACHMENT_BYTES
        ? 'file-too-large'
        : 'invalid-reference',
    );
  }
  ifMatchHeader(reference.etag);
}

export class WebDavFileSource {
  readonly #baseUrl: URL;
  readonly #userId: string;
  readonly #authorization: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #fileRootPath: string;

  constructor(options: WebDavFileSourceOptions) {
    this.#baseUrl = nextcloudOrigin(options.baseUrl);
    this.#userId = options.userId;
    this.#authorization = `Basic ${Buffer.from(
      `${options.userId}:${options.appPassword}`,
    ).toString('base64')}`;
    this.#requestTimeoutMs = requestTimeoutMs(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#fileRootPath = `/remote.php/dav/files/${encodeURIComponent(
      this.#userId,
    )}/`;
  }

  async retrieve(
    reference: TalkAttachmentReference,
    signal?: AbortSignal,
  ): Promise<RetrievedNextcloudFile> {
    return (await this.#retrieve(reference, signal)) as RetrievedNextcloudFile;
  }

  async retrieveVoice(
    reference: TalkVoiceAttachmentReference,
    signal?: AbortSignal,
  ): Promise<RetrievedNextcloudVoiceFile> {
    return (await this.#retrieve(
      reference,
      signal,
    )) as RetrievedNextcloudVoiceFile;
  }

  async #retrieve(
    reference: SupportedTalkAttachmentReference,
    signal?: AbortSignal,
  ): Promise<RetrievedNextcloudFile | RetrievedNextcloudVoiceFile> {
    validateReference(reference);
    const searchResult = await this.#search(reference, signal);
    if (
      normalizedEtag(searchResult.etag) !== normalizedEtag(reference.etag) ||
      searchResult.sizeBytes !== reference.sizeBytes ||
      normalizedMediaType(searchResult.mediaType) !== reference.mediaType
    ) {
      throw new WebDavFileSourceError('metadata-mismatch');
    }

    const response = await this.#request(
      searchResult.href,
      {
        method: 'GET',
        headers: {
          accept: reference.mediaType,
          authorization: this.#authorization,
          'if-match': ifMatchHeader(searchResult.etag),
        },
      },
      'download-failed',
      signal,
    );
    if (response.status !== 200) {
      throw new WebDavFileSourceError('download-failed');
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const parsedLength = canonicalInteger(contentLength);
      if (
        parsedLength === undefined ||
        parsedLength !== reference.sizeBytes ||
        parsedLength > MAX_TALK_RECEIPT_ATTACHMENT_BYTES
      ) {
        throw new WebDavFileSourceError(
          parsedLength !== undefined &&
            parsedLength > MAX_TALK_RECEIPT_ATTACHMENT_BYTES
            ? 'file-too-large'
            : 'metadata-mismatch',
        );
      }
    }
    const responseMediaType = response.headers.get('content-type');
    if (
      responseMediaType !== null &&
      normalizedMediaType(responseMediaType) !== reference.mediaType
    ) {
      throw new WebDavFileSourceError('media-type-mismatch');
    }

    const bytes = await readResponseBytes(
      response,
      MAX_TALK_RECEIPT_ATTACHMENT_BYTES,
      'file-too-large',
      'download-failed',
    );
    if (bytes.length !== reference.sizeBytes) {
      bytes.fill(0);
      throw new WebDavFileSourceError('metadata-mismatch');
    }
    const sniffedMediaType = sniffMediaType(bytes);
    if (!mediaTypeMatches(reference.mediaType, sniffedMediaType)) {
      bytes.fill(0);
      throw new WebDavFileSourceError('media-type-mismatch');
    }

    return {
      bytes,
      etag: reference.etag,
      mediaType: sniffedMediaType!,
      sizeBytes: bytes.length,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async #search(
    reference: SupportedTalkAttachmentReference,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    const scope = `/files/${encodeURIComponent(this.#userId)}`;
    const searchBody = `<?xml version="1.0" encoding="UTF-8"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:basicsearch>
    <d:select>
      <d:prop>
        <d:getcontenttype/>
        <d:getetag/>
        <oc:fileid/>
        <oc:size/>
      </d:prop>
    </d:select>
    <d:from>
      <d:scope>
        <d:href>${xmlEscape(scope)}</d:href>
        <d:depth>infinity</d:depth>
      </d:scope>
    </d:from>
    <d:where>
      <d:eq>
        <d:prop><oc:fileid/></d:prop>
        <d:literal>${reference.fileId}</d:literal>
      </d:eq>
    </d:where>
    <d:orderby/>
  </d:basicsearch>
</d:searchrequest>`;
    const response = await this.#request(
      new URL('/remote.php/dav/', this.#baseUrl),
      {
        method: 'SEARCH',
        headers: {
          accept: 'application/xml',
          authorization: this.#authorization,
          'content-type': 'application/xml; charset=utf-8',
        },
        body: searchBody,
      },
      'search-failed',
      signal,
    );
    if (response.status !== 207) {
      throw new WebDavFileSourceError('search-failed');
    }
    const responseBytes = await readResponseBytes(
      response,
      MAX_SEARCH_RESPONSE_BYTES,
      'search-failed',
      'search-failed',
    );
    let xml: string;
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
    } catch {
      throw new WebDavFileSourceError('search-failed');
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new WebDavFileSourceError('search-failed');
    }

    const matches = elementBlocks(xml, 'response').flatMap(
      (block): SearchResult[] => {
        const successfulProperties = elementBlocks(block, 'propstat')
          .filter((propstat) => /HTTP\/\d(?:\.\d)?\s+200\b/i.test(propstat))
          .join('');
        if (successfulProperties.length === 0) {
          return [];
        }
        const href = elementText(block, 'href');
        const fileId = elementText(successfulProperties, 'fileid');
        const etag = elementText(successfulProperties, 'getetag');
        const mediaType = elementText(successfulProperties, 'getcontenttype');
        const size = elementText(successfulProperties, 'size');
        const sizeBytes =
          size === undefined ? undefined : canonicalInteger(size);
        if (
          href === undefined ||
          fileId !== reference.fileId ||
          etag === undefined ||
          mediaType === undefined ||
          sizeBytes === undefined
        ) {
          throw new WebDavFileSourceError('search-failed');
        }
        return [
          {
            href: this.#safeFileUrl(href),
            etag,
            mediaType,
            sizeBytes,
          },
        ];
      },
    );

    if (matches.length === 0) {
      throw new WebDavFileSourceError('file-not-found');
    }
    if (matches.length !== 1) {
      throw new WebDavFileSourceError('ambiguous-file');
    }
    const match = matches[0];
    if (match === undefined) {
      throw new WebDavFileSourceError('ambiguous-file');
    }
    return match;
  }

  #safeFileUrl(href: string): URL {
    let url: URL;
    try {
      url = new URL(href, this.#baseUrl);
    } catch {
      throw new WebDavFileSourceError('unsafe-file-url');
    }
    if (
      url.origin !== this.#baseUrl.origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.startsWith(this.#fileRootPath)
    ) {
      throw new WebDavFileSourceError('unsafe-file-url');
    }
    try {
      for (const rawSegment of url.pathname.split('/')) {
        let segment = rawSegment;
        for (let decodingDepth = 0; decodingDepth < 5; decodingDepth += 1) {
          const decoded = decodeURIComponent(segment);
          if (
            decoded === '.' ||
            decoded === '..' ||
            decoded.includes('/') ||
            decoded.includes('\\') ||
            decoded.includes('\0')
          ) {
            throw new WebDavFileSourceError('unsafe-file-url');
          }
          if (decoded === segment || !/%[0-9a-fA-F]{2}/.test(decoded)) {
            break;
          }
          if (decodingDepth === 4) {
            throw new WebDavFileSourceError('unsafe-file-url');
          }
          segment = decoded;
        }
      }
    } catch (error) {
      if (error instanceof WebDavFileSourceError) {
        throw error;
      }
      throw new WebDavFileSourceError('unsafe-file-url');
    }
    return url;
  }

  async #request(
    url: URL,
    init: RequestInit,
    failureCode: WebDavFileSourceErrorCode,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal =
      externalSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([externalSignal, timeoutSignal]);
    try {
      return await this.#fetch(url, {
        ...init,
        redirect: 'error',
        signal: requestSignal,
      });
    } catch {
      throw new WebDavFileSourceError(failureCode);
    }
  }
}
