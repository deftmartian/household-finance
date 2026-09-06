/* global Buffer, console */
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { prepare } from './dist/prepare.js';
const diagnosticExec = cp.execFile;
cp.execFile = (file, args, options, callback) =>
  diagnosticExec(file, args, options, (error, out, stderr) => {
    if (error) console.error(stderr);
    callback(error, out, stderr);
  });
syncBuiltinESMExports();
const facts = await prepare(
  Buffer.from('merchant,date,currency,total\nExample,2026-09-06,CAD,1.00'),
);
assert.equal(facts.type, 'facts');
assert.equal(facts.facts[0].total, 100);
const bytes = await sharp({
  create: { width: 40, height: 40, channels: 3, background: 'white' },
})
  .png()
  .toBuffer();
const image = await prepare(bytes);
assert.equal(image.type, 'images');
assert.equal(image.images.length, 1);
const server = createServer((_req, res) => res.end('parent-network'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const original = cp.execFile;
cp.execFile = (file, args, options, callback) => {
  const probe = `import fs from 'node:fs';import assert from 'node:assert/strict';assert(!fs.existsSync('/run/secrets/probe'));assert(!fs.existsSync('/data/probe'));assert(!fs.existsSync('/proc/1/environ'));assert.equal(process.env.FINANCE_TEST_SECRET,undefined);let reached=false;try{await fetch('http://127.0.0.1:${port}',{signal:AbortSignal.timeout(1000)});reached=true;}catch{}assert(!reached);console.log(JSON.stringify({type:'facts',facts:[],mediaType:'text/plain'}));`;
  return original(
    file,
    [...args.slice(0, -1), '--input-type=module', '-e', probe],
    options,
    callback,
  );
};
syncBuiltinESMExports();
try {
  await prepare(Buffer.from('probe'));
} finally {
  server.close();
}
console.log(
  'Container parsing, secret isolation, process isolation, and network isolation passed',
);
