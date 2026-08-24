import type {
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeClaudeAdapter, type ClaudeAdapterLiveOptions } from "../Claude/Adapter.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../../Errors.ts";
import { CliProxyAdapter, type CliProxyAdapterShape } from "../../Services/CliProxy/Adapter.ts";
import { unavailableActiveTurnInspection } from "../../providerActiveTurnInspection.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { resolveCliProxyRuntimeConfig } from "./RuntimeConfig.ts";

const PROVIDER = "cliProxy" as const;

export function toClaudeSessionStartInput(
  input: ProviderSessionStartInput,
): ProviderSessionStartInput {
  return {
    ...input,
    provider: input.provider === PROVIDER ? "claudeAgent" : input.provider,
    modelSelection:
      input.modelSelection?.provider === PROVIDER
        ? { provider: "claudeAgent", model: input.modelSelection.model }
        : input.modelSelection,
  };
}

function toCliProxySessionStartInput(input: ProviderSessionStartInput): ProviderSessionStartInput {
  return {
    ...input,
    provider: PROVIDER,
    modelSelection:
      input.modelSelection?.provider === "claudeAgent"
        ? { provider: PROVIDER, model: input.modelSelection.model }
        : input.modelSelection,
  };
}

function requireCliProxyModelSelection(
  input: {
    readonly modelSelection?: unknown;
  },
  operation: "startSession" | "sendTurn",
): Effect.Effect<
  { readonly provider: "cliProxy"; readonly model: string },
  ProviderAdapterValidationError
> {
  const selection = input.modelSelection;
  const candidate =
    selection && typeof selection === "object" && !Array.isArray(selection)
      ? (selection as { readonly provider?: unknown; readonly model?: unknown })
      : undefined;
  if (!candidate || candidate.provider !== PROVIDER) {
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: `CLIProxyAPI requires modelSelection.provider '${PROVIDER}'.`,
      }),
    );
  }
  if (typeof candidate?.model !== "string" || candidate.model.trim().length === 0) {
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: "CLIProxyAPI requires a non-empty live modelSelection.model.",
      }),
    );
  }
  return Effect.succeed({ provider: PROVIDER, model: candidate.model.trim() });
}

function requireCliProxySession(
  sessions: ReadonlyArray<ProviderSession>,
  threadId: ThreadId,
): Effect.Effect<ProviderSession, ProviderAdapterSessionNotFoundError> {
  const session = sessions.find(
    (candidate) => candidate.threadId === threadId && candidate.status !== "closed",
  );
  return session
    ? Effect.succeed(session)
    : Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
}

export function toClaudeSendTurnInput(input: ProviderSendTurnInput): ProviderSendTurnInput {
  return {
    ...input,
    modelSelection:
      input.modelSelection?.provider === PROVIDER
        ? { provider: "claudeAgent", model: input.modelSelection.model }
        : input.modelSelection,
  };
}

function remapSession<T extends { readonly provider: string }>(session: T): T {
  return { ...session, provider: PROVIDER };
}

function remapEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return { ...event, provider: PROVIDER };
}

function remapError(error: ProviderAdapterError): ProviderAdapterError {
  switch (error._tag) {
    case "ProviderAdapterValidationError":
      return new ProviderAdapterValidationError({ ...error, provider: PROVIDER });
    case "ProviderAdapterSessionNotFoundError":
      return new ProviderAdapterSessionNotFoundError({ ...error, provider: PROVIDER });
    case "ProviderAdapterSessionClosedError":
      return new ProviderAdapterSessionClosedError({ ...error, provider: PROVIDER });
    case "ProviderAdapterRequestError":
      return new ProviderAdapterRequestError({ ...error, provider: PROVIDER });
    case "ProviderAdapterProcessError":
      return new ProviderAdapterProcessError({ ...error, provider: PROVIDER });
  }
}

function remapMcp(
  mcp: NonNullable<CliProxyAdapterShape["mcp"]>,
): NonNullable<CliProxyAdapterShape["mcp"]> {
  return {
    refresh: (threadId) => mcp.refresh(threadId).pipe(Effect.mapError(remapError)),
    reconnect: (threadId, serverName) =>
      mcp.reconnect(threadId, serverName).pipe(Effect.mapError(remapError)),
    toggle: (threadId, serverName, enabled) =>
      mcp.toggle(threadId, serverName, enabled).pipe(Effect.mapError(remapError)),
    replace: (threadId, servers) =>
      mcp.replace(threadId, servers).pipe(Effect.mapError(remapError)),
  };
}

