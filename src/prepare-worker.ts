import {
  readFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import sharp from 'sharp';
import { prepareExport, sniff, MAX_FILE } from './documents.js';

// This executable is launched only through the credential-free bwrap boundary.
async function main(): Promise<void> {
  const bytes = readFileSync(0);
  if (bytes.length > MAX_FILE) throw new Error('file-too-large');
  const mediaType = sniff(bytes);
  const exported = prepareExport(bytes, mediaType);
  if (exported) {
    process.stdout.write(JSON.stringify(exported));
    return;
  }
  if (mediaType.startsWith('audio/')) throw new Error('voice-not-supported');
  const images: string[] = [];
  const encode = async (b: Buffer) => {
    images.push(
      (
        await sharp(b, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize({
            width: 1800,
            height: 2400,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 85 })
          .toBuffer()
      ).toString('base64'),
    );
  };
  if (mediaType === 'application/pdf') {
    const dir = mkdtempSync('/tmp/document-');
    try {
      const file = join(dir, 'source.pdf');
      writeFileSync(file, bytes);
      const info = execFileSync('/usr/bin/pdfinfo', [file], {
        timeout: 10000,
        maxBuffer: 65536,
      }).toString();
      const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
      if (!Number.isInteger(pages) || pages < 1 || pages > 12)
        throw new Error('document-page-limit');
      execFileSync(
        '/usr/bin/pdftoppm',
        [
          '-jpeg',
          '-r',
          '120',
          '-f',
          '1',
          '-l',
          String(pages),
          file,
          join(dir, 'page'),
        ],
        { timeout: 30000, maxBuffer: 65536 },
      );
      for (const name of readdirSync(dir)
        .filter((n) => n.endsWith('.jpg'))
        .sort())
        await encode(readFileSync(join(dir, name)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else await encode(bytes);
  process.stdout.write(JSON.stringify({ type: 'images', images, mediaType }));
}
main().catch(() => {
  process.stderr.write('document-preparation-failed');
  process.exitCode = 1;
});
