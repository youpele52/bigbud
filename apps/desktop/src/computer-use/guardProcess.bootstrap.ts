import type { GuardHandle } from "./guardProcess";
import { resolveGuardLaunchPlan, type GuardLaunchInput } from "./guardProcess.logic";
import { superviseGuard } from "./guardProcess.supervisor";

let current: GuardHandle | null = null;

/**
 * Starts the supervised guard only when the selection gate is open (never
 * while Driver 0.9.1 is pinned). Idempotent. Only an election conflict (a
 * previous app's guard still shutting down) is retried with bounded backoff;
 * any other exit is final (no replay, fail closed). `onBeforeQuit` closes the
 * lifeline as soon as quit starts, so a relaunch finds the election free
 * sooner; process exit closes it regardless.
 */
export function startComputerUseGuardIfSelected(
  input: GuardLaunchInput & {
    readonly log: (message: string) => void;
    readonly onBeforeQuit: (listener: () => void) => void;
  },
): GuardHandle | null {
  if (current) return current;
  const plan = resolveGuardLaunchPlan(input);
  if (!plan.start) {
    input.log(`computer-use guard not started reason=${plan.reason}`);
    return null;
  }
  const guard = superviseGuard({ binaryPath: plan.binaryPath, args: plan.args, log: input.log });
  input.onBeforeQuit(() => void guard.stop());
  current = guard;
  return guard;
}

export function currentComputerUseGuard(): GuardHandle | null {
  return current;
}
