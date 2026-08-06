import { describe, expect, it } from 'vitest';

import { createEmptyHouseholdProfile } from '../../src/context/profile.js';
import {
  HouseholdContextWorkflow,
  HouseholdContextWorker,
  type HouseholdProfileRepositoryPort,
} from '../../src/context/workflow.js';
import { bindHouseholdContextTool } from '../../src/questions/household-context-tools.js';
import type { FinanceQuestionActionContext } from '../../src/questions/xai-finance-agent.js';
import { HouseholdContextStore } from '../../src/storage/household-context-store.js';
import type {
  TalkDeliveredMessageIdentity,
  TalkReply,
} from '../../src/talk/client.js';

const firstInstant = '2026-07-28T12:00:00.000Z';
const firstContext: FinanceQuestionActionContext = {
  idempotencyKey: 'context-route:question:first',
  eventId: '2ba92388-d8d8-4c34-9be8-15dfe0ed99b9',
  backendUrl: 'https://cloud.example.test',
  roomToken: 'household-finance',
  actorId: 'alex',
  messageId: '34084',
  message: 'Remember that our minimum cash buffer is $2,000.',
  receivedAt: firstInstant,
};

class ProfileRepository implements HouseholdProfileRepositoryPort {
  #profile = createEmptyHouseholdProfile(firstInstant);
  #etag = '"profile-0"';

