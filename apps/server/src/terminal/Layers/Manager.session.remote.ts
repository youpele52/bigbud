import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  DEFAULT_TERMINAL_ID,
  TerminalExecutionTargetError,
} from "@bigbud/contracts/workspace/terminal.ts";
import { sessionOwnedPtyRuntime } from "./OwnedPtyRuntime.resolve.ts";
import { RemoteAgentPtyInventory } from "../../remote-agent/remoteAgentPtyInventory.ts";
import { RemoteAgentTerminalDiscovery } from "../../remote-agent/remoteAgentTerminalDiscovery.ts";
import { cleanupProcessHandles } from "./Manager.process-lifecycle";
import { assertTerminalGeneration } from "./Manager.session.generation";
import { toSessionKey } from "./Manager.shell";
import type { makeTerminalOpen } from "./Manager.session.open";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";

const failure = (threadId: string, terminalId: string, executionTargetId: string, detail: string) =>
  new TerminalExecutionTargetError({ threadId, terminalId, executionTargetId, detail });

export function makeRemoteTerminalApi(
  ctx: SessionApiContext,
  open: ReturnType<typeof makeTerminalOpen>,
  close: TerminalManagerShape["close"],
) {
  const remoteInventory: NonNullable<TerminalManagerShape["remoteInventory"]> = (input) =>
    Effect.tryPromise({
      try: async (signal) => {
        const runtime = sessionOwnedPtyRuntime(ctx, input.executionTargetId);
        if (!runtime) throw new Error("Remote agent transport required.");
        const page = await new RemoteAgentTerminalDiscovery(
          runtime.owners(),
          new RemoteAgentPtyInventory(runtime.pool),
        ).list(runtime.targetId, input.after, signal);
        return {
          ...page,
          // oxlint-disable-next-line no-map-spread -- Preserve readonly ownership observations while projecting the UI label.
          sessions: page.sessions.map((session) => ({
            ...session,
            executionTargetId: input.executionTargetId,
          })),
        };
      },
      catch: () =>
        failure(
          "inventory",
          "inventory",
          input.executionTargetId,
          "Terminal inventory is unavailable. Check the saved connection and reconnect; existing work has not been stopped.",
        ),
    });
  const remoteAttach: NonNullable<TerminalManagerShape["remoteAttach"]> = (input) =>
    sessionOwnedPtyRuntime(ctx, input.executionTargetId)
      ? open(input, input.resourceId)
      : Effect.fail(
          failure(
            input.threadId,
            input.terminalId ?? DEFAULT_TERMINAL_ID,
            input.executionTargetId,
            "Attach-only discovery requires a remote agent terminal.",
          ),
        );
  const remoteStop: NonNullable<TerminalManagerShape["remoteStop"]> = (input) =>
    Effect.gen(function* () {
      const runtime = sessionOwnedPtyRuntime(ctx, input.executionTargetId);
      if (!runtime)
        return yield* failure(
          input.threadId,
          input.terminalId ?? DEFAULT_TERMINAL_ID,
          input.executionTargetId,
          "A durable terminal runtime is required; stop was not dispatched.",
        );
      const owner = yield* Effect.tryPromise({
        try: () =>
          runtime
            .owners()
            .get(
              `terminal:${JSON.stringify([input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID])}`,
            ),
        catch: () =>
          failure(
            input.threadId,
            input.terminalId ?? DEFAULT_TERMINAL_ID,
            input.executionTargetId,
            "Terminal ownership is unavailable; stop was not dispatched.",
          ),
      });
      if (!owner || owner.target !== runtime.targetId || owner.resourceId !== input.resourceId)
        return yield* failure(
          input.threadId,
          input.terminalId ?? DEFAULT_TERMINAL_ID,
          input.executionTargetId,
          "Terminal ownership changed. Refresh discovery before stopping it.",
        );
      if (owner.state === "terminal") return;
      const snapshot = yield* remoteAttach(input);
      yield* close({
        threadId: snapshot.threadId,
        terminalId: snapshot.terminalId,
        expectedGeneration: snapshot.runtimeGeneration,
      });
    });
  const remoteDetach: NonNullable<TerminalManagerShape["remoteDetach"]> = (input) =>
    ctx.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
        const found = yield* ctx.getSession(input.threadId, terminalId);
        if (Option.isNone(found)) return; // Repeated detach has no process authority to change.
        const session = found.value;
        yield* assertTerminalGeneration(session, input.expectedGeneration);
        const process = session.process;
        if (!sessionOwnedPtyRuntime(ctx, session.executionTargetId) || !process?.detachRemote)
          return yield* failure(
            input.threadId,
            terminalId,
            session.executionTargetId,
            "This terminal does not support persistent Detach. Its process was left unchanged.",
          );
        yield* Effect.tryPromise({
          try: () => process.detachRemote!(),
          catch: () =>
            failure(
              input.threadId,
              terminalId,
              session.executionTargetId,
              "Detach could not be confirmed. The remote process may still be running; reconnect to inspect it.",
            ),
        });
        yield* ctx.flushPtyOutput(input.threadId, terminalId);
        yield* ctx.persistHistory(input.threadId, terminalId, session.history);
        yield* ctx.flushPersist(input.threadId, terminalId);
        cleanupProcessHandles(session);
        yield* ctx.modifyManagerState((state) => {
          const sessions = new Map(state.sessions);
          sessions.delete(toSessionKey(input.threadId, terminalId));
          return [undefined, { ...state, sessions }] as const;
        });
        // Keep durable owner, build pin and history. Detach is not an exit event.
      }),
    );
  return { remoteInventory, remoteAttach, remoteStop, remoteDetach };
}
