import type { PreparedReceiptDocument } from './document.js';
import type { ReceiptModelProposalV1 } from './proposal.js';

export interface ReceiptModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costInUsdTicks?: number;
}

export interface ReceiptModelRunMetadata {
  provider: string;
  requestedModel: string;
  resolvedModel: string;
  preflightAttempts: number;
  documentAttempts: number;
  durationMs: number;
  zeroDataRetention: true;
  usage?: ReceiptModelUsage;
}

export interface ReceiptModelRun {
  proposal: ReceiptModelProposalV1;
  metadata: ReceiptModelRunMetadata;
}

export interface ReceiptModelAdapter {
  extract(
    document: PreparedReceiptDocument,
    signal?: AbortSignal,
    captionHint?: string,
  ): Promise<ReceiptModelRun>;
}
