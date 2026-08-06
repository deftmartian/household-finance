import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  materializeHouseholdContextMutation,
  type PlannedHouseholdContextOperation,
} from '../../src/context/plan.js';
import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from '../../src/context/profile.js';
import {
  HouseholdContextWorker,
  HouseholdContextWorkflow,
  type HouseholdProfileRepositoryPort,
} from '../../src/context/workflow.js';
import type { HouseholdProfileSnapshot } from '../../src/nextcloud/webdav-household-profile.js';
import {
  HouseholdContextStore,
  type HouseholdContextMutationRecord,
} from '../../src/storage/household-context-store.js';
import type {
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../../src/talk/client.js';

const start = '2026-07-28T01:00:00.000Z';
const undoAt = '2026-07-28T01:05:00.000Z';
const backendUrl = 'https://cloud.example.test';
const roomToken = 'household-finance';

const bufferOperation = {
  kind: 'set-money-policy',
  policy: 'minimumCashBufferMinorUnits',
  value: {
    status: 'confirmed',
    value: 100_000,
  },
} satisfies PlannedHouseholdContextOperation;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(filename: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'context-workflow-'));
  temporaryDirectories.push(directory);
  return join(directory, filename);
}

class TestClock {
  #value: Date;

  constructor(initial = start) {
    this.#value = new Date(initial);
  }

  readonly now = (): Date => new Date(this.#value);

  advanceSeconds(seconds: number): void {
    this.#value = new Date(this.#value.valueOf() + seconds * 1_000);
  }

  set(value: string): void {
    this.#value = new Date(value);
  }
}

class ProfilePortTestError extends Error {
  constructor(readonly code: string) {
    super(`Profile test failure: ${code}`);
  }
}

class FakeProfileRepository implements HouseholdProfileRepositoryPort {
  #snapshot: HouseholdProfileSnapshot | undefined;
  #etagVersion = 0;
  readError: Error | undefined;
  createError: Error | undefined;
  replaceError: Error | undefined;
  readCalls = 0;
  createCalls = 0;
  replaceCalls = 0;

  constructor(initial?: HouseholdProfile) {
    if (initial !== undefined) {
      this.#etagVersion = 1;
      this.#snapshot = {
        profile: structuredClone(initial),
        etag: '"etag-1"',
      };
    }
  }

  async read(): Promise<HouseholdProfileSnapshot | undefined> {
    this.readCalls += 1;
    if (this.readError !== undefined) {
      throw this.readError;
    }
    return this.#snapshot === undefined
      ? undefined
      : structuredClone(this.#snapshot);
  }

  async create(profile: HouseholdProfile): Promise<HouseholdProfileSnapshot> {
    this.createCalls += 1;
    if (this.createError !== undefined) {
      throw this.createError;
    }
    if (this.#snapshot !== undefined) {
      throw new ProfilePortTestError('conflict');
    }
    this.#etagVersion += 1;
    this.#snapshot = {
      profile: structuredClone(profile),
      etag: `"etag-${String(this.#etagVersion)}"`,
    };
    return structuredClone(this.#snapshot);
  }

  async replace(
    expectedEtag: string,
    profile: HouseholdProfile,
  ): Promise<HouseholdProfileSnapshot> {
    this.replaceCalls += 1;
    if (this.replaceError !== undefined) {
      throw this.replaceError;
    }
    if (this.#snapshot === undefined || this.#snapshot.etag !== expectedEtag) {
      throw new ProfilePortTestError('conflict');
    }
    this.#etagVersion += 1;
    this.#snapshot = {
      profile: structuredClone(profile),
      etag: `"etag-${String(this.#etagVersion)}"`,
    };
    return structuredClone(this.#snapshot);
  }

  forceProfile(profile: HouseholdProfile): void {
    this.#etagVersion += 1;
    this.#snapshot = {
      profile: structuredClone(profile),
      etag: `"etag-${String(this.#etagVersion)}"`,
    };
  }

  profile(): HouseholdProfile | undefined {
    return this.#snapshot === undefined
      ? undefined
      : structuredClone(this.#snapshot.profile);
  }
}

class RecordingTalk {
  readonly replies: TalkReply[] = [];
  readonly deliveries = new Map<string, TalkReply>();
  gate: Promise<void> | undefined;

