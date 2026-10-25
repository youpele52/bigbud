/**
 * Thread Stop for Codex child agents. A live probe against codex-cli 0.163.0 (2026-10-21)
 * showed that `turn/interrupt` on the parent thread does not stop child agent threads: the child
 * kept working and completed normally. `turn/interrupt` on the child thread itself ends the
 * child's turn as `interrupted` (a shell command already running may still run to its end).
 *
 * @module codexAppServerManager.turn.children
 */
import type { CodexSessionContext } from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";

/** Interrupts the running turn of each listed known child thread; idle or unknown ones are skipped. */
export async function interruptChildTurns(
  context: CodexSessionContext,
  childThreadIds: ReadonlyArray<string>,
  ops: Pick<TurnOps, "sendRequest">,
): Promise<void> {
  const targets = [...new Set(childThreadIds)].flatMap((threadId) => {
    const turnId = context.collabChildTurns.get(threadId);
    return turnId ? [{ threadId, turnId }] : [];
  });
  const results = await Promise.allSettled(
    targets.map((target) => ops.sendRequest(context, "turn/interrupt", target)),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      `Failed to interrupt ${failures.length} of ${targets.length} Codex child agent turns.`,
      { cause: failures.map((failure) => failure.reason) },
    );
  }
}
