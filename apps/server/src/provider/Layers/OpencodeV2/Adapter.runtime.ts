import { Effect, PubSub, Stream, Exit } from "effect";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import type { OpencodeV2AdapterShape } from "../../Services/OpencodeV2/Adapter.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2IsolatedRuntimeOptions } from "./Runtime.types.ts";
import { makeV2LearningReview } from "./Runtime.learning.ts";
import { v2ExecutionFailureClass, v2ExecutionIssue } from "./Adapter.execution.errors.ts";
import { V2StartAttempt } from "./Runtime.start.ts";
import { V2_EXECUTION_CAPABILITIES } from "./Adapter.capabilities.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { v2Promise, v2TryPromise } from "./Client.guard.async.ts";
import { guardV2Publication, validV2Publication } from "./Runtime.publication.ts";
import { runV2Caller } from "./Runtime.caller.ts";
import { V2ActivationDeferred } from "./PluginSetup.activation.errors.ts";
import { bindV2SettlementLogServices } from "./Runtime.settlement.log.ts";

/** Real local adapter factory. Explicit isolated harness inputs, not preview enablement. */
export const makeV2RuntimeAdapter = Effect.fn("makeV2RuntimeAdapter")(function* (
  options: Omit<V2IsolatedRuntimeOptions, "emit">,
) {
  bindV2SettlementLogServices(yield* Effect.services());
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(256);
  let closing = false;
  const shutdownEvents = Effect.sync(() => {
    closing = true;
  }).pipe(Effect.andThen(PubSub.shutdown(events)));
  const runtime = new OpencodeV2Runtime({
    ...options,
    emit: (event, validate) => {
      const captured = currentV2RequestContext();
      return closing
        ? Promise.resolve()
        : Effect.runPromise(
            Effect.suspend(() => {
              captured?.permit.assertCurrent();
              guardV2Publication(event, validate ?? captured?.permit.assertCurrent);
              return Effect.sync(() => {
                captured?.permit.assertCurrent();
                validate?.();
                if (!PubSub.publishUnsafe(events, event))
                  throw new Error(
                    "V2 event publication queue overflow; authoritative repair required.",
                  );
              });
            }).pipe(Effect.timeout("10 seconds")),
          ).then(() => {});
    },
  });
  const call = <T>(operation: string, run: () => Promise<T>) =>
    v2TryPromise({
      try: (signal) =>
        ["stopSession", "stopAll", "shutdown", "interruptTurn"].includes(operation)
          ? run()
          : ["startSession", "sendTurn"].includes(operation)
            ? runV2Caller(signal, operation === "sendTurn", () => runtime.authorized(run))
            : runtime.authorized(run),
      catch: (error) => {
        const issue = v2ExecutionIssue(error);
        return new ProviderAdapterValidationError({
          provider: "opencodeV2",
          operation,
          issue,
          failureClass: v2ExecutionFailureClass(error, issue),
          cause: { name: error instanceof Error ? error.name : "UnknownFailure" },
        });
      },
    });
  const adapter: OpencodeV2AdapterShape = {
    provider: "opencodeV2",
    runBackgroundReview: makeV2LearningReview(runtime),
    capabilities: V2_EXECUTION_CAPABILITIES,
    startSession: (input) =>
      Effect.suspend(() => {
        const attempt = new V2StartAttempt();
        let deferred = false;
        return call("startSession", () =>
          runtime.start(input, attempt).catch((error) => {
            deferred = error instanceof V2ActivationDeferred;
            throw error;
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !deferred
              ? v2Promise(() => runtime.cancelStart(attempt))
              : Effect.void,
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
    streamEvents: Stream.fromPubSub(events).pipe(Stream.filter(validV2Publication)),
  };
  yield* Effect.addFinalizer(() =>
    shutdownEvents.pipe(Effect.andThen(call("shutdown", () => runtime.close()).pipe(Effect.orDie))),
  );
  return { adapter, runtime };
});