function unsupported(threadId: ThreadId, operation: string) {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue: `CLIProxyAPI does not support ${operation} until compatibility is verified.`,
    cause: { threadId },
  });
}

export interface CliProxyAdapterLiveOptions {
  readonly createQuery?: ClaudeAdapterLiveOptions["createQuery"];
  readonly resolveRuntimeConfig?: typeof resolveCliProxyRuntimeConfig;
}

const makeCliProxyAdapter = Effect.fn("makeCliProxyAdapter")(function* (
  options?: CliProxyAdapterLiveOptions,
) {
  const settings = yield* ServerSettingsService;
  const lifecycle = yield* CliProxyLifecycle;
  const resolveRuntimeConfig = options?.resolveRuntimeConfig ?? resolveCliProxyRuntimeConfig;
  const claude = yield* makeClaudeAdapter({
    ...(options?.createQuery ? { createQuery: options.createQuery } : {}),
    resolveHarness: (input) =>
      resolveRuntimeConfig(toCliProxySessionStartInput(input)).pipe(
        Effect.provideService(ServerSettingsService, settings),
        Effect.provideService(CliProxyLifecycle, lifecycle),
        Effect.map((runtime) => runtime.harness),
      ),
  });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "unsupported",
      // CLIProxy's Claude-compatible endpoint does not expose a verified native
      // resume contract. Recovery is therefore a fresh Claude session whose
      // transcript is rebuilt by orchestration before the next turn.
      sessionRecovery: "fresh-restart",
      conversationRewind: "unsupported",
      conversationFork: "unsupported",
    },
    startSession: (input) =>
      requireCliProxyModelSelection(input, "startSession").pipe(
        Effect.flatMap((selection) => {
          return claude
            .startSession(
              toClaudeSessionStartInput({
                ...input,
                modelSelection: selection,
              }),
            )
            .pipe(Effect.map((session) => remapSession(session)));
        }),
        Effect.mapError(remapError),
      ),
    sendTurn: (input) =>
      claude.listSessions().pipe(
        Effect.flatMap((sessions) => requireCliProxySession(sessions, input.threadId)),
        Effect.flatMap((session) =>
          (input.modelSelection === undefined
            ? typeof session.model === "string" && session.model.trim().length > 0
              ? Effect.succeed({ provider: PROVIDER, model: session.model })
              : Effect.fail(
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "CLIProxyAPI session has no live model selection.",
                  }),
                )
            : requireCliProxyModelSelection(input, "sendTurn")
          ).pipe(
            Effect.flatMap((selection) => {
              if (selection.model !== session.model) {
                return Effect.fail(unsupported(input.threadId, "in-session model switching"));
              }
              return claude.sendTurn(
                toClaudeSendTurnInput({
                  ...input,
                  modelSelection: selection,
                }),
              );
            }),
          ),
        ),
        Effect.mapError(remapError),
      ),
    interruptTurn: (threadId, turnId) =>
      claude.interruptTurn(threadId, turnId).pipe(Effect.mapError(remapError)),
    inspectActiveTurn: unavailableActiveTurnInspection(PROVIDER),
    respondToRequest: (threadId, requestId, decision) =>
      claude.respondToRequest(threadId, requestId, decision).pipe(Effect.mapError(remapError)),
    respondToUserInput: (threadId, requestId, answers) =>
      claude.respondToUserInput(threadId, requestId, answers).pipe(Effect.mapError(remapError)),
    stopSession: (threadId) => claude.stopSession(threadId).pipe(Effect.mapError(remapError)),
    listSessions: () =>
      claude
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.status !== "closed").map(remapSession),
          ),
        ),
    hasSession: claude.hasSession,
    readThread: (threadId) => claude.readThread(threadId).pipe(Effect.mapError(remapError)),
    rollbackThread: (threadId) => Effect.fail(unsupported(threadId, "conversation rewind")),
    stopAll: () => claude.stopAll().pipe(Effect.mapError(remapError)),
    streamEvents: Stream.map(claude.streamEvents, remapEvent),
    ...(claude.mcp ? { mcp: remapMcp(claude.mcp) } : {}),
  } satisfies CliProxyAdapterShape;
});

export function makeCliProxyAdapterLive(options?: CliProxyAdapterLiveOptions) {
  return Layer.effect(CliProxyAdapter, makeCliProxyAdapter(options));
}

export const CliProxyAdapterLive = makeCliProxyAdapterLive();
