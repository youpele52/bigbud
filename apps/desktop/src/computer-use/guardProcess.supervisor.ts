import {
  startGuardProcess,
  type GuardHandle,
  type GuardState,
  type StartGuardInput,
} from "./guardProcess";

/**
 * Backoff after an election conflict (exit 4). On relaunch the previous app's
 * guard still holds the election for up to its 5 s orderly shutdown, so the
 * new guard retries for about 8 s in total, then stays exited (fail closed).
 */
export const GUARD_CONFLICT_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  250, 500, 1_000, 2_000, 4_000,
];

export interface SuperviseGuardInput extends StartGuardInput {
  readonly retryDelaysMs?: ReadonlyArray<number>;
  /** Injectable for tests. */
  readonly start?: (input: StartGuardInput) => GuardHandle;
}

/**
 * One guard handle across restart attempts. Only a conflict exit is retried:
 * every other exit (storage, recovery, unsettled, killed, ...) is final and
 * never replays work. `stop()` cancels a pending retry and stops the current
 * attempt; `exited` resolves once, with the final attempt's state.
 */
export function superviseGuard(input: SuperviseGuardInput): GuardHandle {
  const delays = input.retryDelaysMs ?? GUARD_CONFLICT_RETRY_DELAYS_MS;
  const start = input.start ?? startGuardProcess;
  const log = input.log ?? (() => undefined);
  let stopped = false;
  let attempt = 0;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let current = start(input);
  let settle!: (state: GuardState) => void;
  const exited = new Promise<GuardState>((resolve) => {
    settle = resolve;
  });
  const onExit = (result: GuardState): void => {
    const delay = delays[attempt];
    if (
      stopped ||
      result.kind !== "exited" ||
      result.reason !== "conflict" ||
      delay === undefined
    ) {
      settle(result);
      return;
    }
    attempt += 1;
    log(`computer-use guard election busy; retry ${attempt} in ${delay}ms`);
    waiting = setTimeout(() => {
      waiting = null;
      if (stopped) {
        settle(result);
        return;
      }
      current = start(input);
      void current.exited.then(onExit);
    }, delay);
    waiting.unref?.();
  };
  void current.exited.then(onExit);

  const state = (): GuardState =>
    waiting !== null ? { kind: "waiting", attempt } : current.state();
  const stop = async (): Promise<GuardState> => {
    stopped = true;
    if (waiting !== null) {
      clearTimeout(waiting);
      waiting = null;
      settle(current.state());
      return exited;
    }
    await current.stop();
    return exited;
  };
  return { state, stop, exited };
}
