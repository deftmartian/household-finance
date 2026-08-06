import { join } from 'node:path';

import {
  ActualDeterministicTransactionHttpClient,
  ActualReadHttpClient,
  BankSyncScheduler,
} from './actual-read/index.js';
import {
  ReceiptNoteEnvelopeAuthenticator,
  ReceiptNoteOutboxStore,
} from './actual-receipt-note/index.js';
import {
  ActualUpdateEnvelopeAuthenticator,
  ActualUpdateTalkDecisionHandler,
  ActualUpdateTalkInteractionWorker,
  ActualUpdateWorkflow,
  type SafeActualUpdateWriter,
} from './actual-update/index.js';
import { ConversationalTransactionEditAdapter } from './actual-update/conversational-edit-adapter.js';
import {
  ActualReceiptMatchUpdateApplier,
  ActualTransactionCategorizationObservationSource,
  ActualTransactionCategoryUpdateSink,
  ReceiptCategorizationWorker,
  ReceiptCategorizationWorkflow,
  ReceiptMatchAmbiguityTalkWorker,
  ReceiptMatchStoreCategorizationPublisher,
  TalkClarificationHandler,
  TransactionCategorizationWorker,
  TransactionCategorizationWorkflow,
  XaiReceiptItemCategoryClassifier,
  XaiTransactionCategoryClassifier,
} from './categorization/index.js';
import type { ProductionAppConfig } from './config.js';
import {
  HouseholdContextWorker,
  HouseholdContextWorkflow,
} from './context/index.js';
import { RemoteReceiptDocumentPreparer } from './documents/remote-receipt-document-preparer.js';
import type { ProductionHttpDependencies } from './http.js';
import {
  XaiResponsesReceiptAdapter,
  XaiSpeechToTextTranscriber,
  XaiStructuredClient,
} from './model/index.js';
import {
  WebDavCategoryTaxonomySource,
  WebDavFileSource,
  WebDavHouseholdProfileRepository,
  WebDavOriginalArchive,
} from './nextcloud/index.js';
import { conversationalActualWriteTools } from './questions/actual-write-tools.js';
import { costcoItemLookupTool } from './questions/costco-item-lookup-tool.js';
import { currentReceiptReadTool } from './questions/current-receipt-tools.js';
import { bindHouseholdContextTool } from './questions/household-context-tools.js';
import { pendingReceiptReadTool } from './questions/pending-receipt-tools.js';
import {
  receiptIgnoreTool,
  receiptReplyAncestryMessageIds,
} from './questions/receipt-discard-tools.js';
import { receiptHouseholdNoteTool } from './questions/receipt-household-note-tools.js';
import { recentReceiptReadTool } from './questions/recent-receipt-tools.js';
import {
  FinanceQuestionWorker,
  FinanceQuestionWorkflow,
} from './questions/workflow.js';
import { XaiFinanceQuestionAgent } from './questions/xai-finance-agent.js';
import {
  CanonicalReceiptRecordHydrator,
  CanonicalReceiptRecordProjectionSource,
  ReceiptRecordPublicationWorkflow,
} from './receipts/record-projection.js';
import { ReceiptRecordPublisher } from './receipts/publication.js';
import {
  ActualUpdateIntentStore,
  ActualUpdateTalkStore,
  AttachmentShadowStore,
  HouseholdContextStore,
  QuestionStore,
  ReceiptCategorizationStore,
  ReceiptMatchStore,
  TransactionCategorizationStore,
} from './storage/index.js';
import { TalkBotClient } from './talk/index.js';
import {
  AttachmentShadowOutboxWorker,
  AttachmentShadowWorkflow,
  type NamedWorkerKick,
  ReceiptPipelineReconciler,
  runWorkerKicksInOrder,
} from './workflow/index.js';

const unavailableFinanceBotWriter = {
  update: (): never => {
    throw new Error(
      'The finance-bot cannot execute Actual writes; only the isolated writer may process intents',
    );
  },
  undo: (): never => {
    throw new Error(
      'The finance-bot cannot execute Actual undo; only the isolated writer may process intents',
    );
  },
} satisfies SafeActualUpdateWriter;

async function kickWorkersSafely(
  context: string,
  workers: readonly NamedWorkerKick[],
): Promise<void> {
  const { failures } = await runWorkerKicksInOrder(workers);
  if (failures.length > 0) {
    process.stderr.write(
      `${context} worker kicks failed safely: ${failures.join(',')}\n`,
    );
  }
}

