import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import type { HouseholdContextMutation } from '../context/mutation.js';
import {
  materializeHouseholdContextMutation,
  plannedHouseholdContextOperationJsonSchema,
  plannedHouseholdContextOperationSchema,
  type PlannedHouseholdContextOperation,
} from '../context/plan.js';
import {
  createEmptyHouseholdProfile,
  type HouseholdProfile,
} from '../context/profile.js';
import type { HouseholdProfileRepositoryPort } from '../context/workflow.js';
import type { XaiFunctionTool } from '../model/xai-structured-client.js';
import {
  HouseholdContextIdentityConflictError,
  type HouseholdContextMutationStatus,
  type HouseholdContextStore,
} from '../storage/household-context-store.js';
import type { FinanceQuestionActionContext } from './xai-finance-agent.js';

const toolInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('change'),
    operations: z.array(plannedHouseholdContextOperationSchema).min(1).max(5),
  }),
  z.strictObject({
    action: z.literal('undo-latest'),
  }),
]);

const toolInputJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        action: { const: 'change' },
        operations: {
          type: 'array',
          items: plannedHouseholdContextOperationJsonSchema,
          minItems: 1,
          maxItems: 5,
        },
      },
      required: ['action', 'operations'],
      additionalProperties: false,
    },
    {
      type: 'object',
      description:
        'Undo only the single most recently saved household detail. Other details from the same message stay saved.',
      properties: {
        action: { const: 'undo-latest' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  ],
} as const satisfies Readonly<Record<string, unknown>>;

export type HouseholdContextToolStore = Pick<
  HouseholdContextStore,
  | 'recordMutation'
  | 'getMutationByMutationId'
  | 'listMutationsForMessage'
  | 'getMutationItem'
  | 'latestAppliedMutationAtOrBefore'
  | 'recordUndoIntent'
  | 'getUndoIntent'
>;

export interface HouseholdContextToolWorker {
  kick(): Promise<unknown>;
}

export interface HouseholdContextToolOptions {
  readonly store: HouseholdContextToolStore;
  readonly profileRepository: Pick<
    HouseholdProfileRepositoryPort,
    'read' | 'create'
  >;
  readonly worker: HouseholdContextToolWorker;
  readonly actionContext: FinanceQuestionActionContext;
  readonly timeZone?: string;
}

export interface BoundHouseholdContextTool {
  readonly tool: XaiFunctionTool;
  didHandleTalkReply(): boolean;
}

type ModelSafeStatus =
  | {
      readonly status: 'saved' | 'undone' | 'pending';
      readonly message: string;
    }
  | {
      readonly status: 'no-change' | 'not-saved';
      readonly message: string;
    };

async function readOrCreateProfile(
  repository: HouseholdContextToolOptions['profileRepository'],
  createdAt: string,
  timeZone: string,
  signal?: AbortSignal,
): Promise<HouseholdProfile> {
  const current = await repository.read(signal);
  if (current !== undefined) {
    return current.profile;
  }
  const empty = createEmptyHouseholdProfile(createdAt, timeZone);
  try {
    return (await repository.create(empty, signal)).profile;
  } catch (error) {
    const concurrentlyCreated = await repository.read(signal);
    if (concurrentlyCreated !== undefined) {
      return concurrentlyCreated.profile;
    }
    throw error;
  }
}

function mutationStatus(
  status: HouseholdContextMutationStatus,
): ModelSafeStatus {
  switch (status) {
    case 'applied':
      return {
        status: 'saved',
        message: 'That household detail was saved.',
      };
    case 'conflict':
      return {
        status: 'not-saved',
        message:
          'That detail was not saved because the household information changed. Nothing was overwritten.',
      };
    case 'failed':
      return {
        status: 'not-saved',
        message:
          'That household detail was not saved. Nothing was overwritten.',
      };
    case 'pending':
    case 'processing':
      return {
        status: 'pending',
        message: 'That household update is still being saved.',
      };
  }
}

function undoStatus(status: HouseholdContextMutationStatus): ModelSafeStatus {
  switch (status) {
    case 'applied':
      return {
        status: 'undone',
        message:
          'The most recent household detail was undone. Everything else was left alone.',
      };
    case 'conflict':
      return {
        status: 'no-change',
        message:
          'The latest household change could not be undone because the information changed afterward. Nothing was overwritten.',
      };
    case 'failed':
      return {
        status: 'no-change',
        message: 'The latest household change was not undone.',
      };
    case 'pending':
    case 'processing':
      return {
        status: 'pending',
        message: 'The latest household change is still being undone.',
      };
  }
}

function confirmedExplicitOperation(
  operation: PlannedHouseholdContextOperation,
): PlannedHouseholdContextOperation {
  if (
    operation.kind === 'remove-record' ||
    operation.kind === 'remove-policy'
  ) {
    return operation;
  }
  return plannedHouseholdContextOperationSchema.parse({
    ...operation,
    value: {
      ...operation.value,
      status: 'confirmed',
    },
  });
}

function comparableOperation(
  operation:
    PlannedHouseholdContextOperation | HouseholdContextMutation['operation'],
): unknown {
  if (
    operation.kind === 'remove-record' ||
    operation.kind === 'remove-policy'
  ) {
    return operation;
  }
  const value = { ...operation.value } as Record<string, unknown>;
  delete value.provenance;
  return { ...operation, value };
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Household context operation must contain JSON data');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Household context operation must contain JSON data');
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

interface CanonicalOperation {
  readonly operation: PlannedHouseholdContextOperation;
  readonly canonicalJson: string;
}

function canonicalOperations(
  operations: readonly PlannedHouseholdContextOperation[],
): readonly CanonicalOperation[] {
  const unique = new Map<string, CanonicalOperation>();
  for (const operation of operations) {
    const canonical = canonicalJson(comparableOperation(operation));
    unique.set(canonical, { operation, canonicalJson: canonical });
  }
  return [...unique.values()];
}

function operationSetDigest(operations: readonly CanonicalOperation[]): string {
  const hash = createHash('sha256').update(
    'household-finance.household-context-tool-batch.v2\0',
    'utf8',
  );
  for (const operation of [...operations].sort((left, right) =>
    left.canonicalJson.localeCompare(right.canonicalJson),
  )) {
    hash.update(operation.canonicalJson, 'utf8');
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

function operationIdentity(
  context: FinanceQuestionActionContext,
  batchDigest: string,
  canonicalOperationJson: string,
): {
  readonly idempotencyKey: string;
  readonly mutationId: string;
} {
  const digest = createHash('sha256')
    .update('household-finance.household-context-tool-operation.v2\0', 'utf8')
    .update(context.eventId, 'utf8')
    .update('\0', 'utf8')
    .update(batchDigest, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalOperationJson, 'utf8')
    .digest('hex');
  const variant = (
    (Number.parseInt(digest.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  const compactUuid = `${digest.slice(0, 12)}5${digest.slice(13, 16)}${variant}${digest.slice(17, 32)}`;
  return {
    idempotencyKey: `household-context-tool:change:v2:${batchDigest}:${digest}`,
    mutationId: `${compactUuid.slice(0, 8)}-${compactUuid.slice(8, 12)}-${compactUuid.slice(12, 16)}-${compactUuid.slice(16, 20)}-${compactUuid.slice(20, 32)}`,
  };
}

function savedBatchStatus(operationCount: number): ModelSafeStatus {
  return operationCount === 1
    ? {
        status: 'saved',
        message: 'That household detail was saved.',
      }
    : {
        status: 'saved',
        message: `${String(operationCount)} household details were saved.`,
      };
}

function stoppedBatchStatus(
  status: ModelSafeStatus,
  savedCount: number,
): ModelSafeStatus {
  if (savedCount === 0) {
    return status;
  }
  const prefix = `${String(savedCount)} household ${
    savedCount === 1 ? 'detail was' : 'details were'
  } saved.`;
  switch (status.status) {
    case 'pending':
      return {
        status: 'pending',
        message: `${prefix} The next update is still being saved.`,
      };
    case 'not-saved':
    case 'no-change':
      return {
        status: 'not-saved',
        message: `${prefix} The next detail was not saved, and nothing else was changed.`,
      };
    case 'saved':
    case 'undone':
      return status;
  }
}

function matchesRecordedOperation(
  record: ReturnType<HouseholdContextToolStore['getMutationByMutationId']>,
  operation: PlannedHouseholdContextOperation,
  identity: ReturnType<typeof operationIdentity>,
  context: FinanceQuestionActionContext,
): boolean {
  return (
    record !== undefined &&
    record.idempotencyKey === identity.idempotencyKey &&
    record.backendUrl === context.backendUrl &&
    record.roomToken === context.roomToken &&
    record.resultReplyEnabled === false &&
    record.mutation.mutationId === identity.mutationId &&
    record.mutation.actorId === context.actorId &&
    record.mutation.messageId === context.messageId &&
    record.mutation.requestedAt === context.receivedAt &&
    isDeepStrictEqual(
      comparableOperation(record.mutation.operation),
      comparableOperation(operation),
    )
  );
}

export function bindHouseholdContextTool(
  options: HouseholdContextToolOptions,
): BoundHouseholdContextTool {
  let ownsTalkReply = false;
  let stateChangeRequested = false;

  return {
    didHandleTalkReply: () => ownsTalkReply,
    tool: {
      name: 'update_household_context',
      description:
        'Save, correct, or remove 1 to 5 durable household facts as one batch, or separately undo only the single most recently saved household detail. Undo does not reverse the rest of a batch. Include every explicitly requested household-context change from the authenticated current message in one change call, and mark explicit saved facts confirmed rather than candidate. Do not use this tool for merchant categorization rules; use remember_merchant_category or the transaction tool when bundled with an explicit transaction edit. The service supplies identity, time, revision, provenance, and replay protection; never infer a fact from receipts, transactions, or conversation history.',
      parameters: toolInputJsonSchema,
      execute: async (untrusted, signal) => {
        const parsed = toolInputSchema.safeParse(untrusted);
        if (!parsed.success) {
          return {
            status: 'no-change',
            message:
              'That household update was not clear enough to save, so nothing changed.',
          } satisfies ModelSafeStatus;
        }
        if (stateChangeRequested) {
          return {
            status: 'no-change',
            message:
              'The household changes from this message were already handled, so no additional change was made.',
          } satisfies ModelSafeStatus;
        }

        const context = options.actionContext;
        if (parsed.data.action === 'undo-latest') {
          const original = options.store.latestAppliedMutationAtOrBefore(
            context.roomToken,
            context.receivedAt,
          );
          if (original === undefined) {
            return {
              status: 'no-change',
              message: 'There is no recent household change to undo.',
            } satisfies ModelSafeStatus;
          }
          stateChangeRequested = true;
          try {
            const recorded = options.store.recordUndoIntent(
              {
                idempotencyKey: `household-context-tool:undo:${context.idempotencyKey}`,
                originalEventId: original.id,
                actorId: context.actorId,
                messageId: context.messageId,
                requestedAt: context.receivedAt,
              },
              { enqueueAcknowledgement: false },
            );
            ownsTalkReply = true;
            await options.worker.kick();
            const current =
              options.store.getUndoIntent(recorded.intent.id) ??
              recorded.intent;
            return undoStatus(current.status);
          } catch (error) {
            if (error instanceof HouseholdContextIdentityConflictError) {
              return {
                status: 'no-change',
                message:
                  'That household change was already handled, so nothing else was changed.',
              } satisfies ModelSafeStatus;
            }
            throw error;
          }
        }

        stateChangeRequested = true;
        const operations = canonicalOperations(
          parsed.data.operations.map((operation) =>
            confirmedExplicitOperation(operation),
          ),
        );
        const batchDigest = operationSetDigest(operations);
        const requested = operations.map(({ operation, canonicalJson }) => ({
          operation,
          identity: operationIdentity(context, batchDigest, canonicalJson),
        }));
        const requestedByMutationId = new Map(
          requested.map((entry) => [entry.identity.mutationId, entry]),
        );
        const messageRecords = options.store.listMutationsForMessage(
          context.backendUrl,
          context.roomToken,
          context.actorId,
          context.messageId,
        );
        if (
          messageRecords.some((record) => {
            const expected = requestedByMutationId.get(
              record.mutation.mutationId,
            );
            return (
              expected === undefined ||
              !matchesRecordedOperation(
                record,
                expected.operation,
                expected.identity,
                context,
              )
            );
          })
        ) {
          return {
            status: 'no-change',
            message:
              'That message already saved different household information, so I left it alone.',
          } satisfies ModelSafeStatus;
        }

        if (messageRecords.length > 0) {
          await options.worker.kick();
        }

        let savedCount = 0;
        for (const record of messageRecords) {
          ownsTalkReply ||= record.resultReplyEnabled;
          const item = options.store.getMutationItem(record.id);
          const status =
            item === undefined
              ? ({
                  status: 'pending',
                  message: 'That household update is still being saved.',
                } satisfies ModelSafeStatus)
              : mutationStatus(item.status);
          if (status.status !== 'saved') {
            return stoppedBatchStatus(status, savedCount);
          }
          savedCount += 1;
        }

        for (const { operation, identity } of requested) {
          let record = options.store.getMutationByMutationId(
            identity.mutationId,
          );
          if (record !== undefined) {
            continue;
          }
          const profile = await readOrCreateProfile(
            options.profileRepository,
            context.receivedAt,
            options.timeZone ?? 'UTC',
            signal,
          );
          const mutation = materializeHouseholdContextMutation(
            operation,
            profile,
            {
              actorId: context.actorId,
              messageId: context.messageId,
              message: context.message,
              receivedAt: context.receivedAt,
            },
            identity.mutationId,
          );
          try {
            record = options.store.recordMutation(
              {
                idempotencyKey: identity.idempotencyKey,
                backendUrl: context.backendUrl,
                roomToken: context.roomToken,
                mutation,
              },
              {
                enqueueAcknowledgement: false,
                enqueueResultReply: false,
              },
            ).record;
          } catch (error) {
            if (!(error instanceof HouseholdContextIdentityConflictError)) {
              throw error;
            }
            record = options.store.getMutationByMutationId(identity.mutationId);
            if (
              !matchesRecordedOperation(record, operation, identity, context)
            ) {
              return stoppedBatchStatus(
                {
                  status: 'no-change',
                  message:
                    'That message already saved different household information, so I left it alone.',
                },
                savedCount,
              );
            }
          }

          if (record === undefined) {
            throw new Error('Household context mutation was not recorded');
          }
          ownsTalkReply ||= record.resultReplyEnabled;
          await options.worker.kick();
          const item = options.store.getMutationItem(record.id);
          const status =
            item === undefined
              ? ({
                  status: 'pending',
                  message: 'That household update is still being saved.',
                } satisfies ModelSafeStatus)
              : mutationStatus(item.status);
          if (status.status !== 'saved') {
            return stoppedBatchStatus(status, savedCount);
          }
          savedCount += 1;
        }
        return savedBatchStatus(savedCount);
      },
    },
  };
}
