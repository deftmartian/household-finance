export interface InteractiveActivitySource {
  hasPendingFirstResponse(roomToken: string): boolean;
}

/**
 * A deliberately narrow read-only gate for autonomous Talk sends. It does not
 * coordinate workers or hold a lease: existing stores remain the owners of
 * their work, and a poll one second later observes the latest durable state.
 */
export class InteractiveActivityReader {
  readonly #sources: readonly InteractiveActivitySource[];

  constructor(sources: readonly InteractiveActivitySource[]) {
    this.#sources = [...sources];
  }

  hasPendingFirstResponse(roomToken: string): boolean {
    return this.#sources.some((source) =>
      source.hasPendingFirstResponse(roomToken),
    );
  }
}
