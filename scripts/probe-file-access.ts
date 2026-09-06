// Creates synthetic archive artifacts for per-user access verification.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { config, secret } from '../src/config.js';
import { Talk } from '../src/talk.js';
try {
  const c = config('/run/secrets/finance_config');
  const talk = new Talk({
    ...c.talk,
    password: secret(c.talk.passwordFile),
    secret: secret(c.talk.secretFile),
  });
  const body = Buffer.from(
    '{"purpose":"household-finance deployment access proof","synthetic":true}',
  );
  const source = await talk.archive(body, '0');
  const detail =
    'Synthetic purchase detail access proof. No household transaction.';
  const url = await talk.details('deployment-access-proof', 1, detail);
  const file = (url: string, hash: string) => ({
    id: url.split('/').at(-1),
    hash,
  });
  writeFileSync(
    '/proof/file-access.json',
    JSON.stringify({
      users: c.talk.users,
      files: [
        file(source.url, source.hash),
        file(url, createHash('sha256').update(detail).digest('hex')),
      ],
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      archivePublished: true,
      detailPublished: true,
      authenticatedLinks: true,
    }) + '\n',
  );
} catch {
  process.stdout.write(JSON.stringify({ fileAccessPreparation: false }) + '\n');
  process.exitCode = 1;
}
