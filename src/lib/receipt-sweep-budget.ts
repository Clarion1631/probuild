export class SweepDeferredError extends Error {
  readonly retryable = false;
  constructor(message = "Sweep work deferred") {
    super(message);
    this.name = 'SweepDeferredError';
  }
}

export const SWEEP_BUDGET_LIMIT_MS = 45_000;
export const SWEEP_TRANSACTION_TIMEOUT_MS = 15_000;
export const SWEEP_TRANSACTION_MAX_WAIT_MS = 2_000;

export interface TransactionOptions {
  timeout: number;
  maxWait: number;
}

export interface SweepBudget {
  check(): void;
  expired(): boolean;
  remainingMs(): number;
  transactionOptions(): TransactionOptions;
}

export function createSweepBudget(
  startedAtMs: number,
  now: () => number = Date.now,
  limitMs: number = SWEEP_BUDGET_LIMIT_MS,
): SweepBudget {
  const deadlineMs = startedAtMs + limitMs;

  const remainingMs = (): number => deadlineMs - now();

  const expired = (): boolean => remainingMs() <= 0;

  const check = (): void => {
    if (expired()) {
      throw new SweepDeferredError(`Sweep budget of ${limitMs}ms exhausted`);
    }
  };

  const transactionOptions = (): TransactionOptions => {
    const required = SWEEP_TRANSACTION_TIMEOUT_MS + SWEEP_TRANSACTION_MAX_WAIT_MS;
    const remaining = remainingMs();
    if (remaining < required) {
      throw new SweepDeferredError(
        `Sweep budget cannot admit a ${required}ms transaction with ${remaining}ms remaining`,
      );
    }
    return {
      timeout: SWEEP_TRANSACTION_TIMEOUT_MS,
      maxWait: SWEEP_TRANSACTION_MAX_WAIT_MS,
    };
  };

  return { check, expired, remainingMs, transactionOptions };
}

export interface CheckpointedRunResult {
  completed: number;
  deferred: boolean;
  exhausted: boolean;
}

export function isSweepDeferredError(error: unknown): error is SweepDeferredError {
  if (error instanceof SweepDeferredError) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'SweepDeferredError'
  );
}

export async function runCheckpointedUnits<T>(
  units: readonly T[],
  budget: ReturnType<typeof createSweepBudget>,
  process: (unit: T) => Promise<void>,
  checkpoint: (unit: T) => Promise<void>,
): Promise<CheckpointedRunResult> {
  let completed = 0;

  for (const unit of units) {
    try {
      budget.check();
      await process(unit);
    } catch (error) {
      if (isSweepDeferredError(error)) {
        return { completed, deferred: true, exhausted: false };
      }
      throw error;
    }

    // Durability: a successful unit is always checkpointed, even if the clock
    // expired during processing. Checkpoint failures propagate unconditionally.
    await checkpoint(unit);
    completed += 1;
  }

  return { completed, deferred: false, exhausted: true };
}
