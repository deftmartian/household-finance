import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';

import {
  ReceiptDocumentPreparationError,
  type ReceiptDocumentPreparationErrorCode,
} from './document-preparation-error.js';
import {
  MAX_PREPARED_RECEIPT_PAGE_BYTES,
  MAX_PREPARED_RECEIPT_PAGES,
  MAX_PREPARED_RECEIPT_TOTAL_BYTES,
  parsePreparedReceiptDocument,
  type PreparedReceiptDocument,
} from '../model/index.js';

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;

const MAX_SOURCE_IMAGE_EDGE = 16_384;
const MAX_SOURCE_IMAGE_PIXELS = 64_000_000;
const MAX_EVALUATION_SOURCE_PAGES = 100;
const NORMALIZED_LONG_EDGE = 2_048;
const POPPLER_TIMEOUT_MS = 60_000;
const POPPLER_MAX_OUTPUT_BYTES = 1_000_000;

const executeFile = promisify(execFile);

export interface PdfRasterizer {
  rasterize(pdfBytes: Uint8Array): Promise<readonly Uint8Array[]>;
}

export interface SelectedPdfPageRasterizer {
  rasterizeSelected(
    pdfBytes: Uint8Array,
    oneBasedPages: readonly number[],
  ): Promise<readonly Uint8Array[]>;
}

export interface ReceiptDocumentSource {
  bytes: Uint8Array;
  mediaType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sourceSha256: string;
}

function safePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function pdfInfoValue(output: string, name: string): string | undefined {
  const expression = new RegExp(`^${name}:\\s*(.*?)\\s*$`, 'im');
  return expression.exec(output)?.[1];
}

function numericPageFilename(
  filename: string,
): { filename: string; page: number } | undefined {
  const match = /^page-(\d+)\.jpg$/.exec(filename);
  const page = safePositiveInteger(match?.[1]);
  return page === undefined ? undefined : { filename, page };
}

function validSelectedPages(oneBasedPages: readonly number[]): boolean {
  return (
    oneBasedPages.length > 0 &&
    oneBasedPages.length <= MAX_PREPARED_RECEIPT_PAGES &&
    oneBasedPages.every(
      (page, index) =>
        Number.isSafeInteger(page) &&
        page >= 1 &&
        page <= MAX_EVALUATION_SOURCE_PAGES &&
        (index === 0 || page > oneBasedPages[index - 1]!),
    )
  );
}

/**
 * Poppler is invoked only against a private 0700 temporary directory. Its
 * stdout and stderr are never surfaced because PDF metadata can itself be
 * private.
 */
export class PopplerPdfRasterizer implements PdfRasterizer {
  async rasterize(pdfBytes: Uint8Array): Promise<readonly Uint8Array[]> {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'finance-receipt-'),
    );
    const inputPath = join(temporaryDirectory, 'source.pdf');
    const outputPrefix = join(temporaryDirectory, 'page');

    try {
      await writeFile(inputPath, pdfBytes, { mode: 0o600 });

      let info: string;
      try {
        const result = await executeFile('pdfinfo', [inputPath], {
          encoding: 'utf8',
          maxBuffer: POPPLER_MAX_OUTPUT_BYTES,
          timeout: POPPLER_TIMEOUT_MS,
        });
        info = result.stdout;
      } catch {
        throw new ReceiptDocumentPreparationError('pdf-invalid');
      }

      const encrypted = pdfInfoValue(info, 'Encrypted');
      if (encrypted?.toLowerCase() === 'yes') {
        throw new ReceiptDocumentPreparationError('pdf-encrypted');
      }
      if (encrypted?.toLowerCase() !== 'no') {
        throw new ReceiptDocumentPreparationError('pdf-invalid');
      }

      const pageCount = safePositiveInteger(pdfInfoValue(info, 'Pages'));
      if (pageCount === undefined) {
        throw new ReceiptDocumentPreparationError('pdf-invalid');
      }
      if (pageCount > MAX_PREPARED_RECEIPT_PAGES) {
        throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
      }

      try {
        await executeFile(
          'pdftoppm',
          [
            '-f',
            '1',
            '-l',
            String(pageCount),
            '-jpeg',
            '-r',
            '150',
            '-scale-to',
            String(NORMALIZED_LONG_EDGE),
            '-jpegopt',
            'quality=90,progressive=y,optimize=y',
            inputPath,
            outputPrefix,
          ],
          {
            encoding: 'utf8',
            maxBuffer: POPPLER_MAX_OUTPUT_BYTES,
            timeout: POPPLER_TIMEOUT_MS,
          },
        );
      } catch {
        throw new ReceiptDocumentPreparationError('pdf-rasterization-failed');
      }

      const pageFiles = (await readdir(temporaryDirectory))
        .map(numericPageFilename)
        .filter(
          (
            page,
          ): page is {
            filename: string;
            page: number;
          } => page !== undefined,
        )
        .sort((left, right) => left.page - right.page);
      if (
        pageFiles.length !== pageCount ||
        pageFiles.some((page, index) => page.page !== index + 1)
      ) {
        throw new ReceiptDocumentPreparationError('pdf-rasterization-failed');
      }

      const pages: Uint8Array[] = [];
      let totalBytes = 0;
      for (const page of pageFiles) {
        const path = join(temporaryDirectory, page.filename);
        const metadata = await lstat(path);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.size <= 0 ||
          metadata.size > MAX_PREPARED_RECEIPT_PAGE_BYTES
        ) {
          throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
        }
        totalBytes += metadata.size;
        if (totalBytes > MAX_PREPARED_RECEIPT_TOTAL_BYTES) {
          throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
        }
        pages.push(await readFile(path));
      }
      return pages;
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }
}