  async sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity> {
    if (this.gate !== undefined) {
      await this.gate;
    }
    if (!this.deliveries.has(reply.referenceId)) {
      const saved = structuredClone(reply);
      this.deliveries.set(reply.referenceId, saved);
      this.replies.push(saved);
    }
    return {
      roomToken: reply.roomToken,
      botActorId: `bots/bot-${'a'.repeat(40)}`,
      messageId: reply.replyTo ?? '1',
      referenceId: reply.referenceId,
      ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    };
  }
}

function householdWorkflow(options: {
  store: HouseholdContextStore;
  repository: FakeProfileRepository;
  talk: RecordingTalk;
  clock?: TestClock;
}): HouseholdContextWorkflow {
  return new HouseholdContextWorkflow({
    store: options.store,
    profileRepository: options.repository,
    talk: options.talk,
    ...(options.clock === undefined ? {} : { now: options.clock.now }),
  });
}

function recordMutation(
  store: HouseholdContextStore,
  profile: HouseholdProfile,
  options: {
    id?: string;
    messageId?: string;
    receivedAt?: string;
    enqueueResultReply?: boolean;
  } = {},
): HouseholdContextMutationRecord {
  const id = options.id ?? '11111111-1111-4111-8111-111111111111';
  const messageId = options.messageId ?? '100';
  const receivedAt = options.receivedAt ?? start;
  const mutation = materializeHouseholdContextMutation(
    bufferOperation,
    profile,
    {
      actorId: 'alex',
      messageId,
      message: 'Keep at least $1,000 in chequing.',
      receivedAt,
    },
    id,
  );
  return store.recordMutation(
    {
      idempotencyKey: `household-context-tool:change:${id}`,
      backendUrl,
      roomToken,
      mutation,
    },
    {
      enqueueAcknowledgement: false,
      ...(options.enqueueResultReply === undefined
        ? {}
        : { enqueueResultReply: options.enqueueResultReply }),
    },
  ).record;
}

describe('HouseholdContextWorkflow', () => {
  it('applies a mutation through WebDAV CAS and persists the result', async () => {
    const store = new HouseholdContextStore(':memory:');
    const repository = new FakeProfileRepository();
    const talk = new RecordingTalk();
    const record = recordMutation(store, createEmptyHouseholdProfile(start));

    expect(
      await householdWorkflow({ store, repository, talk }).processAvailable(),
    ).toBe(2);

    expect(repository.createCalls).toBe(1);
    expect(repository.replaceCalls).toBe(1);
    expect(repository.profile()).toMatchObject({
      revision: 1,
      policies: {
        minimumCashBufferMinorUnits: {
          status: 'confirmed',
          value: 100_000,
        },
      },
    });
    expect(store.getMutationItem(record.id)).toMatchObject({
      status: 'applied',
      beforeSnapshot: { revision: 0 },
      afterSnapshot: { revision: 1 },
    });
    expect(talk.replies.at(-1)?.message).toBe(
      'Done — I updated what I remember about your household. Say “undo that” if anything looks wrong.',
    );
    store.close();
  });

  it('records a revision conflict and leaves the concurrent profile untouched', async () => {
    const store = new HouseholdContextStore(':memory:');
    const repository = new FakeProfileRepository();
    const talk = new RecordingTalk();
    const initial = createEmptyHouseholdProfile(start);
    const record = recordMutation(store, initial);
    const concurrent = createEmptyHouseholdProfile(start);
    concurrent.revision = 1;
    concurrent.updatedAt = '2026-07-28T01:00:30.000Z';
    repository.forceProfile(concurrent);

    expect(
      await householdWorkflow({ store, repository, talk }).processAvailable(),
    ).toBe(2);

    expect(store.getMutationItem(record.id)).toMatchObject({
      status: 'conflict',
      observedRevision: 1,
      errorCode: 'revision-conflict',
    });
    expect(repository.replaceCalls).toBe(0);
    expect(repository.profile()).toEqual(concurrent);
    expect(talk.replies.at(-1)?.message).toBe(
      'I didn’t save that update because your household details changed while I was working. Nothing was overwritten. Please send the update again.',
    );
    store.close();
  });

  it('applies an explicit undo and restores the prior snapshot through CAS', async () => {
    const store = new HouseholdContextStore(':memory:');
    const repository = new FakeProfileRepository(
      createEmptyHouseholdProfile(start),
    );
    const talk = new RecordingTalk();
    const clock = new TestClock();
    const record = recordMutation(
      store,
      repository.profile() ?? createEmptyHouseholdProfile(start),
    );
    const workflow = householdWorkflow({ store, repository, talk, clock });

    expect(await workflow.processAvailable()).toBe(2);
    clock.set(undoAt);
    const undo = store.recordUndoIntent(
      {
        idempotencyKey: 'household-context-tool:undo:test',
        originalEventId: record.id,
        actorId: 'alex',
        messageId: '200',
        requestedAt: undoAt,
      },
      { enqueueAcknowledgement: false },
    ).intent;

    expect(await workflow.processAvailable()).toBe(2);
    expect(repository.profile()).toMatchObject({
      revision: 2,
      policies: {},
    });
    expect(store.getUndoIntent(undo.id)).toMatchObject({
      status: 'applied',
      originalEventId: record.id,
      targetSnapshot: { revision: 2, policies: {} },
    });
    expect(talk.replies.at(-1)?.message).toBe(
      'Done — I undid the most recent household detail. Everything else was left alone.',
    );
    store.close();
  });

  it('bounds WebDAV replace retries and persists failure before its result reply', async () => {
    const store = new HouseholdContextStore(':memory:');
    const repository = new FakeProfileRepository(
      createEmptyHouseholdProfile(start),
    );
    repository.replaceError = new ProfilePortTestError('write-failed');
    const talk = new RecordingTalk();
    const clock = new TestClock();
    const record = recordMutation(
      store,
      repository.profile() ?? createEmptyHouseholdProfile(start),
    );
    const workflow = householdWorkflow({ store, repository, talk, clock });

    expect(await workflow.processAvailable()).toBe(1);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      clock.advanceSeconds(2 ** attempt);
      await workflow.processAvailable();
    }

    expect(repository.replaceCalls).toBe(5);
    expect(store.getMutationItem(record.id)).toMatchObject({
      status: 'failed',
      errorCode: 'profile-write-failed',
      beforeSnapshot: { revision: 0 },
      afterSnapshot: { revision: 1 },
    });
    expect(
      store
        .listMutationAudit(record.id)
        .filter(
          (entry) => entry.action === 'context.mutation-snapshots-prepared',
        ),
    ).toHaveLength(1);
    expect(talk.replies.at(-1)?.message).toBe(
      'I couldn’t save that household detail. Nothing was changed. Please try again in a moment.',
    );
    store.close();
  });

  it('recovers after the CAS write without replacing an already-applied profile twice', async () => {
    const contextPath = databasePath('context.sqlite');
    const repository = new FakeProfileRepository(
      createEmptyHouseholdProfile(start),
    );
    const firstStore = new HouseholdContextStore(contextPath);
    const record = recordMutation(
      firstStore,
      repository.profile() ?? createEmptyHouseholdProfile(start),
    );
    const apply = firstStore.claimNextOutbox(start);
    const snapshot = await repository.read();
    const prepared = firstStore.prepareMutationApply(
      record.id,
      snapshot?.profile ?? createEmptyHouseholdProfile(start),
      start,
    );
    await repository.replace(
      snapshot?.etag ?? '"missing"',
      prepared.targetProfile,
    );
    expect(apply).toMatchObject({ kind: 'apply-context-mutation' });
    firstStore.close();

    const restarted = new HouseholdContextStore(contextPath);
    expect(restarted.recoverInterruptedOutbox(start)).toBe(1);
    const talk = new RecordingTalk();
    expect(
      await householdWorkflow({
        store: restarted,
        repository,
        talk,
      }).processAvailable(),
    ).toBe(2);
    expect(repository.replaceCalls).toBe(1);
    expect(restarted.getMutationItem(record.id)).toMatchObject({
      status: 'applied',
      afterSnapshot: repository.profile(),
    });
    expect(talk.replies).toHaveLength(1);
    restarted.close();
  });

  it('reconciles a Talk reply after delivery succeeds but outbox completion crashes', async () => {
    const store = new HouseholdContextStore(':memory:');
    const repository = new FakeProfileRepository(
      createEmptyHouseholdProfile(start),
    );
    const talk = new RecordingTalk();
    const clock = new TestClock();
    recordMutation(
      store,
      repository.profile() ?? createEmptyHouseholdProfile(start),
    );
    const complete = store.completeTalkReplyOutbox.bind(store);
    vi.spyOn(store, 'completeTalkReplyOutbox')
      .mockImplementationOnce(() => {
        throw new Error('simulated crash after Talk accepted the reply');
      })
      .mockImplementation((jobId, referenceId, completedAt) =>
        complete(jobId, referenceId, completedAt),
      );
    const workflow = householdWorkflow({ store, repository, talk, clock });

    expect(await workflow.processAvailable()).toBe(2);
    expect(talk.replies).toHaveLength(1);

    clock.advanceSeconds(2);
    expect(await workflow.processAvailable()).toBe(1);
    expect(talk.replies).toHaveLength(1);
    expect(talk.deliveries.size).toBe(1);
    store.close();
  });

  it('serializes concurrent worker kicks', async () => {
    const store = new HouseholdContextStore(':memory:');
    const repository = new FakeProfileRepository(
      createEmptyHouseholdProfile(start),
    );
    const talk = new RecordingTalk();
    let releaseTalk: (() => void) | undefined;
    talk.gate = new Promise<void>((resolve) => {
      releaseTalk = resolve;
    });
    recordMutation(
      store,
      repository.profile() ?? createEmptyHouseholdProfile(start),
    );
    const worker = new HouseholdContextWorker(
      householdWorkflow({ store, repository, talk }),
    );

    const firstKick = worker.kick();
    const secondKick = worker.kick();
    expect(secondKick).toBe(firstKick);
    releaseTalk?.();
    await firstKick;
    expect(repository.replaceCalls).toBe(1);
    store.close();
  });

  it('drains work requested while an existing kick is still running', async () => {
    let releaseFirstRun: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let runs = 0;
    const worker = new HouseholdContextWorker({
      async processAvailable() {
        runs += 1;
        if (runs === 1) {
          await firstRunGate;
        }
        return 0;
      },
    } as unknown as HouseholdContextWorkflow);

    const firstKick = worker.kick();
    const joinedKick = worker.kick();
    expect(joinedKick).toBe(firstKick);
    releaseFirstRun?.();
    await firstKick;

    expect(runs).toBe(2);
  });
});
