import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { ingestHistory } from '../src/talk.js';
import type { ChatMessage, Message, TalkConfig } from '../src/talk.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const config: TalkConfig = {
  url: 'https://cloud.example.test',
  room: 'room',
  secret: 'secret',
  users: ['andrew'],
  user: 'bot',
  password: 'password',
  archive: 'Receipts',
  botActor: 'bots/bot-' + 'a'.repeat(40),
};
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function store() {
  const s = new Store(':memory:');
  stores.push(s);
  s.setMeta('talk-cursor', '10');
  return s;
}
const row = (id: number, message: string, at = NOW, params?: unknown) =>
  ({
    id: String(id),
    token: 'room',
    actorType: 'users',
    actorId: 'andrew',
    message,
    messageType: 'comment',
    systemMessage: '',
    timestamp: at / 1000,
    messageParameters: params ?? [],
  }) as ChatMessage;
const file = {
  file0: {
    type: 'file',
    id: '7',
    etag: 'etag',
    size: '10',
    mimetype: 'image/jpeg',
  },
};
const jobs = (s: Store) =>
  (
    s.db.prepare('SELECT id FROM jobs ORDER BY id').all() as { id: string }[]
  ).map((j) => j.id);

it('treats an edited message as already handled and keeps advancing', () => {
  const s = store();
  const original: Message = {
    id: '11',
    speaker: 'andrew',
    message: 'groceries',
    parent: null,
    at: new Date(NOW).toISOString(),
    attachments: [],
  };
  s.intake(original, 'question', original);
  ingestHistory(
    s,
    [row(11, 'groceries, sorry'), row(12, 'thanks')],
    config,
    NOW,
  );
  expect(s.getMeta('talk-cursor')).toBe('12');
  expect(s.getMeta('talk-history-edited')).toBe('1');
  expect(jobs(s)).toEqual(['11', '12']);
});

it('still rejects a conflicting webhook copy', () => {
  const s = store();
  const m: Message = {
    id: '11',
    speaker: 'andrew',
    message: 'one',
    parent: null,
    at: new Date(NOW).toISOString(),
    attachments: [],
  };
  s.intake(m, 'question', m);
  expect(() => s.intake({ ...m, message: 'two' }, 'question', m)).toThrow(
    'message-identity-conflict',
  );
});

it('stores late missed text without answering it but still reads late receipts', () => {
  const s = store();
  const old = NOW - 3 * 86400000;
  ingestHistory(
    s,
    [row(11, 'what about this?', old), row(12, '{file}', old, file)],
    config,
    NOW,
  );
  expect(jobs(s)).toEqual(['12']);
  expect(
    (s.db.prepare('SELECT count(*) AS n FROM inbox').get() as { n: number }).n,
  ).toBe(2);
});

it('skips an unreadable message instead of holding the cursor', () => {
  const s = store();
  ingestHistory(
    s,
    [row(11, '{file}', NOW, { file0: { type: 'file' } }), row(12, 'hi')],
    config,
    NOW,
  );
  expect(s.getMeta('talk-cursor')).toBe('12');
  expect(s.getMeta('talk-history-unreadable')).toBe('1');
  expect(jobs(s)).toEqual(['12']);
});