/**
 * Rasterizes only the explicitly selected, one-based PDF pages. This keeps
 * unrelated pages in a larger private document out of model input.
 */
export class PopplerSelectedPdfPageRasterizer implements SelectedPdfPageRasterizer {
  async rasterizeSelected(
    pdfBytes: Uint8Array,
    oneBasedPages: readonly number[],
  ): Promise<readonly Uint8Array[]> {
    if (!validSelectedPages(oneBasedPages)) {
      throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
    }

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'finance-receipt-selected-'),
    );
    const inputPath = join(temporaryDirectory, 'source.pdf');

    try {
      await writeFile(inputPath, pdfBytes, { mode: 0o600 });

      let info: string;
      try {
        const result = await executeFile('pdfinfo', [inputPath], {
          encoding: 'utf8',
          maxBuffer: POPPLER_MAX_OUTPUT_BYTES,
          timeout: POPPLER_TIMEOUT_MS,
        });
        info = result.stdout;
      } catch {
        throw new ReceiptDocumentPreparationError('pdf-invalid');
      }

      const encrypted = pdfInfoValue(info, 'Encrypted');
      if (encrypted?.toLowerCase() === 'yes') {
        throw new ReceiptDocumentPreparationError('pdf-encrypted');
      }
      if (encrypted?.toLowerCase() !== 'no') {
        throw new ReceiptDocumentPreparationError('pdf-invalid');
      }

      const pageCount = safePositiveInteger(pdfInfoValue(info, 'Pages'));
      if (
        pageCount === undefined ||
        pageCount > MAX_EVALUATION_SOURCE_PAGES ||
        oneBasedPages.some((page) => page > pageCount)
      ) {
        throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
      }

      const pages: Uint8Array[] = [];
      let totalBytes = 0;
      for (const [position, sourcePage] of oneBasedPages.entries()) {
        const outputPrefix = join(
          temporaryDirectory,
          `selected-${String(position)}`,
        );
        try {
          await executeFile(
            'pdftoppm',
            [
              '-f',
              String(sourcePage),
              '-l',
              String(sourcePage),
              '-singlefile',
              '-jpeg',
              '-r',
              '150',
              '-scale-to',
              String(NORMALIZED_LONG_EDGE),
              '-jpegopt',
              'quality=90,progressive=y,optimize=y',
              inputPath,
              outputPrefix,
            ],
            {
              encoding: 'utf8',
              maxBuffer: POPPLER_MAX_OUTPUT_BYTES,
              timeout: POPPLER_TIMEOUT_MS,
            },
          );
        } catch {
          throw new ReceiptDocumentPreparationError('pdf-rasterization-failed');
        }

        const outputPath = `${outputPrefix}.jpg`;
        const metadata = await lstat(outputPath).catch(() => undefined);
        if (
          metadata === undefined ||
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.size <= 0 ||
          metadata.size > MAX_PREPARED_RECEIPT_PAGE_BYTES
        ) {
          throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
        }
        totalBytes += metadata.size;
        if (totalBytes > MAX_PREPARED_RECEIPT_TOTAL_BYTES) {
          throw new ReceiptDocumentPreparationError('pdf-limits-exceeded');
        }
        pages.push(await readFile(outputPath));
      }
      return pages;
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }
}

