import { Effect, PubSub, Stream } from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  TurnId,
  TextGenerationError,
  type ModelSelection,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { titleFixture } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.title.fixture.ts";
import { startPromptSuggestionReactor } from "../../orchestration/Layers/PromptSuggestionReactor.ts";
import type { SessionOpServices } from "../../orchestration/Layers/ProviderCommandReactorSessionOps.types.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import { makeV2AuxiliaryTextGenerator } from "../../provider/Layers/OpencodeV2/TextGeneration.native.ts";
import {
  makeOpencodeV2TextGeneration,
  makeV2StructuredTextRunner,
} from "./OpencodeV2TextGeneration.ts";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";

/** Actual metadata callers + router + native HTTP client, with a settings change between their reads. */
export async function dispatchRaceFixture(
  mode: "preference-change" | "fallback" | "ordinary" = "preference-change",
) {
  const state = titleFixture(),
    http = makeTextGenerationHttpFixture();
  for (let index = 1; index <= 5; index++) state.addSuccess(index);
  state.appendAssistant("Implemented native routing; add focused regression coverage next.");
  let turnId = TurnId.makeUnsafe("dispatch-race-turn");
  if (mode === "fallback")
    await Effect.runPromise(
      state.dispatch({
        type: "thread.activity.append",
        threadId: state.thread.id,
        commandId: "fixture:verified-native" as never,
        createdAt: state.thread.createdAt,
        activity: {
          id: EventId.makeUnsafe("verified-native"),
          kind: "text-generation.model-succeeded",
          payload: textGenerationSelection,
          tone: "info",
          summary: "Verified native success",
          turnId,
          createdAt: state.thread.createdAt,
        },
      }),
    );
  const settingsFor = (selection: ModelSelection) => ({
    ...DEFAULT_SERVER_SETTINGS,
    textGenerationModelSelection: selection,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: true },
    },
  });
  const safe: ModelSelection = { provider: "codex", model: "safe-first" };
  let settings = settingsFor(safe),
    reads = 0,
    ordinaryCalls = 0;
  const serverSettingsService = {
    ...state.services.serverSettingsService,
    getSettings: Effect.sync(() => {
      const captured = settings;
      if (++reads === 1 && mode === "preference-change")
        settings = settingsFor(textGenerationSelection);
      return captured;
    }),
  };
  const snapshot = () => ({
    ...state.thread,
    branch: "bigbud/12345678",
    elevatorSummaryMessageCount: 0,
    interactionMode: "default" as const,
    latestTurn: { turnId, state: "completed" },
    session: { status: "ready", activeTurnId: null },
    queuedPrompts: [],
  });
  const engine = {
    ...state.services.orchestrationEngine,
    getReadModel: () => Effect.succeed({ threads: [snapshot()], projects: [] } as never),
    dispatch: ((command) =>
      state.dispatch(command).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (
              command.type === "thread.activity.append" &&
              (command.activity.payload as { uncertaintyProtected?: boolean } | null)
                ?.uncertaintyProtected
            )
              settings = settingsFor({ ...textGenerationSelection, model: "changed-after-claim" });
          }),
        ),
      )) as SessionOpServices["orchestrationEngine"]["dispatch"],
  };
  const atDispatch: Array<typeof state.thread.activities> = [],
    finishers: Array<(text: string) => void> = [];
  http.options.generate = () => {
    atDispatch.push([...state.thread.activities]);
    return new Promise((resolve) => {
      finishers.push(resolve);
    });
  };
  const ordinary = () =>
    Effect.suspend(() => {
      ordinaryCalls++;
      return Effect.fail(
        new TextGenerationError({
          operation: "fixture",
          kind: "provider",
          detail: "Known pre-dispatch refusal",
        }),
      );
    });
  const safeService: TextGenerationShape = {
    generateBranchName: ordinary,
    generateCommitMessage: ordinary,
    generatePrContent: ordinary,
    generatePromptSuggestion: ordinary,
    generateThreadTitle: ordinary,
    generateThreadElevatorSummary: ordinary,
  };
  const router = () => {
    const native = makeV2AuxiliaryTextGenerator({ ...http, maxConcurrent: 4, timeoutMs: 60_000 });
    const service = makeOpencodeV2TextGeneration(
      makeV2StructuredTextRunner((request, signal) =>
        native({
          directory: request.cwd,
          operation: request.operation,
          prompt: request.prompt,
          selection: request.modelSelection,
          signal,
        }),
      ),
    );
    return makeInternalTextGenerationRouter({
      codex: safeService,
      claude: safeService,
      cursor: safeService,
      opencodeV2: service,
      serverSettingsService,
      opencodeServerManager: {} as never,
    });
  };
  let generation = router();
  const services = (): SessionOpServices => ({
    ...state.services,
    orchestrationEngine: engine,
    resolveThread: () => Effect.succeed(snapshot() as never),
    serverSettingsService,
    textGeneration: generation,
  });
  return {
    state,
    http,
    atDispatch,
    services,
    ordinaryCalls: () => ordinaryCalls,
    restoreNative: () => {
      settings = settingsFor(textGenerationSelection);
    },
    restartRouter: () => {
      generation = router();
    },
    finish: (
      index: number,
      text = JSON.stringify({ suggestion: "Add focused tests for native routing." }),
    ) => finishers[index]?.(text),
    finishAll: () => finishers.forEach((finish) => finish("late result")),
    nextTurn: () => {
      turnId = TurnId.makeUnsafe("dispatch-race-next-human-turn");
      state.addSuccess(6);
      state.appendAssistant("Finished the next human task.");
    },
    startSuggestions: async () => {
      const events = await Effect.runPromise(PubSub.unbounded<ProviderRuntimeEvent>());
      const controller = new AbortController();
      let ready!: () => void;
      const entered = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const running = Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* startPromptSuggestionReactor({
              orchestrationEngine: { ...engine, streamDomainEvents: Stream.never },
              providerEvents: Stream.fromPubSub(events),
              getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
              getSettings: serverSettingsService.getSettings,
              resolveCwd: () => Effect.succeed("/fixture"),
              textGeneration: generation,
            });
            yield* Effect.yieldNow;
            ready();
            return yield* Effect.never;
          }),
        ),
        { signal: controller.signal },
      );
      await entered;
      return {
        publish: () =>
          Effect.runPromise(
            PubSub.publish(events, {
              type: "turn.completed",
              threadId: state.thread.id,
              turnId,
              payload: { state: "completed" },
            } as ProviderRuntimeEvent),
          ),
        stop: async () => {
          controller.abort();
          await running;
        },
      };
    },
  };
}