export function createProductionWorkerKickPlan(input: {
  readonly receiptMatchWakeup: NamedWorkerKick;
  readonly primaryWorkers: readonly NamedWorkerKick[];
  readonly receiptLedgerWorkers: readonly NamedWorkerKick[];
  readonly transactionCategorization: NamedWorkerKick;
  readonly questions: NamedWorkerKick;
}): {
  readonly initial: readonly NamedWorkerKick[];
  readonly outboxPoll: readonly NamedWorkerKick[];
  readonly transactionCategorizationPoll: readonly NamedWorkerKick[];
  readonly postBankSync: readonly NamedWorkerKick[];
} {
  return {
    initial: [
      input.receiptMatchWakeup,
      ...input.primaryWorkers,
      input.transactionCategorization,
    ],
    outboxPoll: input.primaryWorkers,
    transactionCategorizationPoll: [
      ...input.receiptLedgerWorkers,
      input.transactionCategorization,
    ],
    postBankSync: [
      input.receiptMatchWakeup,
      input.questions,
      ...input.receiptLedgerWorkers,
      input.transactionCategorization,
    ],
  };
}

export interface ProductionRuntime {
  readonly httpDependencies: ProductionHttpDependencies;
  startBackgroundWork(): void;
  beginShutdown(): void;
  stopBankSync(): Promise<void>;
  drainWorkers(): Promise<void>;
  close(): void;
}

