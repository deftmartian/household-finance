import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, Fault, hash } from './domain.js';

export interface Job {
  id: string;
  kind: string;
  payload: string;
  state: string;
  checkpoint: string;
  attempts: number;
  due: number;
  error: string | null;
}
export interface Operation {
  id: string;
  kind: string;
  expected: string;
  desired: string;
  state: string;
}
export class Store {
  readonly db: Database.Database;
  constructor(path: string, recover = false) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 5000');
    const application = this.db.pragma('application_id', { simple: true });
    const count = this.db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { n: number };
    if (
      (application !== 1212565042 && count.n > 0) ||
      (count.n > 0 &&
        Number(this.db.pragma('user_version', { simple: true })) !== 2)
    ) {
      this.db.close();
      throw new Fault('unsupported-database');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, speaker TEXT NOT NULL, message TEXT NOT NULL, parent TEXT, at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', checkpoint TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, error TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,due);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,expected TEXT NOT NULL,desired TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'prepared') STRICT;
      CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY, parent TEXT NOT NULL, body TEXT NOT NULL, delivered TEXT, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED,content,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS memory_evidence(id TEXT PRIMARY KEY,author TEXT NOT NULL,body TEXT NOT NULL,certainty TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS suppression(source TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,status TEXT NOT NULL) STRICT;
      PRAGMA application_id = 1212565042; PRAGMA user_version = 2;
    `);
    if (recover)
      this.db
        .prepare("UPDATE jobs SET state='ready' WHERE state='running'")
        .run();
  }
  close(): void {
    this.db.close();
  }
  getMeta(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as
        { value: string } | undefined
    )?.value;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }
  revision(): number {
    return Number(this.getMeta('context-revision') ?? '0');
  }
  bump(): void {
    this.setMeta('context-revision', String(this.revision() + 1));
  }
  intake(
    input: {
      id: string;
      speaker: string;
      message: string;
      parent: string | null;
      at: string;
    },
    kind: string,
    payload: unknown,
  ): boolean {
    return this.db.transaction(() => {
      const old = this.db
        .prepare('SELECT * FROM inbox WHERE id=?')
        .get(input.id) as typeof input | undefined;
      if (old) {
        if (
          old.speaker !== input.speaker ||
          old.message !== input.message ||
          old.parent !== input.parent
        )
          throw new Fault('message-identity-conflict');
        return false;
      }
      this.db
        .prepare('INSERT INTO inbox VALUES(@id,@speaker,@message,@parent,@at)')
        .run(input);
      this.enqueue(input.id, kind, payload);
      return true;
    })();
  }
  enqueue(id: string, kind: string, payload: unknown, due = Date.now()): void {
    const serialized = canonical(payload);
    const old = this.db
      .prepare('SELECT kind,payload FROM jobs WHERE id=?')
      .get(id) as { kind: string; payload: string } | undefined;
    if (old && (old.kind !== kind || old.payload !== serialized))
      throw new Fault('job-identity-conflict');
    this.db
      .prepare(
        'INSERT OR IGNORE INTO jobs(id,kind,payload,due) VALUES(?,?,?,?)',
      )
      .run(id, kind, serialized, due);
  }
  next(now = Date.now()): Job | undefined {
    return this.db.transaction(() => {
      const job = this.db
        .prepare(
          "SELECT * FROM jobs WHERE state='ready' AND due<=? ORDER BY CASE WHEN kind='question' THEN 0 ELSE 1 END,due,id LIMIT 1",
        )
        .get(now) as Job | undefined;
      if (job)
        this.db
          .prepare(
            "UPDATE jobs SET state='running',attempts=attempts+1 WHERE id=?",
          )
          .run(job.id);
      return job ? { ...job, attempts: job.attempts + 1 } : undefined;
    })();
  }
  checkpoint(id: string, value: unknown): void {
    this.db
      .prepare('UPDATE jobs SET checkpoint=? WHERE id=?')
      .run(canonical(value), id);
  }
  finish(id: string): void {
    this.db
      .prepare("UPDATE jobs SET state='done',error=NULL WHERE id=?")
      .run(id);
  }
  fail(job: Job, error: unknown): void {
    const safe = error instanceof Fault ? error : new Fault('operation-failed');
    const retry = safe.retry && job.attempts < 3;
    this.db
      .prepare('UPDATE jobs SET state=?,error=?,due=? WHERE id=?')
      .run(
        retry ? 'ready' : 'attention',
        safe.code,
        Date.now() + 30000 * 2 ** job.attempts,
        job.id,
      );
  }
  prepare(
    id: string,
    kind: string,
    expected: unknown,
    desired: unknown,
  ): Operation {
    const row = {
      id,
      kind,
      expected: canonical(expected),
      desired: canonical(desired),
    };
    this.db
      .prepare(
        'INSERT OR IGNORE INTO operations(id,kind,expected,desired) VALUES(@id,@kind,@expected,@desired)',
      )
      .run(row);
    const found = this.operation(id)!;
    if (
      found.kind !== kind ||
      found.expected !== row.expected ||
      found.desired !== row.desired
    )
      throw new Fault('operation-identity-conflict');
    return found;
  }
  operation(id: string): Operation | undefined {
    return this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as
      Operation | undefined;
  }
  operationState(id: string, state: string): void {
    this.db.prepare('UPDATE operations SET state=? WHERE id=?').run(state, id);
  }
  cachePurchase(id: string, body: unknown): void {
    this.db
      .prepare(
        'INSERT INTO purchases VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(id, canonical(body));
  }
  queueReply(id: string, parent: string, body: string): void {
    const existing = this.db
      .prepare('SELECT body FROM replies WHERE id=?')
      .get(id) as { body: string } | undefined;
    if (existing && existing.body !== body)
      throw new Fault('reply-identity-conflict');
    this.db
      .prepare('INSERT OR IGNORE INTO replies(id,parent,body) VALUES(?,?,?)')
      .run(id, parent, body);
  }
  reserveCall(
    id: string,
    maximum: number,
    limit: number,
    day = new Date().toISOString().slice(0, 10),
  ): void {
    this.db.transaction(() => {
      const spent = this.db
        .prepare(
          'SELECT coalesce(sum(coalesce(actual,reserved)),0) AS n FROM model_calls WHERE day=?',
        )
        .get(day) as { n: number };
      if (spent.n + maximum > limit) throw new Fault('model-daily-limit');
      this.db
        .prepare("INSERT INTO model_calls VALUES(?,?,?,NULL,'pending')")
        .run(id, day, maximum);
    })();
  }
  recordCall(id: string, actual: number | undefined): void {
    this.db
      .prepare("UPDATE model_calls SET actual=?,status='complete' WHERE id=?")
      .run(actual ?? null, id);
  }
  status(): unknown {
    return {
      jobs: this.db
        .prepare('SELECT state,count(*) AS count FROM jobs GROUP BY state')
        .all(),
      operations: this.db
        .prepare(
          'SELECT state,count(*) AS count FROM operations GROUP BY state',
        )
        .all(),
      replies: this.db
        .prepare(
          'SELECT count(*) AS pending,sum(CASE WHEN attempts>=8 THEN 1 ELSE 0 END) AS attention FROM replies WHERE delivered IS NULL',
        )
        .get(),
      contextRevision: this.revision(),
      lastActualRead: this.getMeta('last-actual-read') ?? null,
    };
  }
  fingerprint(): string {
    return hash(
      this.db.prepare('SELECT key,value FROM meta ORDER BY key').all(),
    );
  }
}
