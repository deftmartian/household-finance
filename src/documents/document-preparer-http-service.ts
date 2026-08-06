import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import {
  DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
  MAX_DOCUMENT_PREPARER_SOURCE_BYTES,
  isReceiptDocumentMediaType,
  serializePreparedReceiptDocument,
  sha256,
  sniffReceiptDocumentMediaType,
} from './document-preparer-protocol.js';
import {
  ReceiptDocumentPreparationError,
  type ReceiptDocumentPreparationErrorCode,
} from './document-preparation-error.js';
import {
  ReceiptDocumentPreparer,
  type ReceiptDocumentSource,
} from './receipt-document-preparer.js';
import type { PreparedReceiptDocument } from '../model/index.js';

const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 16 * 1024;

export interface DocumentPreparer {
  prepare(source: ReceiptDocumentSource): Promise<PreparedReceiptDocument>;
}

export type DocumentPreparerServiceReportCode =
  | 'body_length_mismatch'
  | 'busy'
  | 'internal_error'
  | 'invalid_request'
  | 'media_type_mismatch'
  | 'payload_too_large'
  | 'source_hash_mismatch'
  | 'unsupported_media_type'
  | `preparation_${ReceiptDocumentPreparationErrorCode}`;

export interface DocumentPreparerHttpServiceOptions {
  preparer?: DocumentPreparer;
  reportError?: (code: DocumentPreparerServiceReportCode) => void;
}

class ServiceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: Exclude<
      DocumentPreparerServiceReportCode,
      `preparation_${ReceiptDocumentPreparationErrorCode}`
    >,
  ) {
    super(`Document preparation request failed: ${code}`);
    this.name = 'ServiceRequestError';
  }
}

function responsePayload(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf8');
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = responsePayload(body);
  response.shouldKeepAlive = false;
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-length': String(payload.byteLength),
    'content-type': DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
    'x-content-type-options': 'nosniff',
  });
  const wipe = (): void => {
    payload.fill(0);
  };
  response.once('close', wipe);
  response.end(payload, wipe);
}

function exactHeader(
  request: IncomingMessage,
  name: 'content-length' | 'content-type' | 'x-source-sha256',
): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function requestMetadata(request: IncomingMessage): {
  contentLength: number;
  mediaType: ReceiptDocumentSource['mediaType'];
  sourceSha256: string;
} {
  if (
    request.headers['transfer-encoding'] !== undefined ||
    request.headers['content-encoding'] !== undefined
  ) {
    throw new ServiceRequestError(400, 'invalid_request');
  }

  const rawContentLength = exactHeader(request, 'content-length');
  if (rawContentLength === undefined || !/^[1-9]\d*$/.test(rawContentLength)) {
    throw new ServiceRequestError(400, 'invalid_request');
  }
  const contentLength = Number(rawContentLength);
  if (!Number.isSafeInteger(contentLength)) {
    throw new ServiceRequestError(400, 'invalid_request');
  }
  if (contentLength > MAX_DOCUMENT_PREPARER_SOURCE_BYTES) {
    throw new ServiceRequestError(413, 'payload_too_large');
  }

  const mediaType = exactHeader(request, 'content-type');
  if (!isReceiptDocumentMediaType(mediaType)) {
    throw new ServiceRequestError(415, 'unsupported_media_type');
  }
  const sourceSha256 = exactHeader(request, 'x-source-sha256');
  if (sourceSha256 === undefined || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new ServiceRequestError(400, 'invalid_request');
  }
  return { contentLength, mediaType, sourceSha256 };
}

async function readExactBody(
  request: IncomingMessage,
  expectedLength: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (
        length > expectedLength ||
        length > MAX_DOCUMENT_PREPARER_SOURCE_BYTES
      ) {
        for (const buffered of chunks) {
          buffered.fill(0);
        }
        bytes.fill(0);
        throw new ServiceRequestError(400, 'body_length_mismatch');
      }
      chunks.push(bytes);
    }
  } catch (error) {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    if (error instanceof ServiceRequestError) {
      throw error;
    }
    throw new ServiceRequestError(400, 'body_length_mismatch');
  }
  if (length !== expectedLength) {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    throw new ServiceRequestError(400, 'body_length_mismatch');
  }
  const body = Buffer.concat(chunks, length);
  for (const chunk of chunks) {
    chunk.fill(0);
  }
  return body;
}

function wipePrepared(document: PreparedReceiptDocument | undefined): void {
  if (document === undefined) {
    return;
  }
  for (const page of document.pages) {
    page.bytes.fill(0);
  }
}

