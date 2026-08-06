import {
  MAX_DOCUMENT_PREPARER_RESPONSE_BYTES,
  MAX_DOCUMENT_PREPARER_SOURCE_BYTES,
  DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
  isReceiptDocumentMediaType,
  parseTransportedReceiptDocument,
  sha256,
  sniffReceiptDocumentMediaType,
} from './document-preparer-protocol.js';
import {
  ReceiptDocumentPreparationError,
  type ReceiptDocumentPreparationErrorCode,
} from './document-preparation-error.js';
import type { ReceiptDocumentSource } from './receipt-document-preparer.js';
import type { PreparedReceiptDocument } from '../model/index.js';

const DEFAULT_ENDPOINT = 'http://document-preparer:4390';
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const MAX_ERROR_RESPONSE_BYTES = 4_096;
const serviceName = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const canonicalPort = /^[1-9]\d{0,4}$/;
const preparationErrorCodes: ReadonlySet<string> = new Set([
  'image-invalid',
  'image-limits-exceeded',
  'pdf-invalid',
  'pdf-encrypted',
  'pdf-limits-exceeded',
  'pdf-rasterization-failed',
  'prepared-document-invalid',
] satisfies readonly ReceiptDocumentPreparationErrorCode[]);

export type RemoteReceiptDocumentPreparationErrorCode =
  | 'invalid-response'
  | 'network-error'
  | 'request-aborted'
  | 'request-timeout'
  | 'service-unavailable';

export class RemoteReceiptDocumentPreparationError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: RemoteReceiptDocumentPreparationErrorCode) {
    super(`Remote receipt document preparation failed: ${code}`);
    this.name = 'RemoteReceiptDocumentPreparationError';
    this.retryable =
      code === 'network-error' ||
      code === 'request-aborted' ||
      code === 'request-timeout' ||
      code === 'service-unavailable';
  }
}

export interface RemoteReceiptDocumentPreparerOptions {
  endpoint?: string;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

function parseEndpoint(
  value: string | undefined,
  hasInjectedTransport: boolean,
): string {
  const configured = value ?? DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('Document preparer endpoint is invalid');
  }
  const port = parsed.port;
  const numericPort = Number(port);
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !canonicalPort.test(port) ||
    !Number.isSafeInteger(numericPort) ||
    numericPort > 65_535
  ) {
    throw new Error(
      'Document preparer endpoint must be a credential-free internal HTTP service origin',
    );
  }
  const normalized = `http://${parsed.hostname}:${port}`;
  if (!hasInjectedTransport && normalized !== DEFAULT_ENDPOINT) {
    throw new Error(
      'Document preparer endpoint must be the pinned internal service origin',
    );
  }
  if (
    !hasInjectedTransport &&
    (!serviceName.test(parsed.hostname) || parsed.hostname === 'localhost')
  ) {
    throw new Error(
      'Document preparer endpoint must be the pinned internal service origin',
    );
  }
  return normalized;
}

function parseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 240_000) {
    throw new Error(
      'Document preparer timeout must be a bounded positive integer',
    );
  }
  return timeout;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and must not replace the fixed safe error.
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (response.headers.get('content-encoding') !== null) {
    await cancelResponse(response);
    throw new RemoteReceiptDocumentPreparationError('invalid-response');
  }

  const declaredLength = response.headers.get('content-length');
  let expectedLength: number | undefined;
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) {
      await cancelResponse(response);
      throw new RemoteReceiptDocumentPreparationError('invalid-response');
    }
    expectedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(expectedLength) ||
      expectedLength > maximumBytes
    ) {
      await cancelResponse(response);
      throw new RemoteReceiptDocumentPreparationError('invalid-response');
    }
  }

  if (response.body === null) {
    if (expectedLength !== undefined && expectedLength !== 0) {
      throw new RemoteReceiptDocumentPreparationError('invalid-response');
    }
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
      size += bytes.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        bytes.fill(0);
        for (const chunk of chunks) {
          chunk.fill(0);
        }
        throw new RemoteReceiptDocumentPreparationError('invalid-response');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    if (error instanceof RemoteReceiptDocumentPreparationError) {
      throw error;
    }
    throw new RemoteReceiptDocumentPreparationError('network-error');
  }
  if (expectedLength !== undefined && expectedLength !== size) {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    throw new RemoteReceiptDocumentPreparationError('invalid-response');
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) {
    chunk.fill(0);
  }
  return result;
}

function receiptPreparationError(
  code: unknown,
): ReceiptDocumentPreparationError | undefined {
  return typeof code === 'string' && preparationErrorCodes.has(code)
    ? new ReceiptDocumentPreparationError(
        code as ReceiptDocumentPreparationErrorCode,
      )
    : undefined;
}

function sourceLimitError(
  mediaType: ReceiptDocumentSource['mediaType'],
): ReceiptDocumentPreparationError {
  return new ReceiptDocumentPreparationError(
    mediaType === 'application/pdf'
      ? 'pdf-limits-exceeded'
      : 'image-limits-exceeded',
  );
}

