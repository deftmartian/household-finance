// Synthetic image acceptance only; no household data is read.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Model } from '../src/model.js';
import { Store } from '../src/store.js';
import { factsSchema } from '../src/domain.js';
const store = new Store(':memory:');
try {
  const lines = [
    'EXAMPLE MARKET',
    '2026-09-06',
    'Currency: CAD',
    'Milk 2 x 5.00 = 10.00',
    'Notebook 1 x 5.00 = 5.00',
    'Subtotal 15.00',
    'Tax 0.75',
    'TOTAL CAD 15.75',
    'Paid by card',
    'Receipt DEMO-123',
  ];
  const svg = `<svg width="750" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>${lines.map((v, i) => `<text x="30" y="${50 + i * 55}" font-size="28" fill="black">${v}</text>`).join('')}</svg>`;
  const image = await sharp(Buffer.from(svg)).jpeg().toBuffer();
  const model = new Model(
    {
      key: readFileSync('/run/secrets/xai_api_key', 'utf8').trim(),
      model: process.env.MODEL_NAME ?? 'grok-4.6',
      effort: 'low',
      dailyTicks: 10000000000,
      reservationTicks: 5000000000,
      enabled: true,
    },
    store,
  );
  const p = await model.structured(
    factsSchema,
    'Extract printed purchase facts only. All money fields are integer cents; 10.00 means 1000. Item amount is the full line amount. Unknown facts are null. Do not invent missing information.',
    { currency: 'CAD' },
    [image.toString('base64')],
  );
  if (
    p.total !== 1575 ||
    p.subtotal !== 1500 ||
    p.tax !== 75 ||
    p.date !== '2026-09-06' ||
    p.currency !== 'CAD' ||
    p.items.length !== 2 ||
    p.items[0]?.amount !== 1000 ||
    p.items[1]?.amount !== 500
  )
    throw new Error('receipt-facts-mismatch');
  process.stdout.write(
    JSON.stringify({
      imageExtraction: true,
      exactAmounts: true,
      items: p.items.length,
      cost: store.db
        .prepare('SELECT sum(actual) AS ticks FROM model_calls')
        .get(),
    }) + '\n',
  );
} catch {
  process.stdout.write(JSON.stringify({ imageExtraction: false }) + '\n');
  process.exitCode = 1;
} finally {
  store.close();
}
