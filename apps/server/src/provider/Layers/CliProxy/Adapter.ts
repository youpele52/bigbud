import type {
  ClaudeModelSelection,
  CliProxyModelSelection,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from "@bigbud/contracts";
import { Effect, Layer, Stream } from "effect";

import { makeClaudeAdapter } from "../Claude/Adapter.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import { CliProxyAdapter, type CliProxyAdapterShape } from "../../Services/CliProxy/Adapter.ts";
import { preflightCliProxy } from "./Client.ts";
import { cliProxyHarnessEnvironment, readCliProxyConfig } from "./config.ts";

const PROVIDER = "cliProxy" as const;

export function asClaudeModelSelection(selection: CliProxyModelSelection): ClaudeModelSelection {
  return {
    provider: "claudeAgent",
    model: selection.model,
    ...(selection.options ? { options: selection.options } : {}),
  };
}

function asClaudeStart(input: ProviderSessionStartInput): ProviderSessionStartInput {
  const modelSelection = input.modelSelection;
  return {
    ...input,
    provider: "claudeAgent",
    ...(modelSelection?.provider === PROVIDER
      ? { modelSelection: asClaudeModelSelection(modelSelection) }
      : {}),
  };
}

function asClaudeTurn(input: ProviderSendTurnInput): ProviderSendTurnInput {
  const modelSelection = input.modelSelection;
  return modelSelection?.provider === PROVIDER
    ? { ...input, modelSelection: asClaudeModelSelection(modelSelection) }
    : input;
}

function remapEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return { ...event, provider: PROVIDER };
}

export const CliProxyAdapterLive = Layer.effect(
  CliProxyAdapter,
  Effect.gen(function* () {
    const claude = yield* makeClaudeAdapter({
      privateHarness: {
        binaryPath: "claude",
        environment: () => {
          const config = readCliProxyConfig();
          return config ? cliProxyHarnessEnvironment(config) : {};
        },
        settingSources: [],
        resolveModel: (model) => model,
      },
    });
    const preflight = (input: ProviderSessionStartInput) => {
      const currentConfig = readCliProxyConfig();
      if (!currentConfig) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "CLIProxy is disabled or incomplete.",
          }),
        );
      }
      return Effect.tryPromise({
        try: async () => {
          const result = await preflightCliProxy(currentConfig);
          const model = input.modelSelection;
          if (
            model?.provider !== PROVIDER ||
            (model.subProviderID !== "codex" && model.subProviderID !== "claude") ||
            !result.models.some(
              (candidate) =>
                candidate.id === model.model && candidate.source === model.subProviderID,
            )
          ) {
            throw new Error(
              "The selected CLIProxy model is no longer available from its logged-in source.",
            );
          }
        },
        catch: (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
    };
    return {
      provider: PROVIDER,
      capabilities: claude.capabilities,
      startSession: (input) =>
        preflight(input).pipe(
          Effect.andThen(() => claude.startSession(asClaudeStart(input))),
          Effect.map((session) => ({ ...session, provider: PROVIDER })),
        ),
      sendTurn: (input) => claude.sendTurn(asClaudeTurn(input)),
      interruptTurn: claude.interruptTurn,
      respondToRequest: claude.respondToRequest,
      respondToUserInput: claude.respondToUserInput,
      stopSession: claude.stopSession,
      listSessions: () =>
        claude
          .listSessions()
          .pipe(
            Effect.map((sessions) =>
              sessions.map((session) => ({ ...session, provider: PROVIDER })),
            ),
          ),
      hasSession: claude.hasSession,
      readThread: claude.readThread,
      rollbackThread: claude.rollbackThread,
      stopAll: claude.stopAll,
      streamEvents: Stream.map(claude.streamEvents, remapEvent),
    } satisfies CliProxyAdapterShape;
  }),
);
