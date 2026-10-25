/**
 * Coalescing for the Claude provider refresh reactor: a leading refresh, then at most one
 * trailing refresh per window, so slash-command and usage refreshes never storm the probe.
 *
 * @module ClaudeProviderRefreshReactor.logic
 */
import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { type Duration, Effect } from "effect";

export const CLAUDE_PROVIDER_REFRESH_WINDOW: Duration.Input = "60 seconds";

/** Claude events that make the provider snapshot (commands, usage) stale. */
export function isClaudeProviderRefreshTrigger(event: ProviderRuntimeEvent): boolean {
  if (event.provider !== "claudeAgent") return false;
  if (event.type === "account.rate-limits.updated") return true;
  return event.type === "session.configured" && event.payload.config.commandsChanged === true;
}

/**
 * Returns a trigger. The first trigger refreshes immediately; triggers during the window
 * set one pending trailing refresh, which runs when the window ends.
 */
export const makeCoalescedRefresh = Effect.fn("makeCoalescedRefresh")(function* (
  refresh: Effect.Effect<void>,
  window: Duration.Input,
) {
  const scope = yield* Effect.scope;
  const state = { running: false, pending: false };
  const loop = Effect.gen(function* () {
    while (true) {
      yield* refresh.pipe(Effect.ignoreCause({ log: true }));
      yield* Effect.sleep(window);
      if (!state.pending) break;
      state.pending = false;
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        state.running = false;
        state.pending = false;
      }),
    ),
  );
  return Effect.suspend(() => {
    if (state.running) {
      state.pending = true;
      return Effect.void;
    }
    state.running = true;
    return loop.pipe(Effect.forkIn(scope), Effect.asVoid);
  });
});