async function normalizeImage(sourceBytes: Uint8Array): Promise<Buffer> {
  const input = Buffer.from(
    sourceBytes.buffer,
    sourceBytes.byteOffset,
    sourceBytes.byteLength,
  );

  let metadata: SharpMetadata;
  try {
    metadata = await sharp(input, {
      failOn: 'warning',
      limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
      pages: 1,
      sequentialRead: true,
    }).metadata();
  } catch {
    throw new ReceiptDocumentPreparationError('image-invalid');
  }

  const width = metadata.width;
  const height = metadata.height;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_SOURCE_IMAGE_EDGE ||
    height > MAX_SOURCE_IMAGE_EDGE ||
    width * height > MAX_SOURCE_IMAGE_PIXELS ||
    (metadata.pages ?? 1) !== 1
  ) {
    throw new ReceiptDocumentPreparationError('image-limits-exceeded');
  }

  try {
    const normalized = await sharp(input, {
      failOn: 'warning',
      limitInputPixels: MAX_SOURCE_IMAGE_PIXELS,
      pages: 1,
      sequentialRead: true,
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .resize({
        width: NORMALIZED_LONG_EDGE,
        height: NORMALIZED_LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        chromaSubsampling: '4:4:4',
        progressive: true,
        quality: 90,
      })
      .toBuffer();

    if (
      normalized.length === 0 ||
      normalized.length > MAX_PREPARED_RECEIPT_PAGE_BYTES
    ) {
      throw new ReceiptDocumentPreparationError('image-limits-exceeded');
    }
    return normalized;
  } catch (error) {
    if (error instanceof ReceiptDocumentPreparationError) {
      throw error;
    }
    throw new ReceiptDocumentPreparationError('image-invalid');
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function prepareNormalizedPages(
  sourceSha256: string,
  rawPages: readonly Uint8Array[],
  limitError: ReceiptDocumentPreparationErrorCode,
): Promise<PreparedReceiptDocument> {
  if (rawPages.length === 0 || rawPages.length > MAX_PREPARED_RECEIPT_PAGES) {
    throw new ReceiptDocumentPreparationError(limitError);
  }

  const pages: Array<{
    position: number;
    mediaType: 'image/jpeg';
    sha256: string;
    bytes: Buffer;
  }> = [];
  try {
    let totalBytes = 0;
    for (const [position, page] of rawPages.entries()) {
      const normalized = await normalizeImage(page);
      totalBytes += normalized.length;
      if (totalBytes > MAX_PREPARED_RECEIPT_TOTAL_BYTES) {
        normalized.fill(0);
        throw new ReceiptDocumentPreparationError('prepared-document-invalid');
      }
      pages.push({
        position,
        mediaType: 'image/jpeg',
        sha256: sha256(normalized),
        bytes: normalized,
      });
    }

    try {
      return parsePreparedReceiptDocument({
        schemaVersion: 'prepared-receipt-document.v1',
        sourceSha256,
        pages,
      });
    } catch {
      throw new ReceiptDocumentPreparationError('prepared-document-invalid');
    }
  } catch (error) {
    pages.forEach((page) => page.bytes.fill(0));
    throw error;
  }
}

export class ReceiptDocumentPreparer {
  readonly #pdfRasterizer: PdfRasterizer;

  constructor(pdfRasterizer: PdfRasterizer = new PopplerPdfRasterizer()) {
    this.#pdfRasterizer = pdfRasterizer;
  }

  async prepare(
    source: ReceiptDocumentSource,
  ): Promise<PreparedReceiptDocument> {
    const rawPages: readonly Uint8Array[] =
      source.mediaType === 'application/pdf'
        ? await this.#pdfRasterizer.rasterize(source.bytes)
        : [source.bytes];

    try {
      return await prepareNormalizedPages(
        source.sourceSha256,
        rawPages,
        source.mediaType === 'application/pdf'
          ? 'pdf-limits-exceeded'
          : 'image-limits-exceeded',
      );
    } finally {
      if (source.mediaType === 'application/pdf') {
        rawPages.forEach((page) => page.fill(0));
      }
    }
  }
}

export class SelectedReceiptDocumentPreparer {
  readonly #pdfRasterizer: SelectedPdfPageRasterizer;

  constructor(
    pdfRasterizer: SelectedPdfPageRasterizer = new PopplerSelectedPdfPageRasterizer(),
  ) {
    this.#pdfRasterizer = pdfRasterizer;
  }

  async prepareSelected(
    source: ReceiptDocumentSource,
    oneBasedPages: readonly number[],
  ): Promise<PreparedReceiptDocument> {
    if (!validSelectedPages(oneBasedPages)) {
      throw new ReceiptDocumentPreparationError(
        source.mediaType === 'application/pdf'
          ? 'pdf-limits-exceeded'
          : 'image-limits-exceeded',
      );
    }

    let rawPages: readonly Uint8Array[];
    if (source.mediaType === 'application/pdf') {
      rawPages = await this.#pdfRasterizer.rasterizeSelected(
        source.bytes,
        oneBasedPages,
      );
    } else {
      if (oneBasedPages.length !== 1 || oneBasedPages[0] !== 1) {
        throw new ReceiptDocumentPreparationError('image-limits-exceeded');
      }
      rawPages = [source.bytes];
    }

    try {
      return await prepareNormalizedPages(
        source.sourceSha256,
        rawPages,
        source.mediaType === 'application/pdf'
          ? 'pdf-limits-exceeded'
          : 'image-limits-exceeded',
      );
    } finally {
      if (source.mediaType === 'application/pdf') {
        rawPages.forEach((page) => page.fill(0));
      }
    }
  }
}
