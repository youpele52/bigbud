/**
 * What happens to host terminals when the backend stops (plan §14, D8). The desktop's
 * acknowledged quit hint decides it: a user quit or restart with the default setting closes
 * every managed host terminal (all generations, draining ones included); an update with the
 * default setting closes them too, with reason `update`. Keep mode detaches, and so does a
 * stop without a hint (a standalone server, an OS logout, a crash): the host keeps the
 * terminals and its orphan policy applies.
 *
 * @module Manager.quitPolicy
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AppQuitIntentRecord } from "../../lifecycle/AppQuitIntent.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";

class TerminalQuitCloseError extends Data.TaggedError("TerminalQuitCloseError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** Close-all must finish inside the desktop's 8 s stop window (§14 step 7). */
export const TERMINAL_QUIT_CLOSE_DEADLINE_MS = 3_000;

export type TerminalQuitDecision =
  | { readonly kind: "detach"; readonly why: "no-hint" | "keep" }
  | { readonly kind: "close"; readonly reason: "quit" | "update" };

export function decideTerminalQuit(
  intent: Option.Option<AppQuitIntentRecord>,
  keepRunningAfterQuit: boolean,
): TerminalQuitDecision {
  if (Option.isNone(intent)) return { kind: "detach", why: "no-hint" };
  if (keepRunningAfterQuit) return { kind: "detach", why: "keep" };
  return { kind: "close", reason: intent.value.reason === "update" ? "update" : "quit" };
}

/** Runs on shutdown before sessions detach; failures fall back to the host's orphan timer. */
export const applyTerminalQuitPolicy = Effect.fn("terminal.applyQuitPolicy")(function* (input: {
  readonly resolveIntent: Effect.Effect<Option.Option<AppQuitIntentRecord>> | undefined;
  readonly keepRunningAfterQuit: () => boolean;
  readonly runtime: () => OwnedPtyRuntime | undefined;
  readonly deadlineMs?: number;
}) {
  const generations = input.runtime()?.hostGenerations;
  if (!generations) return { kind: "detach", why: "no-hint" } as TerminalQuitDecision;
  const intent = input.resolveIntent ? yield* input.resolveIntent : Option.none();
  const decision = decideTerminalQuit(intent, input.keepRunningAfterQuit());
  yield* Effect.annotateCurrentSpan({
    "terminal.quit_decision": decision.kind === "close" ? decision.reason : decision.why,
  });
  if (decision.kind === "detach") {
    yield* Effect.logInfo("terminal hosts keep their terminals after this backend stops", {
      why: decision.why,
    });
    return decision;
  }
  const deadline = input.deadlineMs ?? TERMINAL_QUIT_CLOSE_DEADLINE_MS;
  const result = yield* Effect.tryPromise({
    try: () =>
      generations.closeAll(
        { reason: decision.reason, managedOnly: true },
        AbortSignal.timeout(deadline),
      ),
    catch: (cause) => new TerminalQuitCloseError({ detail: String(cause), cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () =>
        Effect.fail(new TerminalQuitCloseError({ detail: "Close-all was not confirmed in time." })),
    }),
    Effect.result,
  );
  if (result._tag === "Success")
    yield* Effect.logInfo("closed managed host terminals on quit", {
      reason: decision.reason,
      closed: result.success.closed,
      unreachable: result.success.unreachable,
    });
  else
    yield* Effect.logWarning("host terminals were not confirmed closed; the orphan timer applies", {
      reason: decision.reason,
      cause: result.failure.detail,
    });
  return decision;
});
