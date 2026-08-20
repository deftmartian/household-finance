export type WorkerKick = () => unknown | Promise<unknown>;

export interface NamedWorkerKick {
  readonly name: string;
  readonly kick: WorkerKick;
}

export interface WorkerKickRunSummary {
  readonly attempted: number;
  readonly failures: readonly string[];
}

export interface ProductionWorkCoordinatorOptions {
  readonly lanes: Readonly<Record<string, readonly NamedWorkerKick[]>>;
  readonly onRun?: (
    lane: string,
    summary: WorkerKickRunSummary,
  ) => void | Promise<void>;
}

export async function runWorkerKicksInOrder(
  workers: readonly NamedWorkerKick[],
): Promise<WorkerKickRunSummary> {
  const failures: string[] = [];

  for (const worker of workers) {
    try {
      await worker.kick();
    } catch {
      failures.push(worker.name);
    }
  }

  return {
    attempted: workers.length,
    failures,
  };
}

interface LaneState {
  readonly workers: readonly NamedWorkerKick[];
  dirty: boolean;
  running: Promise<void> | undefined;
}

/** Coalesces immediate durable-work signals while preserving lane order. */
export class ProductionWorkCoordinator {
  readonly #lanes = new Map<string, LaneState>();
  readonly #onRun:
    | ((lane: string, summary: WorkerKickRunSummary) => void | Promise<void>)
    | undefined;
  #stopped = false;

  constructor(options: ProductionWorkCoordinatorOptions) {
    for (const [name, workers] of Object.entries(options.lanes)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || workers.length === 0) {
        throw new TypeError('Production work lane is invalid');
      }
      this.#lanes.set(name, { workers, dirty: false, running: undefined });
    }
    if (this.#lanes.size === 0) {
      throw new TypeError('Production work coordinator requires a lane');
    }
    this.#onRun = options.onRun;
  }

  signal(lane: string): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const state = this.#lanes.get(lane);
    if (state === undefined) {
      return Promise.reject(new TypeError('Unknown production work lane'));
    }
    state.dirty = true;
    state.running ??= this.#drainLane(lane, state).finally(() => {
      state.running = undefined;
    });
    return state.running;
  }

  async signalAll(): Promise<void> {
    await Promise.all([...this.#lanes.keys()].map((lane) => this.signal(lane)));
  }

  stop(): void {
    this.#stopped = true;
  }

  async drain(): Promise<void> {
    await Promise.all(
      [...this.#lanes.values()]
        .map((state) => state.running)
        .filter((running): running is Promise<void> => running !== undefined),
    );
  }

  async #drainLane(lane: string, state: LaneState): Promise<void> {
    while (state.dirty && !this.#stopped) {
      state.dirty = false;
      const summary = await runWorkerKicksInOrder(state.workers);
      await this.#onRun?.(lane, summary);
    }
  }
}
