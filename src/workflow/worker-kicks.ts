export type WorkerKick = () => unknown | Promise<unknown>;

export interface NamedWorkerKick {
  readonly name: string;
  readonly kick: WorkerKick;
}

export interface WorkerKickRunSummary {
  readonly attempted: number;
  readonly failures: readonly string[];
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
