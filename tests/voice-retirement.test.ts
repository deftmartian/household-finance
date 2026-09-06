import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { FakeLedger } from './fixtures.js';
import type { Message } from '../src/talk.js';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

for (const declared of [true, false]) {
  it(`rejects ${declared ? 'declared' : 'mislabeled'} voice without archiving or model calls`, async () => {
    const store = new Store(':memory:');
    stores.push(store);
    const bytes = Buffer.from('OggS synthetic voice payload');
    const talk = {
      download: vi.fn(async () => Buffer.from(bytes)),
      archive: vi.fn(async () => {
        throw new Error('audio must not be archived');
      }),
      details: vi.fn(async () => {
        throw new Error('no purchase details');
      }),
      reply: vi.fn(async () => 'reply-id'),
    };
    const model = {
      structured: vi.fn(async () => {
        throw new Error('audio must not reach model');
      }),
    };
    const prepare = vi.fn(async () => {
      throw new Error('audio must not reach document worker');
    });
    const engine = new Engine(store, new FakeLedger(), model, talk, {
      speakers: new Set(['andrew']),
      writeAccounts: new Set(['card']),
      currency: 'CAD',
      prepare,
    });
    const message: Message = {
      id: '42',
      speaker: 'andrew',
      message: '',
      parent: null,
      at: '2026-09-05T12:00:00Z',
      attachments: [1, 2].map((n) => ({
        fileId: String(n),
        etag: 'etag',
        size: bytes.length,
        mediaType: declared ? 'audio/ogg' : 'application/octet-stream',
      })),
    };
    expect(store.intake(message, 'attachment', message)).toBe(true);
    for (let n = 0; n < 3; n++) await engine.run(store.next()!);
    expect(store.intake(message, 'attachment', message)).toBe(false);
    await engine.flushReplies();
    await engine.flushReplies();
    expect(talk.reply).toHaveBeenCalledTimes(1);
    expect(talk.reply.mock.calls[0]).toEqual(
      expect.arrayContaining([
        'Voice messages are no longer supported. Please send your question as text.',
      ]),
    );
    expect(talk.download).toHaveBeenCalledTimes(declared ? 0 : 2);
    expect(talk.archive).not.toHaveBeenCalled();
    expect(model.structured).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT state FROM jobs').get()).toEqual({
      state: 'done',
    });
  });
}