export function createProductionRuntime(
  config: ProductionAppConfig,
): ProductionRuntime {
  const abortController = new AbortController();
  const cleanups: Array<() => void> = [];
  let resourcesClosed = false;

  const own = <T>(resource: T, close: (resource: T) => void): T => {
    cleanups.push(() => close(resource));
    return resource;
  };
  const close = (): void => {
    if (resourcesClosed) {
      return;
    }
    resourcesClosed = true;
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Finance-bot persistent resource cleanup failed',
      );
    }
  };

  try {
    const archive = new WebDavOriginalArchive({
      baseUrl: config.archive.baseUrl,
      userId: config.archive.serviceUser,
      appPassword: config.archive.appPassword,
      rootPath: config.archive.rootPath,
    });
    const talk = new TalkBotClient({
      baseUrl: config.talk.baseUrl,
      secret: config.talk.secret,
      identityLookup: {
        userId: config.archive.serviceUser,
        appPassword: config.archive.appPassword,
        botActorId: config.talk.botActorId,
        allowedUserIds: config.talk.allowedUserIds,
      },
    });
    const startupTime = new Date().toISOString();
    const attachmentDatabasePath = join(
      config.dataDirectory,
      'attachment-shadow.sqlite',
    );
    const attachmentStore = own(
      new AttachmentShadowStore(attachmentDatabasePath),
      (store) => store.close(),
    );
    attachmentStore.recoverInterruptedOutbox(startupTime);

    const structuredModel = new XaiStructuredClient({
      apiKey: config.model.apiKey,
      model: config.model.name,
      reasoningEffort: config.model.reasoningEffort,
      maxAttempts: 2,
    });
    const fileSource = new WebDavFileSource({
      baseUrl: config.archive.baseUrl,
      userId: config.archive.serviceUser,
      appPassword: config.archive.appPassword,
    });
    const voiceMessageTranscriber = new XaiSpeechToTextTranscriber({
      apiKey: config.model.apiKey,
      source: fileSource,
      zeroDataRetentionVerifier: structuredModel,
    });
    const profileRepository = new WebDavHouseholdProfileRepository({
      baseUrl: config.archive.baseUrl,
      userId: config.archive.serviceUser,
      appPassword: config.archive.appPassword,
      path: config.contextManagement.profilePath,
    });
    const categorizationProfileSource = {
      read: async (signal?: AbortSignal) =>
        (await profileRepository.read(signal))?.profile,
    };
    const taxonomySource = new WebDavCategoryTaxonomySource({
      baseUrl: config.archive.baseUrl,
      userId: config.archive.serviceUser,
      appPassword: config.archive.appPassword,
      path: config.categoryTaxonomyPath,
    });
    const actualReader = new ActualReadHttpClient({
      endpoint: config.questionAnswering.readerUrl,
    });
    const deterministicActualReader =
      new ActualDeterministicTransactionHttpClient({
        endpoint: config.questionAnswering.readerUrl,
      });

    const actualUpdateIntentStore = own(
      new ActualUpdateIntentStore(attachmentDatabasePath),
      (store) => store.close(),
    );
    const actualUpdateAuthenticator = own(
      new ActualUpdateEnvelopeAuthenticator({
        activeKeyId: config.actualUpdateIntents.signingKeyId,
        keys: config.actualUpdateIntents.signingKeys,
        targetReferenceKey: config.actualUpdateIntents.targetReferenceKey,
      }),
      (authenticator) => authenticator.destroy(),
    );
    const receiptNoteOutboxStore = own(
      new ReceiptNoteOutboxStore(attachmentDatabasePath),
      (store) => store.close(),
    );
    const receiptNoteAuthenticator = own(
      new ReceiptNoteEnvelopeAuthenticator({
        activeKeyId: config.actualUpdateIntents.signingKeyId,
        keys: config.actualUpdateIntents.signingKeys,
      }),
      (authenticator) => authenticator.destroy(),
    );
    const actualUpdateWorkflow = new ActualUpdateWorkflow({
      store: actualUpdateIntentStore,
      authenticator: actualUpdateAuthenticator,
      writer: unavailableFinanceBotWriter,
    });
    const actualUpdateTalkStore = own(
      new ActualUpdateTalkStore(attachmentDatabasePath),
      (store) => store.close(),
    );
    const actualUpdateTalkInteractionWorker =
      new ActualUpdateTalkInteractionWorker({
        store: actualUpdateTalkStore,
        intents: actualUpdateIntentStore,
        workflow: actualUpdateWorkflow,
        talk,
        backendUrl: config.talk.baseUrl,
        roomToken: config.householdFinanceRoomToken,
        autoApprovalEnabled: config.actualUpdateTalk.autoApprovalEnabled,
      });
    const actualUpdateTalkDecisionHandler = new ActualUpdateTalkDecisionHandler(
      {
        store: actualUpdateTalkStore,
        intents: actualUpdateIntentStore,
        workflow: actualUpdateWorkflow,
        expectedBackendUrl: config.talk.baseUrl,
        allowedApproverIds: new Set(config.talk.allowedUserIds),
      },
    );

    const householdContextStore = own(
      new HouseholdContextStore(
        join(config.dataDirectory, 'household-context.sqlite'),
      ),
      (store) => store.close(),
    );
    householdContextStore.recoverInterruptedOutbox(startupTime);
    const householdContextWorker = new HouseholdContextWorker(
      new HouseholdContextWorkflow({
        store: householdContextStore,
        profileRepository,
        talk,
        timeZone: config.questionAnswering.timeZone,
        signal: abortController.signal,
      }),
    );

    const transactionCategorizationStore = own(
      new TransactionCategorizationStore(
        join(config.dataDirectory, 'transaction-categorization.sqlite'),
      ),
      (store) => store.close(),
    );
    const receiptCategorizationStore = own(
      new ReceiptCategorizationStore(
        join(config.dataDirectory, 'receipt-categorization.sqlite'),
      ),
      (store) => store.close(),
    );
    const receiptMatchStore = own(
      new ReceiptMatchStore(
        join(config.dataDirectory, 'receipt-matching.sqlite'),
      ),
      (store) => store.close(),
    );
    receiptMatchStore.recoverInterruptedOutbox(startupTime);

    const receiptRecordProjection =
      new CanonicalReceiptRecordProjectionSource();
    const receiptRecordPublicationWorkflow =
      new ReceiptRecordPublicationWorkflow({
        attachments: attachmentStore,
        outbox: receiptNoteOutboxStore,
        publisher: new ReceiptRecordPublisher({
          store: receiptNoteOutboxStore,
          authenticator: receiptNoteAuthenticator,
        }),
        projection: receiptRecordProjection,
        roomToken: config.householdFinanceRoomToken,
      });
    const receiptRecordHydrator = new CanonicalReceiptRecordHydrator({
      actual: deterministicActualReader,
      publication: receiptRecordPublicationWorkflow,
    });
    const receiptCategorizationWorker = new ReceiptCategorizationWorker(
      new ReceiptCategorizationWorkflow({
        store: receiptCategorizationStore,
        records: receiptRecordProjection,
        taxonomySource,
        classifier: new XaiReceiptItemCategoryClassifier(structuredModel),
        publisher: new ReceiptMatchStoreCategorizationPublisher(
          receiptMatchStore,
        ),
        talk,
        signal: abortController.signal,
      }),
    );
    const receiptMatchApplier = new ActualReceiptMatchUpdateApplier({
      actual: deterministicActualReader,
      receipts: receiptCategorizationStore,
      actualUpdateWorkflow,
      actualUpdateIntents: actualUpdateIntentStore,
      authenticator: actualUpdateAuthenticator,
      freshness: receiptRecordProjection,
    });
    const receiptPipelineReconciler = new ReceiptPipelineReconciler({
      matches: receiptMatchStore,
      candidates: deterministicActualReader,
      applier: receiptMatchApplier,
      freshness: receiptRecordProjection,
    });
    const receiptMatchAmbiguityTalkWorker = new ReceiptMatchAmbiguityTalkWorker(
      {
        matches: receiptMatchStore,
        sources: receiptCategorizationStore,
        talk,
      },
    );

    const transactionCategoryUpdateSink =
      new ActualTransactionCategoryUpdateSink({
        actual: deterministicActualReader,
        categorizationStore: transactionCategorizationStore,
        actualUpdateWorkflow,
        actualUpdateIntents: actualUpdateIntentStore,
        authenticator: actualUpdateAuthenticator,
      });
    const receiptReservationSource = {
      isImportedTransactionReserved: (
        accountAlias: string,
        importedId: string,
      ) =>
        receiptMatchStore.isImportedTransactionReserved(
          accountAlias,
          importedId,
        ),
    };
    const transactionCategorizationWorker = new TransactionCategorizationWorker(
      new TransactionCategorizationWorkflow({
        store: transactionCategorizationStore,
        observationSource: new ActualTransactionCategorizationObservationSource(
          {
            actual: deterministicActualReader,
            receiptReservationSource,
            rollingWindowDays:
              config.transactionCategorization.rollingWindowDays,
            timeZone: config.questionAnswering.timeZone,
          },
        ),
        profileSource: categorizationProfileSource,
        taxonomySource,
        classifier: new XaiTransactionCategoryClassifier(structuredModel),
        updateSink: transactionCategoryUpdateSink,
        talk,
        talkRoomToken: config.householdFinanceRoomToken,
        specialCategoryAliases: {
          cashback: 'cashback',
        },
        minimumAutoApplyConfidence:
          config.transactionCategorization.minimumAutoApplyConfidence,
        timeZone: config.questionAnswering.timeZone,
        receiptReservationSource,
        signal: abortController.signal,
      }),
    );

    const conversationalEditAdapter = new ConversationalTransactionEditAdapter({
      actual: deterministicActualReader,
      receiptReservationSource,
      workflow: actualUpdateWorkflow,
      authenticator: actualUpdateAuthenticator,
    });
    const questionStore = own(
      new QuestionStore(join(config.dataDirectory, 'finance-questions.sqlite')),
      (store) => store.close(),
    );
    questionStore.recoverInterruptedOutbox(startupTime);
    const pendingReceiptTool = pendingReceiptReadTool({
      matches: receiptMatchStore,
      actual: deterministicActualReader,
    });
    const questionWorker = new FinanceQuestionWorker(
      new FinanceQuestionWorkflow({
        store: questionStore,
        agent: new XaiFinanceQuestionAgent(
          structuredModel,
          actualReader,
          (input) => {
            const costcoLookup = costcoItemLookupTool({
              client: structuredModel,
            });
            if (input.actionContext === undefined) {
              return [pendingReceiptTool, costcoLookup];
            }

            const actionContext = input.actionContext;
            const currentReceipt = attachmentStore.findReceiptByIdempotencyKey(
              actionContext.idempotencyKey,
            );
            const currentReceiptTools =
              currentReceipt === undefined
                ? []
                : [
                    currentReceiptReadTool({
                      attachments: attachmentStore,
                      input,
                    }),
                  ];
            const recentReceiptTools =
              currentReceipt === undefined
                ? [
                    recentReceiptReadTool({
                      actual: deterministicActualReader,
                      attachments: attachmentStore,
                      roomToken: actionContext.roomToken,
                      focusedMessageIds: receiptReplyAncestryMessageIds(input),
                    }),
                  ]
                : [];
            const receiptNoteTools =
              currentReceipt === undefined
                ? [
                    receiptHouseholdNoteTool({
                      attachments: attachmentStore,
                      records: receiptRecordPublicationWorkflow,
                      input,
                    }),
                  ]
                : [];
            const contextBinding = bindHouseholdContextTool({
              store: householdContextStore,
              profileRepository,
              worker: householdContextWorker,
              actionContext,
              timeZone: config.questionAnswering.timeZone,
            });
            const contextTools =
              currentReceipt === undefined
                ? [
                    {
                      ...contextBinding.tool,
                      stateChanging: true,
                      didHandleTalkReply: () =>
                        contextBinding.didHandleTalkReply(),
                    },
                  ]
                : [];
            const transactionTools =
              currentReceipt === undefined
                ? conversationalActualWriteTools({
                    adapter: conversationalEditAdapter,
                    taxonomySource,
                    profileSource: profileRepository,
                    actionContext,
                    timeZone: config.questionAnswering.timeZone,
                    onRecurringRuleMutation: async (mutation, ruleOptions) => {
                      householdContextStore.recordMutation(
                        {
                          idempotencyKey: `household-context-tool:merchant-rule:${mutation.mutationId}`,
                          backendUrl: actionContext.backendUrl,
                          roomToken: actionContext.roomToken,
                          mutation,
                        },
                        {
                          enqueueAcknowledgement: false,
                          enqueueResultReply: ruleOptions.enqueueResultReply,
                        },
                      );
                      await householdContextWorker.kick();
                    },
                    onIntentQueued: async (intent) => {
                      await actualUpdateTalkInteractionWorker.kick();
                      return actualUpdateIntentStore.getPublicIntent(
                        intent.proposal.intentId,
                      );
                    },
                  })
                : [];

            return [
              ...(currentReceipt === undefined ? [pendingReceiptTool] : []),
              ...currentReceiptTools,
              ...recentReceiptTools,
              receiptIgnoreTool({
                attachments: attachmentStore,
                categorizations: receiptCategorizationStore,
                matches: receiptMatchStore,
                records: receiptRecordPublicationWorkflow,
                input,
              }),
              ...receiptNoteTools,
              costcoLookup,
              ...contextTools,
              ...transactionTools,
            ];
          },
        ),
        voiceTranscriber: voiceMessageTranscriber,
        talk,
        conversationHistorySource: talk,
        timeZone: config.questionAnswering.timeZone,
        allowedUserIds: config.talk.allowedUserIds,
        profileSource: profileRepository,
        signal: abortController.signal,
      }),
    );

    const talkClarificationHandler = new TalkClarificationHandler({
      expectedBotActorId: config.talk.botActorId,
      taxonomySource,
      transactions: transactionCategorizationStore,
      receipts: receiptCategorizationStore,
      matches: receiptMatchStore,
      signal: abortController.signal,
    });
    const attachmentWorker = new AttachmentShadowOutboxWorker(
      new AttachmentShadowWorkflow({
        store: attachmentStore,
        source: fileSource,
        archive,
        preparer: new RemoteReceiptDocumentPreparer(),
        model: new XaiResponsesReceiptAdapter({
          apiKey: config.model.apiKey,
          model: config.model.name,
          reasoningEffort: config.model.reasoningEffort,
          maxAttempts: 2,
        }),
        talk,
        conversation: {
          enqueueCompletedAttachment: async (event) => {
            questionStore.recordInbound(
              {
                idempotencyKey: event.idempotencyKey,
                backendUrl: event.backendUrl,
                roomToken: event.roomToken,
                actorId: event.actorId,
                messageId: event.messageId,
                question: event.captionHint?.trim() || 'I sent this receipt.',
                receivedAt: event.receivedAt,
              },
              { enqueueAcknowledgement: false },
            );
          },
        },
        signal: abortController.signal,
      }),
    );

    const questionWorkerKick: NamedWorkerKick = {
      name: 'questions',
      kick: () => questionWorker.kick(),
    };
    const primaryWorkerKicks: readonly NamedWorkerKick[] = [
      { name: 'attachments', kick: () => attachmentWorker.kick() },
      questionWorkerKick,
      {
        name: 'household-context',
        kick: () => householdContextWorker.kick(),
      },
      {
        name: 'receipt-record-hydration',
        kick: () => receiptRecordHydrator.kick(),
      },
      {
        name: 'receipt-record-publication',
        kick: () => receiptRecordPublicationWorkflow.runOnce(),
      },
      {
        name: 'receipt-categorization',
        kick: () => receiptCategorizationWorker.kick(),
      },
      {
        name: 'receipt-matching',
        kick: () => receiptPipelineReconciler.kick(),
      },
      {
        name: 'receipt-ambiguity-talk',
        kick: () => receiptMatchAmbiguityTalkWorker.kick(),
      },
      {
        name: 'actual-update-talk',
        kick: () => actualUpdateTalkInteractionWorker.kick(),
      },
    ];
    const receiptMatchWakeupKick: NamedWorkerKick = {
      name: 'receipt-match-wakeup',
      kick: () =>
        receiptMatchStore.wakeAllPendingAfterLedgerRefresh(
          new Date().toISOString(),
        ),
    };
    const transactionCategorizationKick: NamedWorkerKick = {
      name: 'transaction-categorization',
      kick: () => transactionCategorizationWorker.kick(),
    };
    const receiptLedgerWorkerKicks: readonly NamedWorkerKick[] = [
      {
        name: 'receipt-record-hydration',
        kick: () => receiptRecordHydrator.kick(),
      },
      {
        name: 'receipt-record-publication',
        kick: () => receiptRecordPublicationWorkflow.runOnce(),
      },
      {
        name: 'receipt-categorization',
        kick: () => receiptCategorizationWorker.kick(),
      },
      {
        name: 'receipt-matching',
        kick: () => receiptPipelineReconciler.kick(),
      },
    ];
    const workerKickPlan = createProductionWorkerKickPlan({
      receiptMatchWakeup: receiptMatchWakeupKick,
      primaryWorkers: primaryWorkerKicks,
      receiptLedgerWorkers: receiptLedgerWorkerKicks,
      transactionCategorization: transactionCategorizationKick,
      questions: questionWorkerKick,
    });
    const bankSyncScheduler = new BankSyncScheduler({
      reader: actualReader,
      intervalMs: config.questionAnswering.bankSyncIntervalMs,
      onCompletedImportAttempt: async () => {
        await kickWorkersSafely('post-bank-sync', workerKickPlan.postBankSync);
      },
      onError: () => {
        process.stderr.write('scheduled Actual bank sync failed safely\n');
      },
    });

    let poller: NodeJS.Timeout | undefined;
    let transactionCategorizationPoller: NodeJS.Timeout | undefined;
    let backgroundWorkStarted = false;
    const startBackgroundWork = (): void => {
      if (backgroundWorkStarted) {
        throw new Error('Production background work has already started');
      }
      backgroundWorkStarted = true;
      void kickWorkersSafely('initial', workerKickPlan.initial);
      poller = setInterval(() => {
        void kickWorkersSafely('outbox-poll', workerKickPlan.outboxPoll);
      }, 1_000);
      transactionCategorizationPoller = setInterval(() => {
        void kickWorkersSafely(
          'transaction-categorization-poll',
          workerKickPlan.transactionCategorizationPoll,
        );
      }, config.transactionCategorization.scanIntervalMs);
      bankSyncScheduler.start();
    };
    const beginShutdown = (): void => {
      abortController.abort();
      if (poller !== undefined) {
        clearInterval(poller);
        poller = undefined;
      }
      if (transactionCategorizationPoller !== undefined) {
        clearInterval(transactionCategorizationPoller);
        transactionCategorizationPoller = undefined;
      }
    };

    return {
      httpDependencies: {
        attachmentStore,
        attachmentWorker,
        questionStore,
        questionWorker,
        householdContextStore,
        householdContextWorker,
        transactionCategorizationStore,
        transactionCategorizationWorker,
        receiptCategorizationStore,
        receiptCategorizationWorker,
        receiptMatchStore,
        receiptPipelineReconciler,
        receiptMatchAmbiguityTalkWorker,
        actualUpdateIntentStore,
        actualUpdateTalkStore,
        actualUpdateTalkInteractionWorker,
        actualUpdateTalkDecisionHandler,
        talkClarificationHandler,
      },
      startBackgroundWork,
      beginShutdown,
      stopBankSync: () => bankSyncScheduler.stop(),
      drainWorkers: () => kickWorkersSafely('shutdown', primaryWorkerKicks),
      close,
    };
  } catch (error) {
    abortController.abort();
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Finance-bot startup and cleanup both failed',
        { cause: cleanupError },
      );
    }
    throw error;
  }
}
