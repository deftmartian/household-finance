// Offline import of durable context and unfinished business work only.
import Database from 'better-sqlite3';
import { z } from 'zod';
import { canonical, hash, key, parsePurchase } from '../src/domain.js';
import { MemoryStore } from '../src/memory.js';
import type { Store } from '../src/store.js';
import type { Purchase } from '../src/domain.js';
import type { Message } from '../src/talk.js';

export function convertContext(
  profileValue: unknown,
  sourceDir: string,
  store: Store,
  users: string[],
  purchases: Purchase[],
  cursor: string,
  taxonomyValue: unknown = null,
): unknown {
  const profile = z
    .object({
      schemaVersion: z.literal('household-finance-profile.v1'),
      members: z.array(z.record(z.string(), z.unknown())),
      policies: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .parse(profileValue);
  const fingerprint = hash({
    profile,
    taxonomyValue,
    users,
    cursor,
    purchases: purchases.map((p) => p.id),
  });
  const complete = store.getMeta('context-conversion');
  if (complete) {
    if (complete !== fingerprint)
      throw new Error('context-conversion-conflict');
    return { replayed: true };
  }
  const memory = new MemoryStore(store, new Set(users));
  return store.db.transaction(() => {
    let imported = 0,
      questions = 0,
      attachments = 0,
      retiredVoice = 0;
    for (const [section, value] of Object.entries(profile)) {
      const entries = Array.isArray(value)
        ? value
        : section === 'policies'
          ? Object.values(profile.policies)
          : [];
      for (const raw of entries) {
        const record = z
          .object({
            status: z.enum(['confirmed', 'candidate']),
            provenance: z.object({
              source: z.enum([
                'operator',
                'talk-explicit',
                'talk-confirmed',
                'actual-confirmed',
              ]),
              actorId: z.string(),
              recordedAt: z.string(),
            }),
          })
          .passthrough()
          .parse(raw);
        const sourceId = key('preserved-context', section, hash(record)),
          body = canonical(record),
          certainty = record.status === 'confirmed' ? 'explicit' : 'inferred';
        store.db
          .prepare('INSERT INTO memory_evidence VALUES(?,?,?,?)')
          .run(sourceId, record.provenance.actorId, body, certainty);
        const person =
          typeof record.memberId === 'string'
            ? profile.members.find((m) => m.id === record.memberId)
            : undefined;
        const actor =
          person && Array.isArray(person.talkActorIds)
            ? person.talkActorIds.find((id) => users.includes(String(id)))
            : undefined;
        const topic =
          `${section}: ${String(record.name ?? record.displayName ?? record.id ?? record.alias ?? 'household policy')}`.slice(
            0,
            150,
          );
        memory.save(key('import-memory', sourceId), {
          topic,
          content: body,
          scope: actor ? String(actor) : 'household',
          certainty,
          evidence: [{ messageId: sourceId, quote: body }],
          expiresAt:
            typeof record.expiresAt === 'string' ? record.expiresAt : null,
        });
        imported++;
      }
    }
    if (taxonomyValue !== null) {
      const taxonomy = z
        .object({
          schemaVersion: z.literal('household-category-taxonomy.v1'),
          categories: z.array(z.record(z.string(), z.unknown())),
        })
        .parse(taxonomyValue);
      for (const category of taxonomy.categories) {
        const body = canonical(category),
          sourceId = key('category-meaning', hash(category));
        store.db
          .prepare('INSERT INTO memory_evidence VALUES(?,?,?,?)')
          .run(sourceId, 'preserved configuration', body, 'explicit');
        memory.save(key('import-memory', sourceId), {
          topic: `Category meaning: ${String(category.name)}`.slice(0, 150),
          content: body,
          scope: 'household',
          certainty: 'explicit',
          evidence: [{ messageId: sourceId, quote: body.slice(0, 1900) }],
          expiresAt: null,
        });
        imported++;
      }
    }
    const input = (m: Message, state: 'done' | 'attention') => {
      if (!users.includes(m.speaker))
        throw new Error('preserved-speaker-outside-contract');
      const existing = store.db
        .prepare('SELECT id FROM inbox WHERE id=?')
        .get(m.id);
      if (existing) return;
      store.intake(m, m.attachments.length ? 'attachment' : 'question', m);
      store.db
        .prepare('UPDATE jobs SET state=?,error=? WHERE id=?')
        .run(
          state,
          state === 'attention' ? 'preserved-unfinished-work' : null,
          m.id,
        );
    };
    const questionDb = new Database(sourceDir + '/finance-questions.sqlite', {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const voices = questionDb
        .prepare('SELECT message_id FROM question_voice_sources')
        .all() as Array<{ message_id: string }>;
      const voiceIds = new Set(voices.map((v) => v.message_id));
      const rows = questionDb
        .prepare(
          'SELECT e.*,i.status,i.answer FROM question_inbound_events e JOIN question_items i ON i.event_id=e.id',
        )
        .all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const m: Message = {
          id: String(r.message_id),
          speaker: String(r.actor_id),
          message: String(r.question),
          parent: null,
          at: String(r.received_at),
          attachments: [],
        };
        input(
          m,
          r.status === 'completed' || voiceIds.has(m.id) ? 'done' : 'attention',
        );
        if (typeof r.answer === 'string' && r.answer.trim()) {
          store.queueReply(key('preserved-answer', m.id), m.id, r.answer);
          store.db
            .prepare('UPDATE replies SET delivered=? WHERE id=?')
            .run('preserved', key('preserved-answer', m.id));
        }
        questions++;
      }
      for (const id of voiceIds) {
        store.setMeta(key('retired-voice', id), 'true');
        retiredVoice++;
      }
    } finally {
      questionDb.close();
    }
    const attachmentDb = new Database(sourceDir + '/attachment-shadow.sqlite', {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = attachmentDb
        .prepare(
          'SELECT e.*,i.status FROM attachment_inbound_events e JOIN attachment_shadow_items i ON i.event_id=e.id',
        )
        .all() as Array<Record<string, unknown>>;
      for (const r of rows) {
        const m: Message = {
          id: String(r.message_id),
          speaker: String(r.actor_id),
          message: typeof r.caption_hint === 'string' ? r.caption_hint : '',
          parent: null,
          at: String(r.received_at),
          attachments: [
            {
              fileId: String(r.file_id),
              etag: String(r.source_etag),
              size: Number(r.source_size_bytes),
              mediaType: String(r.source_media_type),
            },
          ],
        };
        input(m, r.status === 'completed' ? 'done' : 'attention');
        attachments++;
      }
      const uncertain = attachmentDb
        .prepare(
          "SELECT count(*) AS n FROM actual_update_state WHERE status NOT IN ('applied','rejected','undone','failed')",
        )
        .get() as { n: number };
      if (uncertain.n) throw new Error('unreconciled-predecessor-writes');
    } finally {
      attachmentDb.close();
    }
    for (const value of purchases) {
      const p = parsePurchase(value);
      store.cachePurchase(p.id, p);
      if (p.state === 'pending')
        store.enqueue(key('purchase', p.id, String(p.revision)), 'purchase', {
          purchaseId: p.id,
          messageId: p.sources[0]!.messageId,
        });
    }
    store.setMeta('talk-cursor', cursor);
    store.setMeta('context-conversion', fingerprint);
    return {
      memories: imported,
      questions,
      attachments,
      retiredVoice,
      purchases: purchases.length,
    };
  })();
}