function validateSource(source: ReceiptDocumentSource, bytes: Buffer): void {
  if (!isReceiptDocumentMediaType(source.mediaType)) {
    throw new ReceiptDocumentPreparationError('prepared-document-invalid');
  }
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_DOCUMENT_PREPARER_SOURCE_BYTES
  ) {
    throw sourceLimitError(source.mediaType);
  }
  if (
    !/^[a-f0-9]{64}$/.test(source.sourceSha256) ||
    sha256(bytes) !== source.sourceSha256
  ) {
    throw new ReceiptDocumentPreparationError('prepared-document-invalid');
  }
  if (sniffReceiptDocumentMediaType(bytes) !== source.mediaType) {
    throw new ReceiptDocumentPreparationError(
      source.mediaType === 'application/pdf' ? 'pdf-invalid' : 'image-invalid',
    );
  }
}

export class RemoteReceiptDocumentPreparer {
  readonly #endpoint: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: RemoteReceiptDocumentPreparerOptions = {}) {
    this.#endpoint = parseEndpoint(
      options.endpoint,
      options.fetchImplementation !== undefined,
    );
    this.#requestTimeoutMs = parseTimeout(options.requestTimeoutMs);
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async prepare(
    source: ReceiptDocumentSource,
    signal?: AbortSignal,
  ): Promise<PreparedReceiptDocument> {
    let bytes: Buffer;
    try {
      if (!(source.bytes instanceof Uint8Array)) {
        throw new ReceiptDocumentPreparationError('prepared-document-invalid');
      }
      bytes = Buffer.from(source.bytes);
    } catch (error) {
      if (error instanceof ReceiptDocumentPreparationError) {
        throw error;
      }
      throw new ReceiptDocumentPreparationError('prepared-document-invalid');
    }
    try {
      validateSource(source, bytes);
    } catch (error) {
      bytes.fill(0);
      throw error;
    }

    if (isAborted(signal)) {
      bytes.fill(0);
      throw new RemoteReceiptDocumentPreparationError('request-aborted');
    }
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const requestSignal =
      signal === undefined
        ? timeoutSignal
        : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#endpoint}/prepare`, {
        method: 'POST',
        redirect: 'error',
        signal: requestSignal,
        headers: {
          accept: DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
          'content-length': String(bytes.byteLength),
          'content-type': source.mediaType,
          'x-source-sha256': source.sourceSha256,
        },
        body: bytes,
      });
    } catch {
      bytes.fill(0);
      throw new RemoteReceiptDocumentPreparationError(
        isAborted(signal)
          ? 'request-aborted'
          : timeoutSignal.aborted
            ? 'request-timeout'
            : 'network-error',
      );
    }

    try {
      if (response.status !== 200) {
        if (response.status === 503) {
          await cancelResponse(response);
          throw new RemoteReceiptDocumentPreparationError(
            'service-unavailable',
          );
        }
        const errorBytes = await readBoundedResponse(
          response,
          MAX_ERROR_RESPONSE_BYTES,
        );
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(
            errorBytes,
          );
          const parsed: unknown = JSON.parse(text);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            Object.keys(parsed).every(
              (key) => key === 'error' || key === 'code',
            ) &&
            'code' in parsed
          ) {
            const preparationError = receiptPreparationError(parsed.code);
            if (preparationError !== undefined) {
              throw preparationError;
            }
          }
        } catch (error) {
          if (error instanceof ReceiptDocumentPreparationError) {
            throw error;
          }
        } finally {
          errorBytes.fill(0);
        }
        if (response.status >= 500) {
          throw new RemoteReceiptDocumentPreparationError(
            'service-unavailable',
          );
        }
        throw new ReceiptDocumentPreparationError(
          response.status === 413
            ? source.mediaType === 'application/pdf'
              ? 'pdf-limits-exceeded'
              : 'image-limits-exceeded'
            : 'prepared-document-invalid',
        );
      }

      if (
        response.headers.get('content-type') !==
        DOCUMENT_PREPARER_JSON_CONTENT_TYPE
      ) {
        await cancelResponse(response);
        throw new RemoteReceiptDocumentPreparationError('invalid-response');
      }
      const responseBytes = await readBoundedResponse(
        response,
        MAX_DOCUMENT_PREPARER_RESPONSE_BYTES,
      );
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          responseBytes,
        );
        const parsedJson: unknown = JSON.parse(text);
        const prepared = parseTransportedReceiptDocument(parsedJson);
        if (prepared.sourceSha256 !== source.sourceSha256) {
          for (const page of prepared.pages) {
            page.bytes.fill(0);
          }
          throw new RemoteReceiptDocumentPreparationError('invalid-response');
        }
        return prepared;
      } catch (error) {
        if (error instanceof RemoteReceiptDocumentPreparationError) {
          throw error;
        }
        throw new RemoteReceiptDocumentPreparationError('invalid-response');
      } finally {
        responseBytes.fill(0);
      }
    } catch (error) {
      if (error instanceof RemoteReceiptDocumentPreparationError) {
        if (error.code === 'network-error') {
          if (isAborted(signal)) {
            throw new RemoteReceiptDocumentPreparationError('request-aborted');
          }
          if (timeoutSignal.aborted) {
            throw new RemoteReceiptDocumentPreparationError('request-timeout');
          }
        }
        throw error;
      }
      if (error instanceof ReceiptDocumentPreparationError) {
        throw error;
      }
      throw new RemoteReceiptDocumentPreparationError('invalid-response');
    } finally {
      bytes.fill(0);
    }
  }
}
