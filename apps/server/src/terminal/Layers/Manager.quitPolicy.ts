/**
 * What happens to host terminals when the backend stops (plan §14, D8). The desktop's
 * acknowledged quit hint decides it: a user quit or restart with the default setting closes
 * every managed host terminal (all generations, draining ones included); an update with the
 * default setting closes them too, with reason `update`. Keep mode detaches, and so does a
 * stop without a hint (a standalone server, an OS logout, a crash): the host keeps the
 * terminals and its orphan policy applies. Remote-agent hosts follow the same decision.
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

const quitReason = (intent: AppQuitIntentRecord): "quit" | "update" =>
  intent.reason === "update" ? "update" : "quit";

export function decideTerminalQuit(
  intent: Option.Option<AppQuitIntentRecord>,
  keepRunningAfterQuit: boolean,
): TerminalQuitDecision {
  if (Option.isNone(intent)) return { kind: "detach", why: "no-hint" };
  if (keepRunningAfterQuit) return { kind: "detach", why: "keep" };
  return { kind: "close", reason: quitReason(intent.value) };
}

/** Host close-alls with one deadline; resolves with how many closed and how many did not answer. */
export interface TerminalQuitCloser {
  readonly closeAll: (
    input: { readonly reason: "quit" | "update"; readonly managedOnly: boolean },
    signal?: AbortSignal,
  ) => Promise<{ readonly closed: number; readonly unreachable: number }>;
}

const closeWithin = (
  label: "local" | "remote" | "native",
  closer: TerminalQuitCloser,
  reason: "quit" | "update",
  deadline: number,
) =>
  Effect.tryPromise({
    try: () => closer.closeAll({ reason, managedOnly: true }, AbortSignal.timeout(deadline)),
    catch: (cause) => new TerminalQuitCloseError({ detail: String(cause), cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: deadline,
      orElse: () =>
        Effect.fail(new TerminalQuitCloseError({ detail: "Close-all was not confirmed in time." })),
    }),
    Effect.result,
    Effect.flatMap((result) =>
      result._tag === "Success"
        ? Effect.logInfo("closed managed host terminals on quit", {
            hosts: label,
            reason,
            closed: result.success.closed,
            unreachable: result.success.unreachable,
          })
        : Effect.logWarning("host terminals were not confirmed closed; the orphan timer applies", {
            hosts: label,
            reason,
            cause: result.failure.detail,
          }),
    ),
  );

/**
 * Runs on shutdown before sessions detach; failures fall back to each host's orphan timer. The
 * local host (every generation) and each remote-agent host that runs a managed terminal of this
 * backend are closed at once, inside one 3 s budget; nothing waits past it.
 */
export const applyTerminalQuitPolicy = Effect.fn("terminal.applyQuitPolicy")(function* (input: {
  readonly resolveIntent: Effect.Effect<Option.Option<AppQuitIntentRecord>> | undefined;
  readonly keepRunningAfterQuit: () => boolean;
  readonly runtime: () => OwnedPtyRuntime | undefined;
  /** Remote-agent hosts, addressed per connection (absent when none can be closed). */
  readonly remote?: (TerminalQuitCloser & { readonly hasHosts: () => boolean }) | undefined;
  /**
   * Direct SSH PTYs of the dev-only native SSH owner, closed by exact lease only. They close on
   * every hinted quit, keep mode included (user decision); a hintless stop still detaches them.
   */
  readonly native?: (TerminalQuitCloser & { readonly hasHosts: () => boolean }) | undefined;
  readonly deadlineMs?: number;
}) {
  const generations = input.runtime()?.hostGenerations;
  const remote = input.remote?.hasHosts() ? input.remote : undefined;
  const native = input.native?.hasHosts() ? input.native : undefined;
  if (!generations && !remote && !native)
    return { kind: "detach", why: "no-hint" } as TerminalQuitDecision;
  const intent = input.resolveIntent ? yield* input.resolveIntent : Option.none();
  const decision = decideTerminalQuit(intent, input.keepRunningAfterQuit());
  yield* Effect.annotateCurrentSpan({
    "terminal.quit_decision": decision.kind === "close" ? decision.reason : decision.why,
  });
  const deadline = input.deadlineMs ?? TERMINAL_QUIT_CLOSE_DEADLINE_MS;
  if (decision.kind === "detach") {
    yield* Effect.logInfo("terminal hosts keep their terminals after this backend stops", {
      why: decision.why,
    });
    if (native && Option.isSome(intent))
      yield* closeWithin("native", native, quitReason(intent.value), deadline);
    return decision;
  }
  yield* Effect.all(
    [
      ...(generations ? [closeWithin("local", generations, decision.reason, deadline)] : []),
      ...(remote ? [closeWithin("remote", remote, decision.reason, deadline)] : []),
      ...(native ? [closeWithin("native", native, decision.reason, deadline)] : []),
    ],
    { concurrency: "unbounded", discard: true },
  );
  return decision;
});