  async read(): Promise<
    | { profile: ReturnType<typeof createEmptyHouseholdProfile>; etag: string }
    | undefined
  > {
    return { profile: structuredClone(this.#profile), etag: this.#etag };
  }

  async create(
    profile: ReturnType<typeof createEmptyHouseholdProfile>,
  ): Promise<{
    profile: ReturnType<typeof createEmptyHouseholdProfile>;
    etag: string;
  }> {
    this.#profile = structuredClone(profile);
    return { profile: structuredClone(this.#profile), etag: this.#etag };
  }

  async replace(
    expectedEtag: string,
    profile: ReturnType<typeof createEmptyHouseholdProfile>,
  ): Promise<{
    profile: ReturnType<typeof createEmptyHouseholdProfile>;
    etag: string;
  }> {
    if (expectedEtag !== this.#etag) {
      throw new Error('conflict');
    }
    this.#profile = structuredClone(profile);
    this.#etag = `"profile-${String(profile.revision)}"`;
    return { profile: structuredClone(this.#profile), etag: this.#etag };
  }

  profile(): ReturnType<typeof createEmptyHouseholdProfile> {
    return structuredClone(this.#profile);
  }
}

class Talk {
  readonly replies: TalkReply[] = [];

  async sendReplyWithIdentity(
    reply: TalkReply,
  ): Promise<TalkDeliveredMessageIdentity> {
    this.replies.push(reply);
    return {
      roomToken: reply.roomToken,
      botActorId: `bots/bot-${'a'.repeat(40)}`,
      messageId: reply.replyTo ?? '1',
      referenceId: reply.referenceId,
      ...(reply.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
    };
  }
}

function runtime() {
  const store = new HouseholdContextStore(':memory:');
  const repository = new ProfileRepository();
  const talk = new Talk();
  const worker = new HouseholdContextWorker(
    new HouseholdContextWorkflow({
      store,
      profileRepository: repository,
      talk,
      now: () => new Date('2026-07-28T13:00:00.000Z'),
    }),
  );
  return { store, repository, talk, worker };
}

const bufferOperation = {
  kind: 'set-money-policy' as const,
  policy: 'minimumCashBufferMinorUnits' as const,
  value: {
    status: 'confirmed' as const,
    value: 200_000,
  },
};

const emergencyFundOperation = {
  kind: 'set-money-policy' as const,
  policy: 'emergencyFundTargetMinorUnits' as const,
  value: {
    status: 'confirmed' as const,
    value: 1_000_000,
  },
};

const riskOperation = {
  kind: 'set-risk-policy' as const,
  policy: 'safeBudgetRiskPreference' as const,
  value: {
    status: 'confirmed' as const,
    value: 'balanced' as const,
  },
};

describe('household context tool', () => {
  it('binds authority fields locally and applies one durable mutation', async () => {
    const value = runtime();
    const binding = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });

    expect(JSON.stringify(binding.tool.parameters)).not.toMatch(
      /actorId|messageId|receivedAt|expectedRevision|mutationId|idempotencyKey/,
    );
    expect(JSON.stringify(binding.tool.parameters)).toContain(
      'Undo only the single most recently saved household detail',
    );
    expect(binding.tool.description).toContain(
      'Undo does not reverse the rest of a batch',
    );
    const changeParameters = (
      binding.tool.parameters as {
        oneOf: Array<{
          properties?: {
            operations?: { minItems?: number; maxItems?: number };
          };
        }>;
      }
    ).oneOf[0];
    expect(changeParameters?.properties?.operations).toMatchObject({
      minItems: 1,
      maxItems: 5,
    });
    await expect(
      binding.tool.execute({
        action: 'change',
        operations: [bufferOperation],
        actorId: 'sam',
      }),
    ).resolves.toMatchObject({ status: 'no-change' });
    expect(binding.didHandleTalkReply()).toBe(false);

    await expect(
      binding.tool.execute({
        action: 'change',
        operations: [bufferOperation],
      }),
    ).resolves.toEqual({
      status: 'saved',
      message: 'That household detail was saved.',
    });
    expect(binding.didHandleTalkReply()).toBe(false);
    expect(
      value.repository.profile().policies.minimumCashBufferMinorUnits,
    ).toMatchObject({
      value: 200_000,
      provenance: {
        actorId: 'alex',
        messageId: '34084',
        recordedAt: firstInstant,
      },
    });
    const record = value.store.latestAppliedMutationAtOrBefore(
      firstContext.roomToken,
      firstContext.receivedAt,
    );
    expect(record?.mutation).toMatchObject({
      expectedRevision: 0,
      actorId: firstContext.actorId,
      messageId: firstContext.messageId,
      requestedAt: firstContext.receivedAt,
    });
    expect(record?.mutation.mutationId).not.toBe(firstContext.eventId);
    expect(record?.resultReplyEnabled).toBe(false);
    expect(value.talk.replies).toHaveLength(0);
    value.store.close();
  });

  it('applies an ordered batch of household details from one message', async () => {
    const value = runtime();
    const binding = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });

    await expect(
      binding.tool.execute({
        action: 'change',
        operations: [bufferOperation, emergencyFundOperation, riskOperation],
      }),
    ).resolves.toEqual({
      status: 'saved',
      message: '3 household details were saved.',
    });

    expect(value.repository.profile()).toMatchObject({
      revision: 3,
      policies: {
        minimumCashBufferMinorUnits: { value: 200_000 },
        emergencyFundTargetMinorUnits: { value: 1_000_000 },
        safeBudgetRiskPreference: { value: 'balanced' },
      },
    });
    expect(value.talk.replies).toHaveLength(0);
    value.store.close();
  });

  it('resumes a partially recorded batch without applying an operation twice', async () => {
    const value = runtime();
    let kicks = 0;
    const interrupted = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      worker: {
        async kick() {
          kicks += 1;
          if (kicks === 2) {
            throw new Error('simulated process interruption');
          }
          return await value.worker.kick();
        },
      },
      actionContext: firstContext,
    });
    const operations = [bufferOperation, emergencyFundOperation, riskOperation];

    await expect(
      interrupted.tool.execute({ action: 'change', operations }),
    ).rejects.toThrow('simulated process interruption');
    expect(value.repository.profile()).toMatchObject({
      revision: 1,
      policies: {
        minimumCashBufferMinorUnits: { value: 200_000 },
      },
    });

    const replay = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });
    await expect(
      replay.tool.execute({
        action: 'change',
        operations: [riskOperation, bufferOperation, emergencyFundOperation],
      }),
    ).resolves.toEqual({
      status: 'saved',
      message: '3 household details were saved.',
    });
    expect(value.repository.profile()).toMatchObject({
      revision: 3,
      policies: {
        minimumCashBufferMinorUnits: { value: 200_000 },
        emergencyFundTargetMinorUnits: { value: 1_000_000 },
        safeBudgetRiskPreference: { value: 'balanced' },
      },
    });
    value.store.close();
  });

  it('deduplicates identical facts from one model call', async () => {
    const value = runtime();
    const binding = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });

    await expect(
      binding.tool.execute({
        action: 'change',
        operations: [bufferOperation, bufferOperation, bufferOperation],
      }),
    ).resolves.toEqual({
      status: 'saved',
      message: 'That household detail was saved.',
    });
    expect(value.repository.profile()).toMatchObject({
      revision: 1,
      policies: {
        minimumCashBufferMinorUnits: { value: 200_000 },
      },
    });
    expect(
      value.store.listMutationsForMessage(
        firstContext.backendUrl,
        firstContext.roomToken,
        firstContext.actorId,
        firstContext.messageId,
      ),
    ).toHaveLength(1);
    value.store.close();
  });

  it('makes an accepted explicit fact active even when the model marks it candidate', async () => {
    const value = runtime();
    const binding = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });

    await expect(
      binding.tool.execute({
        action: 'change',
        operations: [
          {
            ...bufferOperation,
            value: {
              status: 'candidate',
              value: 200_000,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ status: 'saved' });

    expect(
      value.repository.profile().policies.minimumCashBufferMinorUnits,
    ).toMatchObject({
      status: 'confirmed',
      value: 200_000,
    });
    const record = value.store.latestAppliedMutationAtOrBefore(
      firstContext.roomToken,
      firstContext.receivedAt,
    );
    expect(record?.mutation.operation).toMatchObject({
      kind: 'set-money-policy',
      value: {
        status: 'confirmed',
      },
    });
    value.store.close();
  });

  it('replays the same authenticated change without applying or replying twice', async () => {
    const value = runtime();
    const first = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });
    await first.tool.execute({
      action: 'change',
      operations: [bufferOperation],
    });

    const replay = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });
    await expect(
      replay.tool.execute({
        action: 'change',
        operations: [bufferOperation],
      }),
    ).resolves.toEqual({
      status: 'saved',
      message: 'That household detail was saved.',
    });
    expect(replay.didHandleTalkReply()).toBe(false);
    expect(value.repository.profile().revision).toBe(1);
    expect(value.talk.replies).toHaveLength(0);
    value.store.close();
  });

  it('does not report a different retry from the same message as saved', async () => {
    const value = runtime();
    await bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    }).tool.execute({
      action: 'change',
      operations: [bufferOperation],
    });

    const retry = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });
    await expect(
      retry.tool.execute({
        action: 'change',
        operations: [
          {
            ...bufferOperation,
            value: { status: 'confirmed', value: 300_000 },
          },
        ],
      }),
    ).resolves.toEqual({
      status: 'no-change',
      message:
        'That message already saved different household information, so I left it alone.',
    });
    expect(retry.didHandleTalkReply()).toBe(false);
    expect(
      value.repository.profile().policies.minimumCashBufferMinorUnits?.value,
    ).toBe(200_000);
    value.store.close();
  });

  it('allows only one state change from one bound message', async () => {
    const value = runtime();
    const binding = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });
    await binding.tool.execute({
      action: 'change',
      operations: [bufferOperation],
    });
    await expect(
      binding.tool.execute({
        action: 'change',
        operations: [
          {
            ...bufferOperation,
            value: { status: 'confirmed', value: 300_000 },
          },
        ],
      }),
    ).resolves.toEqual({
      status: 'no-change',
      message:
        'The household changes from this message were already handled, so no additional change was made.',
    });
    expect(
      value.repository.profile().policies.minimumCashBufferMinorUnits?.value,
    ).toBe(200_000);
    value.store.close();
  });

  it('undoes the latest applied change using only authenticated turn identity', async () => {
    const value = runtime();
    await bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    }).tool.execute({
      action: 'change',
      operations: [bufferOperation],
    });
    const undoContext: FinanceQuestionActionContext = {
      ...firstContext,
      idempotencyKey: 'context-route:question:undo',
      eventId: '90f94a29-c970-475d-8b35-ff32d222b62f',
      messageId: '34085',
      message: 'Undo that household change.',
      receivedAt: '2026-07-28T12:01:00.000Z',
    };
    const undo = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: undoContext,
    });

    await expect(undo.tool.execute({ action: 'undo-latest' })).resolves.toEqual(
      {
        status: 'undone',
        message:
          'The most recent household detail was undone. Everything else was left alone.',
      },
    );
    expect(undo.didHandleTalkReply()).toBe(true);
    expect(
      value.repository.profile().policies.minimumCashBufferMinorUnits,
    ).toBeUndefined();
    expect(value.talk.replies).toHaveLength(1);
    value.store.close();
  });

  it('plainly undoes only the newest detail from a saved batch', async () => {
    const value = runtime();
    await bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    }).tool.execute({
      action: 'change',
      operations: [bufferOperation, emergencyFundOperation, riskOperation],
    });
    const undo = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: {
        ...firstContext,
        idempotencyKey: 'context-route:question:undo-batch',
        eventId: '7c25b56a-976b-4f04-a855-386aeb899fc1',
        messageId: '34086',
        message: 'Undo that.',
        receivedAt: '2026-07-28T12:02:00.000Z',
      },
    });

    await expect(undo.tool.execute({ action: 'undo-latest' })).resolves.toEqual(
      {
        status: 'undone',
        message:
          'The most recent household detail was undone. Everything else was left alone.',
      },
    );
    expect(value.repository.profile()).toMatchObject({
      revision: 4,
      policies: {
        minimumCashBufferMinorUnits: { value: 200_000 },
        emergencyFundTargetMinorUnits: { value: 1_000_000 },
      },
    });
    expect(
      value.repository.profile().policies.safeBudgetRiskPreference,
    ).toBeUndefined();
    expect(value.talk.replies.at(-1)?.message).toBe(
      'Done — I undid the most recent household detail. Everything else was left alone.',
    );
    value.store.close();
  });

  it('undoes repeated batch details one at a time', async () => {
    const value = runtime();
    await bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    }).tool.execute({
      action: 'change',
      operations: [bufferOperation, emergencyFundOperation, riskOperation],
    });

    const firstUndo = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: {
        ...firstContext,
        idempotencyKey: 'context-route:question:undo-batch-first',
        eventId: '7c25b56a-976b-4f04-a855-386aeb899fc1',
        messageId: '34086',
        message: 'Undo that.',
        receivedAt: '2026-07-28T12:02:00.000Z',
      },
    });
    const secondUndo = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: {
        ...firstContext,
        idempotencyKey: 'context-route:question:undo-batch-second',
        eventId: '72481d40-f57b-4277-8d50-b6f7c353bcc9',
        messageId: '34087',
        message: 'Undo that too.',
        receivedAt: '2026-07-28T12:03:00.000Z',
      },
    });

    await expect(
      firstUndo.tool.execute({ action: 'undo-latest' }),
    ).resolves.toMatchObject({ status: 'undone' });
    await expect(
      secondUndo.tool.execute({ action: 'undo-latest' }),
    ).resolves.toMatchObject({ status: 'undone' });
    expect(value.repository.profile()).toMatchObject({
      revision: 5,
      policies: {
        minimumCashBufferMinorUnits: { value: 200_000 },
      },
    });
    expect(
      value.repository.profile().policies.emergencyFundTargetMinorUnits,
    ).toBeUndefined();
    expect(
      value.repository.profile().policies.safeBudgetRiskPreference,
    ).toBeUndefined();
    expect(value.talk.replies).toHaveLength(2);
    value.store.close();
  });

  it('does nothing and owns no Talk reply when there is no undo target', async () => {
    const value = runtime();
    const binding = bindHouseholdContextTool({
      ...value,
      profileRepository: value.repository,
      actionContext: firstContext,
    });

    await expect(
      binding.tool.execute({ action: 'undo-latest' }),
    ).resolves.toEqual({
      status: 'no-change',
      message: 'There is no recent household change to undo.',
    });
    expect(binding.didHandleTalkReply()).toBe(false);
    expect(value.talk.replies).toHaveLength(0);
    value.store.close();
  });
});