export function createDocumentPreparerHttpServer(
  options: DocumentPreparerHttpServiceOptions = {},
): Server {
  const preparer = options.preparer ?? new ReceiptDocumentPreparer();
  const reportError = options.reportError ?? (() => undefined);
  const report = (code: DocumentPreparerServiceReportCode): void => {
    try {
      reportError(code);
    } catch {
      // Reporting is best-effort and receives only fixed safe codes.
    }
  };
  let preparing = false;

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === 'GET' && request.url === '/health/live') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health/ready') {
      sendJson(response, 200, { status: 'ready' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/prepare') {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    let metadata: ReturnType<typeof requestMetadata>;
    try {
      metadata = requestMetadata(request);
    } catch (error) {
      if (error instanceof ServiceRequestError) {
        report(error.code);
        request.resume();
        sendJson(response, error.status, { error: error.code });
        return;
      }
      report('internal_error');
      request.resume();
      sendJson(response, 500, { error: 'internal_error' });
      return;
    }

    if (preparing) {
      report('busy');
      request.resume();
      sendJson(response, 503, { error: 'busy' });
      return;
    }
    preparing = true;

    let body: Buffer | undefined;
    let prepared: PreparedReceiptDocument | undefined;
    try {
      body = await readExactBody(request, metadata.contentLength);
      if (sha256(body) !== metadata.sourceSha256) {
        throw new ServiceRequestError(422, 'source_hash_mismatch');
      }
      if (sniffReceiptDocumentMediaType(body) !== metadata.mediaType) {
        throw new ServiceRequestError(415, 'media_type_mismatch');
      }

      try {
        prepared = await preparer.prepare({
          bytes: body,
          mediaType: metadata.mediaType,
          sourceSha256: metadata.sourceSha256,
        });
      } catch (error) {
        if (error instanceof ReceiptDocumentPreparationError) {
          report(`preparation_${error.code}`);
          sendJson(response, 422, {
            error: 'preparation_failed',
            code: error.code,
          });
          return;
        }
        throw error;
      }

      if (prepared.sourceSha256 !== metadata.sourceSha256) {
        throw new ServiceRequestError(500, 'internal_error');
      }
      const payload = serializePreparedReceiptDocument(prepared);
      response.shouldKeepAlive = false;
      response.writeHead(200, {
        'cache-control': 'no-store',
        connection: 'close',
        'content-length': String(payload.byteLength),
        'content-type': DOCUMENT_PREPARER_JSON_CONTENT_TYPE,
        'x-content-type-options': 'nosniff',
      });
      const wipe = (): void => {
        payload.fill(0);
      };
      response.once('close', wipe);
      response.end(payload, wipe);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ServiceRequestError) {
        report(error.code);
        sendJson(response, error.status, { error: error.code });
        return;
      }
      report('internal_error');
      sendJson(response, 500, { error: 'internal_error' });
    } finally {
      body?.fill(0);
      wipePrepared(prepared);
      preparing = false;
    }
  };

  const server = createServer(
    {
      headersTimeout: HEADERS_TIMEOUT_MS,
      maxHeaderSize: MAX_HEADER_BYTES,
      requestTimeout: REQUEST_TIMEOUT_MS,
    },
    (request, response) => {
      void handle(request, response).catch(() => {
        report('internal_error');
        if (response.headersSent) {
          response.destroy();
        } else {
          sendJson(response, 500, { error: 'internal_error' });
        }
      });
    },
  );
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1_000;
  server.on('checkContinue', (request, response) => {
    void handle(request, response).catch(() => {
      report('internal_error');
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { error: 'internal_error' });
      }
    });
  });
  server.on('clientError', (_error, socket) => {
    report('invalid_request');
    if (socket.writable) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    }
  });
  return server;
}

export interface DocumentPreparerServiceConfig {
  host: string;
  port: number;
}

function hasUnsafeHostCharacter(host: string): boolean {
  return Array.from(host).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x20 || character === '/' || character === '\\';
  });
}

export function parseDocumentPreparerServiceConfig(
  environment: NodeJS.ProcessEnv,
): DocumentPreparerServiceConfig {
  const host = environment.HOST ?? '0.0.0.0';
  const rawPort = environment.PORT ?? '4390';
  const port = Number(rawPort);
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.trim() !== host ||
    hasUnsafeHostCharacter(host) ||
    !/^[1-9]\d{0,4}$/.test(rawPort) ||
    !Number.isSafeInteger(port) ||
    port > 65_535
  ) {
    throw new Error('Document preparer service configuration is invalid');
  }
  return { host, port };
}
