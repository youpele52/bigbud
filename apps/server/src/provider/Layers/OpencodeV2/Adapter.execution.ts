import { Effect, PubSub, Stream, Schema, Exit } from "effect";
import { providerAttachmentPolicy } from "@bigbud/shared/providerAttachments";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import type { OpencodeV2AdapterShape } from "../../Services/OpencodeV2/Adapter.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { V2IsolatedMcp } from "./Runtime.mcp.ts";
import { V2AdmissionUnconfirmed } from "./Admission.ts";
import { ProviderTurnAdmissionConflict } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { V2StartAttempt } from "./Runtime.start.ts";
import { V2_EXECUTION_CAPABILITIES } from "./Adapter.capabilities.ts";

/** Real local adapter factory. Explicit isolated harness inputs, not preview enablement. */
export const makeIsolatedOpencodeV2Adapter = Effect.fn("makeIsolatedOpencodeV2Adapter")(function* (
  options: Omit<V2IsolatedRuntimeOptions, "emit">,
) {
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(256);
  let closing = false;
  const shutdownEvents = Effect.sync(() => {
    closing = true;
  }).pipe(Effect.andThen(PubSub.shutdown(events)));
  const runtime = new OpencodeV2Runtime({
    ...options,
    emit: (event) =>
      closing
        ? Promise.resolve()
        : Effect.runPromise(PubSub.publish(events, event).pipe(Effect.timeout("10 seconds"))).then(
            () => {},
          ),
  });
  const call = <T>(operation: string, run: () => Promise<T>) =>
    Effect.tryPromise({
      try: run,
      catch: (error) =>
        new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation,
          issue:
            Schema.is(V2AdmissionUnconfirmed)(error) ||
            Schema.is(ProviderTurnAdmissionConflict)(error)
              ? error.detail
              : error instanceof Error &&
                  error.name === "Error" &&
                  (/^(V2 |OpenCode v2 )/.test(error.message) ||
                    error.message === providerAttachmentPolicy("opencodeV2").unavailableReason)
                ? error.message.slice(0, 512)
                : "Isolated V2 operation failed or remains unconfirmed; no automatic resend or provider fallback.",
          cause: { name: error instanceof Error ? error.name : "UnknownFailure" },
        }),
    });
  const mcp = new V2IsolatedMcp(runtime);
  const adapter: OpencodeV2AdapterShape = {
    provider: "opencodeV2",
    runBackgroundReview: makeV2LearningReview(runtime),
    ...(options.enableIsolatedMcp
      ? {
          mcp: {
            refresh: (thread) => call("mcp.refresh", () => mcp.refresh(thread)),
            replace: (thread, servers) => call("mcp.replace", () => mcp.replace(thread, servers)),
            reconnect: (thread, server) =>
              call("mcp.reconnect", () => mcp.connect(thread, server, true)),
            toggle: (thread, server, enabled) =>
              call("mcp.toggle", () => mcp.connect(thread, server, enabled)),
          },
        }
      : {}),
    capabilities: V2_EXECUTION_CAPABILITIES,
    startSession: (input) =>
      Effect.suspend(() => {
        const attempt = new V2StartAttempt();
        return call("startSession", () => runtime.start(input, attempt)).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Effect.promise(() => runtime.cancelStart(attempt)) : Effect.void,
          ),
        );
      }),
    sendTurn: (input) => call("sendTurn", () => runtime.send(input)),
    interruptTurn: (thread, turn) => call("interruptTurn", () => runtime.interrupt(thread, turn)),
    inspectActiveTurn: (thread, turn) =>
      call("inspectActiveTurn", () => runtime.inspect(thread, turn)),
    respondToRequest: (thread, id, decision) =>
      call("respondToRequest", () => runtime.respondPermission(thread, id, decision)),
    respondToUserInput: (thread, id, answers) =>
      call("respondToUserInput", () => runtime.respondForm(thread, id, answers)),
    stopSession: (thread) => call("stopSession", () => runtime.stop(thread)),
    listSessions: () =>
      Effect.sync(() => [...runtime.sessions.values()].map((session) => session.session)),
    hasSession: (thread) =>
      Effect.sync(() => runtime.sessions.has(thread) && !runtime.sessions.get(thread)?.stopped),
    readThread: (thread) => call("readThread", () => runtime.read(thread)),
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation: "rollbackThread",
          issue: "V2 native rewind is explicitly unsupported.",
        }),
      ),
    stopAll: () => shutdownEvents.pipe(Effect.andThen(call("stopAll", () => runtime.close()))),
    streamEvents: Stream.fromPubSub(events),
  };
  yield* Effect.addFinalizer(() =>
    shutdownEvents.pipe(Effect.andThen(call("shutdown", () => runtime.close()).pipe(Effect.orDie))),
  );
  return { adapter, runtime };
});
