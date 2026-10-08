import { type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type EventId, type ThreadId } from "@bigbud/contracts";
import { Effect, Fiber, Stream, type Exit } from "effect";
import { PROVIDER } from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import { toError } from "./Adapter.utils.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import type { StreamHandlers } from "./Adapter.stream.ts";
import { rememberBoundedIdentity } from "./Adapter.dedup.ts";

export interface SessionRuntimeDeps {
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly streamHandlers: StreamHandlers;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
}

export function claimNativeMessageId(seen: Set<string>, message: SDKMessage): boolean {
  const nativeMessageId =
    typeof message === "object" && message !== null && "uuid" in message
      ? (() => {
          const value = message as {
            readonly uuid?: unknown;
            readonly type?: unknown;
            readonly subtype?: unknown;
          };
          return typeof value.uuid === "string"
            ? `${value.uuid}:${typeof value.type === "string" ? value.type : "unknown"}:${typeof value.subtype === "string" ? value.subtype : ""}`
            : undefined;
        })()
      : undefined;
  if (typeof nativeMessageId !== "string" || nativeMessageId.length === 0) return true;
  return rememberBoundedIdentity(seen, nativeMessageId, 1_000);
}

export const emitSessionRuntimeEvents = (
  deps: Pick<SessionRuntimeDeps, "makeEventStamp" | "offerRuntimeEvent">,
) =>
  Effect.fn("emitSessionRuntimeEvents")(function* (input: {
    readonly context: ClaudeSessionContext;
    readonly threadId: ThreadId;
    readonly resumeCursor: unknown;
    readonly apiModelId: string | undefined;
    readonly cwd: string | undefined;
    readonly effectiveEffort: string | undefined;
    readonly permissionMode: string | undefined;
    readonly dangerousPermissionBypass: boolean;
    readonly fastMode: boolean;
  }) {
    const sessionStartedStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent(input.context, {
      type: "session.started",
      eventId: sessionStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: sessionStartedStamp.createdAt,
      threadId: input.threadId,
      payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
      providerRefs: {},
    });

    const configuredStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent(input.context, {
      type: "session.configured",
      eventId: configuredStamp.eventId,
      provider: PROVIDER,
      createdAt: configuredStamp.createdAt,
      threadId: input.threadId,
      payload: {
        config: {
          ...(input.apiModelId ? { model: input.apiModelId } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.effectiveEffort ? { effort: input.effectiveEffort } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.dangerousPermissionBypass ? { dangerousPermissionBypass: true } : {}),
          ...(input.fastMode ? { fastMode: true } : {}),
        },
      },
      providerRefs: {},
    });

    const readyStamp = yield* deps.makeEventStamp();
    yield* deps.offerRuntimeEvent(input.context, {
      type: "session.state.changed",
      eventId: readyStamp.eventId,
      provider: PROVIDER,
      createdAt: readyStamp.createdAt,
      threadId: input.threadId,
      payload: { state: "ready" },
      providerRefs: {},
    });
  });

export const startSessionRuntimeStream =
  (deps: SessionRuntimeDeps) =>
  (input: {
    readonly context: ClaudeSessionContext;
    readonly logNativeSdkMessage: (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ) => Effect.Effect<void>;
    readonly runFork: <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, E>;
  }) => {
    return Effect.sync(() => {
      const wrappedHandleSdkMessage = Effect.fn("wrappedHandleSdkMessage")(function* (
        message: SDKMessage,
      ) {
        if (deps.sessions.get(input.context.session.threadId) !== input.context) return;
        if (!claimNativeMessageId(input.context.seenNativeMessageIds, message)) return;
        yield* input.logNativeSdkMessage(input.context, message);
        yield* deps.streamHandlers.handleSdkMessage(input.context, message);
      });

      const startStream = () => {
        let streamFiber: Fiber.Fiber<void, unknown>;
        const sdkStream = Stream.fromAsyncIterable(input.context.query, (cause) =>
          toError(cause, "Claude runtime stream failed."),
        ).pipe(
          Stream.takeWhile(() => !input.context.stopped),
          Stream.runForEach((message) => wrappedHandleSdkMessage(message)),
        );

        streamFiber = input.runFork(
          Effect.exit(sdkStream).pipe(
            Effect.flatMap((exit: Exit.Exit<void, unknown>) => {
              if (input.context.stopped) {
                return Effect.void;
              }
              if (input.context.streamFiber === streamFiber) {
                input.context.streamFiber = undefined;
              }
              return deps.streamHandlers.handleStreamExit(
                input.context,
                exit as Exit.Exit<void, Error>,
              );
            }),
          ),
        );

        input.context.streamFiber = streamFiber;
        streamFiber.addObserver(() => {
          if (input.context.streamFiber === streamFiber) {
            input.context.streamFiber = undefined;
          }
        });
      };

      startStream();
    });
  };
