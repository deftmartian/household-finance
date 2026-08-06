import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  ReceiptDocumentPreparationError,
  ReceiptDocumentPreparer,
  SelectedReceiptDocumentPreparer,
  type PdfRasterizer,
  type ReceiptDocumentSource,
  type SelectedPdfPageRasterizer,
} from '../../src/documents/index.js';

async function imageBytes(
  format: 'jpeg' | 'png',
  width = 320,
  height = 640,
): Promise<Buffer> {
  const pipeline = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#fafafa',
    },
  });
  return format === 'jpeg'
    ? pipeline.jpeg().toBuffer()
    : pipeline.png().toBuffer();
}

function source(
  bytes: Buffer,
  mediaType: ReceiptDocumentSource['mediaType'],
): ReceiptDocumentSource {
  return {
    bytes,
    mediaType,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('ReceiptDocumentPreparer', () => {
  it.each(['jpeg', 'png'] as const)(
    'normalizes a bounded %s source to metadata-free JPEG',
    async (format) => {
      const bytes = await imageBytes(format);
      const prepared = await new ReceiptDocumentPreparer().prepare(
        source(bytes, format === 'jpeg' ? 'image/jpeg' : 'image/png'),
      );

      expect(prepared.sourceSha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(prepared.pages).toHaveLength(1);
      expect(prepared.pages[0]?.mediaType).toBe('image/jpeg');
      expect(prepared.pages[0]?.bytes.subarray(0, 3)).toEqual(
        Buffer.from([0xff, 0xd8, 0xff]),
      );
      const metadata = await sharp(prepared.pages[0]?.bytes).metadata();
      expect(
        Math.max(metadata.width ?? 0, metadata.height ?? 0),
      ).toBeLessThanOrEqual(2_048);
    },
  );

  it('normalizes each PDF raster page in stable order', async () => {
    const first = await imageBytes('jpeg', 200, 400);
    const second = await imageBytes('jpeg', 400, 200);
    const rasterizer: PdfRasterizer = {
      rasterize: async () => [first, second],
    };
    const pdf = Buffer.from('%PDF-1.7 fake test bytes');

    const prepared = await new ReceiptDocumentPreparer(rasterizer).prepare(
      source(pdf, 'application/pdf'),
    );

    expect(prepared.pages.map((page) => page.position)).toEqual([0, 1]);
    expect(
      prepared.pages.every((page) => page.mediaType === 'image/jpeg'),
    ).toBe(true);
  });

  it('rejects malformed images with a content-free error', async () => {
    const privateBytes = Buffer.from('private receipt content');

    try {
      await new ReceiptDocumentPreparer().prepare(
        source(privateBytes, 'image/jpeg'),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ReceiptDocumentPreparationError);
      expect(String(error)).not.toContain('private receipt content');
      return;
    }
    throw new Error('Expected image preparation to fail');
  });

  it('rejects an excessive PDF page count before model transmission', async () => {
    const page = await imageBytes('jpeg', 8, 8);
    const rasterizer: PdfRasterizer = {
      rasterize: async () => Array.from({ length: 11 }, () => page),
    };

    await expect(
      new ReceiptDocumentPreparer(rasterizer).prepare(
        source(Buffer.from('%PDF-1.7 fake'), 'application/pdf'),
      ),
    ).rejects.toMatchObject({ code: 'pdf-limits-exceeded' });
  });
});

describe('SelectedReceiptDocumentPreparer', () => {
  it('rasterizes only the selected PDF pages in manifest order', async () => {
    const second = await imageBytes('jpeg', 200, 400);
    const seventh = await imageBytes('jpeg', 400, 200);
    const requestedPages: number[][] = [];
    const rasterizer: SelectedPdfPageRasterizer = {
      rasterizeSelected: async (_bytes, pages) => {
        requestedPages.push([...pages]);
        return [second, seventh];
      },
    };
    const pdf = Buffer.from('%PDF-1.7 synthetic selected-page fixture');

    const prepared = await new SelectedReceiptDocumentPreparer(
      rasterizer,
    ).prepareSelected(source(pdf, 'application/pdf'), [2, 7]);

    expect(requestedPages).toEqual([[2, 7]]);
    expect(prepared.pages.map((page) => page.position)).toEqual([0, 1]);
    expect(
      prepared.pages.every((page) => page.mediaType === 'image/jpeg'),
    ).toBe(true);
  });

  it('rejects invalid image page selection before rasterization or transmission', async () => {
    const bytes = await imageBytes('jpeg');

    await expect(
      new SelectedReceiptDocumentPreparer().prepareSelected(
        source(bytes, 'image/jpeg'),
        [2],
      ),
    ).rejects.toMatchObject({ code: 'image-limits-exceeded' });
  });

  it('rejects more than ten selected pages before invoking a PDF rasterizer', async () => {
    let called = false;
    const rasterizer: SelectedPdfPageRasterizer = {
      rasterizeSelected: async () => {
        called = true;
        return [];
      },
    };

    await expect(
      new SelectedReceiptDocumentPreparer(rasterizer).prepareSelected(
        source(Buffer.from('%PDF-1.7 synthetic'), 'application/pdf'),
        Array.from({ length: 11 }, (_, index) => index + 1),
      ),
    ).rejects.toMatchObject({ code: 'pdf-limits-exceeded' });
    expect(called).toBe(false);
  });
});
