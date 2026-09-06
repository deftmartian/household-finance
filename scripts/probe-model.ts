// Synthetic provider acceptance test; never reads a household budget or profile.
import { readFileSync, mkdtempSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Model } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { FakeLedger } from '../tests/fixtures.js';
import type { Message } from '../src/talk.js';
const store = new Store(
  mkdtempSync('/tmp/finance-synthetic-') + '/work.sqlite',
);
const model = new Model(
  {
    key: readFileSync(
      process.env.XAI_API_KEY_FILE ?? '/run/secrets/xai_api_key',
      'utf8',
    ).trim(),
    model: process.env.MODEL_NAME ?? 'grok-4.6',
    effort: 'low',
    dailyTicks: 10000000000,
    reservationTicks: 5000000000,
    enabled: true,
  },
  store,
);
const replies: string[] = [];
const engine = new Engine(
  store,
  new FakeLedger(),
  model,
  {
    download: async () => {
      throw new Error('unused');
    },
    archive: async () => {
      throw new Error('unused');
    },
    details: async () => {
      throw new Error('unused');
    },
    reply: async (_id, _parent, body) => {
      replies.push(body);
      return String(replies.length);
    },
  },
  {
    speakers: new Set(['andrew', 'johanna']),
    writeAccounts: new Set(['card']),
    currency: 'CAD',
  },
);
async function message(id: string, message: string): Promise<void> {
  const m: Message = {
    id,
    speaker: 'andrew',
    message,
    parent: null,
    at: new Date().toISOString(),
    attachments: [],
  };
  store.intake(m, 'question', m);
  for (let n = 0; n < 10; n++) {
    const job = store.next();
    if (!job) break;
    await engine.run(job);
  }
  await engine.flushReplies();
  const row = store.db.prepare('SELECT state FROM jobs WHERE id=?').get(id) as {
    state: string;
  };
  if (row.state !== 'done') throw new Error('synthetic-work-incomplete');
}
let phase = 'remember';
try {
  await message(
    '1',
    'Please remember that school supplies are for the children.',
  );
  if (!engine.memory.search('school').length)
    throw new Error('synthetic-memory-not-saved');
  phase = 'recall';
  await message('2', 'What do you remember about school supplies?');
  if (!replies.some((r) => /children|kids/i.test(r)))
    throw new Error('synthetic-recall-failed');
  phase = 'forget';
  await message('3', 'Forget the school-supplies preference.');
  if (engine.memory.search('school').length)
    throw new Error('synthetic-forget-failed');
  process.stdout.write(
    JSON.stringify({
      remember: true,
      recall: true,
      forget: true,
      calls: store.db.prepare('SELECT count(*) AS n FROM model_calls').get(),
      cost: store.db
        .prepare('SELECT sum(actual) AS ticks FROM model_calls')
        .get(),
    }) + '\n',
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      phase,
      error:
        error instanceof Error && /^synthetic-[a-z-]+$/.test(error.message)
          ? error.message
          : 'synthetic-provider-failure',
      work: store.db.prepare('SELECT state,error FROM jobs').all(),
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  store.close();
}
