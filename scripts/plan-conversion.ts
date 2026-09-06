import { readFileSync, writeFileSync } from 'node:fs';
import { planConversion } from './conversion.js';
const [input, output, archiveBase] = process.argv.slice(2);
if (!input || !output || !archiveBase)
  throw new Error(
    'Usage: plan-conversion input.json output.json authenticated-archive-base',
  );
const plan = planConversion(
  JSON.parse(readFileSync(input, 'utf8')),
  archiveBase,
);
writeFileSync(output, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
process.stdout.write(
  JSON.stringify({
    counts: plan.counts,
    operations: plan.changes.length,
    sourceHash: plan.sourceHash,
    protectedHash: plan.protectedHash,
  }) + '\n',
);
