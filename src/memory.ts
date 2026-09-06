import { z } from 'zod';
import { canonical, Fault, hash, id, key, text } from './domain.js';
import type { Store } from './store.js';

const evidenceSchema = z.strictObject({
  messageId: id,
  quote: z.string().min(1).max(2000),
});
export const memoryInputSchema = z.strictObject({
  topic: z.string().min(1).max(150),
  content: text.min(1),
  scope: z.string().min(1).max(200),
  certainty: z.enum(['explicit', 'inferred']),
  evidence: z.array(evidenceSchema).min(1).max(20),
  expiresAt: z.iso.datetime().nullable(),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export interface Memory extends MemoryInput {
  id: string;
  revision: number;
  at: string;
  speakers: string[];
  status: 'current' | 'superseded' | 'forgotten';
  sources: string[];
}
interface Row {
  id: string;
  revision: number;
  scope: string;
  status: string;
  body: string;
}
export class MemoryStore {
  constructor(
    readonly store: Store,
    readonly speakers: ReadonlySet<string>,
  ) {}
  read(id: string): Memory | undefined {
    const row = this.store.db
      .prepare("SELECT * FROM memory WHERE id=? AND status='current'")
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const m = JSON.parse(row.body) as Memory;
    return m.expiresAt && Date.parse(m.expiresAt) <= Date.now() ? undefined : m;
  }
  private validate(input: MemoryInput): string[] {
    if (input.scope !== 'household' && !this.speakers.has(input.scope))
      throw new Fault('memory-scope');
    const speakers = new Set<string>();
    for (const e of input.evidence) {
      if (
        this.store.db
          .prepare('SELECT source FROM suppression WHERE source=?')
          .get(hash(e.messageId))
      )
        throw new Fault('memory-source-forgotten');
      const source = this.store.db
        .prepare('SELECT speaker,message FROM inbox WHERE id=?')
        .get(e.messageId) as { speaker: string; message: string } | undefined;
      if (source) {
        if (
          !this.speakers.has(source.speaker) ||
          !source.message.includes(e.quote)
        )
          throw new Fault('memory-evidence');
        speakers.add(source.speaker);
      } else {
        const imported = this.store.db
          .prepare(
            'SELECT author,body,certainty FROM memory_evidence WHERE id=?',
          )
          .get(e.messageId) as
          { author: string; body: string; certainty: string } | undefined;
        if (
          !imported ||
          !imported.body.includes(e.quote) ||
          (input.certainty === 'explicit' && imported.certainty !== 'explicit')
        )
          throw new Fault('memory-evidence');
        speakers.add(imported.author);
      }
    }
    return [...speakers].sort();
  }
  save(
    operationId: string,
    inputValue: unknown,
    target?: { id: string; revision: number },
  ): Memory {
    const input = memoryInputSchema.parse(inputValue);
    const memoryId = target?.id ?? key('memory', operationId);
    return this.store.db.transaction(() => {
      const digest = hash({ input, target: target ?? null });
      const op = this.store.operation(operationId);
      if (op) {
        if (op.desired !== canonical(digest))
          throw new Fault('memory-operation-conflict');
        const existing = this.read(memoryId);
        if (!existing) throw new Fault('memory-no-longer-current');
        return existing;
      }
      const speakers = this.validate(input);
      const old = target ? this.read(target.id) : undefined;
      if (target && (!old || old.revision !== target.revision))
        throw new Fault('memory-revision-conflict');
      if (
        old?.certainty === 'inferred' &&
        input.certainty === 'explicit' &&
        input.evidence.every((e) => old.sources.includes(e.messageId))
      )
        throw new Fault('memory-confirmation-required');
      if (old && old.scope !== input.scope)
        throw new Fault('memory-scope-change');
      const m: Memory = {
        ...input,
        id: memoryId,
        revision: (old?.revision ?? 0) + 1,
        at: new Date().toISOString(),
        speakers,
        status: 'current',
        sources: input.evidence.map((e) => e.messageId),
      };
      this.store.prepare(operationId, 'memory', target ?? null, digest);
      this.store.db
        .prepare(
          'INSERT INTO memory VALUES(@id,@revision,@scope,@status,@body) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,body=excluded.body',
        )
        .run({ ...m, body: canonical(m) });
      this.store.db
        .prepare('DELETE FROM memory_search WHERE id=?')
        .run(memoryId);
      this.store.db
        .prepare('INSERT INTO memory_search VALUES(?,?)')
        .run(memoryId, `${m.topic}\n${m.content}`);
      this.store.bump();
      this.store.operationState(operationId, 'complete');
      return m;
    })();
  }
  consolidate(
    operationId: string,
    targets: Array<{ id: string; revision: number }>,
    input: unknown,
  ): Memory {
    return this.store.db.transaction(() => {
      if (this.store.operation(operationId))
        return this.save(operationId, input);
      const rows = targets.map((t) => {
        const m = this.read(t.id);
        if (!m || m.revision !== t.revision)
          throw new Fault('memory-revision-conflict');
        return m;
      });
      if (!rows.length || rows.length > 10)
        throw new Fault('memory-consolidation-limit');
      const next = memoryInputSchema.parse(input);
      if (
        rows.some(
          (m) =>
            m.scope !== next.scope ||
            (m.certainty === 'inferred' && next.certainty === 'explicit'),
        )
      )
        throw new Fault('memory-consolidation-scope');
      const evidence = new Set(next.evidence.map(canonical));
      if (rows.some((m) => m.evidence.some((e) => !evidence.has(canonical(e)))))
        throw new Fault('memory-consolidation-evidence');
      const result = this.save(operationId, next);
      for (const m of rows) {
        this.store.db
          .prepare("UPDATE memory SET status='superseded' WHERE id=?")
          .run(m.id);
        this.store.db.prepare('DELETE FROM memory_search WHERE id=?').run(m.id);
      }
      this.store.bump();
      return result;
    })();
  }
  forget(
    operationId: string,
    targets: Array<{ id: string; revision: number }>,
  ): void {
    this.store.db.transaction(() => {
      const old = this.store.operation(operationId);
      if (old) {
        if (old.desired !== canonical(hash(targets)))
          throw new Fault('memory-operation-conflict');
        return;
      }
      const roots = targets.map((t) => {
        const m = this.read(t.id);
        if (!m || m.revision !== t.revision)
          throw new Fault('memory-revision-conflict');
        return m;
      });
      const sources = new Set(roots.flatMap((m) => m.sources));
      const all = this.store.db
        .prepare("SELECT body FROM memory WHERE status!='forgotten'")
        .all() as { body: string }[];
      // Follow transitive derivations before deleting any body.
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of all) {
          const m = JSON.parse(row.body) as Memory;
          if (m.sources.some((s) => sources.has(s)))
            for (const source of m.sources) {
              if (!sources.has(source)) {
                sources.add(source);
                changed = true;
              }
            }
        }
      }
      // Remove consolidated/derived memories sharing forgotten evidence as well.
      for (const row of all) {
        const m = JSON.parse(row.body) as Memory;
        if (!m.sources.some((s) => sources.has(s))) continue;
        this.store.db
          .prepare(
            "UPDATE memory SET status='forgotten',body='{}',revision=revision+1 WHERE id=?",
          )
          .run(m.id);
        this.store.db.prepare('DELETE FROM memory_search WHERE id=?').run(m.id);
      }
      for (const source of sources) {
        this.store.db
          .prepare("UPDATE memory_evidence SET body='' WHERE id=?")
          .run(source);
        this.store.db
          .prepare('INSERT OR IGNORE INTO suppression VALUES(?)')
          .run(hash(source));
      }
      this.store.prepare(operationId, 'forget', null, hash(targets));
      this.store.operationState(operationId, 'complete');
      this.store.bump();
    })();
  }
  search(query: string, limit = 8): Memory[] {
    const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
    if (!tokens.length) return [];
    const rows = this.store.db
      .prepare(
        'SELECT id FROM memory_search WHERE memory_search MATCH ? ORDER BY rank LIMIT ?',
      )
      .all(tokens.map((t) => `"${t}"`).join(' OR '), Math.min(30, limit)) as {
      id: string;
    }[];
    return rows.flatMap((r) => {
      const m = this.read(r.id);
      return m ? [m] : [];
    });
  }
  foundation(): Memory[] {
    const rows = this.store.db
      .prepare(
        "SELECT id FROM memory WHERE status='current' ORDER BY rowid DESC LIMIT 100",
      )
      .all() as { id: string }[];
    return rows
      .flatMap((r) => {
        const m = this.read(r.id);
        return m &&
          m.certainty === 'explicit' &&
          !m.topic.startsWith('Category meaning:')
          ? [m]
          : [];
      })
      .slice(0, 10);
  }
  suppressed(messageId: string): boolean {
    return !!this.store.db
      .prepare('SELECT 1 FROM suppression WHERE source=?')
      .get(hash(messageId));
  }
  history(query = '', limit = 10): unknown[] {
    const term = query.replace(/[%_\\]/g, '');
    const rows = this.store.db
      .prepare(
        'SELECT id,speaker,message,parent,at FROM inbox WHERE message LIKE ? ORDER BY rowid DESC LIMIT 1000',
      )
      .all(`%${term}%`) as Array<{ id: string }>;
    return rows.filter((r) => !this.suppressed(r.id)).slice(0, limit);
  }
  context(message: string, parent: string | null): unknown {
    const recent = this.history('', 8);
    const thread: unknown[] = [];
    const seen = new Set<string>();
    let cursor = parent;
    while (cursor && thread.length < 16 && !seen.has(cursor)) {
      seen.add(cursor);
      const row = this.store.db
        .prepare('SELECT id,speaker,message,parent,at FROM inbox WHERE id=?')
        .get(cursor) as { parent: string | null } | undefined;
      if (!row) {
        const reply = this.store.db
          .prepare('SELECT parent,body FROM replies WHERE delivered=?')
          .get(cursor) as { parent: string; body: string } | undefined;
        if (!reply) break;
        if (!this.suppressed(reply.parent))
          thread.unshift({
            speaker: 'assistant',
            message: reply.body,
            parent: reply.parent,
          });
        cursor = reply.parent;
        continue;
      }
      if (!this.suppressed(cursor)) thread.unshift(row);
      cursor = row.parent;
    }
    return {
      revision: this.store.revision(),
      foundation: this.foundation(),
      categoryMeanings: (
        this.store.db
          .prepare("SELECT id FROM memory WHERE status='current'")
          .all() as Array<{ id: string }>
      ).flatMap((r) => {
        const m = this.read(r.id);
        return m?.topic.startsWith('Category meaning:') ? [m] : [];
      }),
      related: this.search(message),
      recent,
      thread,
      catalog: (
        this.store.db
          .prepare("SELECT id FROM memory WHERE status='current' LIMIT 100")
          .all() as Array<{ id: string }>
      ).flatMap((r) => {
        const m = this.read(r.id);
        return m
          ? [
              {
                id: m.id,
                topic: m.topic,
                scope: m.scope,
                certainty: m.certainty,
              },
            ]
          : [];
      }),
      replies: (
        this.store.db
          .prepare(
            'SELECT parent,body FROM replies WHERE delivered IS NOT NULL ORDER BY rowid DESC LIMIT 30',
          )
          .all() as Array<{ parent: string; body: string }>
      )
        .filter((r) => !this.suppressed(r.parent))
        .slice(0, 8),
    };
  }
}
