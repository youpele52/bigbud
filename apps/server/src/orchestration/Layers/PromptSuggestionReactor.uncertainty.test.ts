import { Duration, Effect, PubSub, Stream } from "effect";
import { expect, it, vi } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import { startPromptSuggestionReactor } from "./PromptSuggestionReactor.ts";
import { textGenerationSelection } from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import { makeInternalTextGenerationRouter } from "../../git/Layers/RoutingTextGeneration.ts";

it.each(["uncertain", "timeout"])(
  "%s suggestion jobs retain a per-turn hold across duplicate events and reactor restart",
  async (scenario) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe("suggestion-uncertain"),
            turnId = TurnId.makeUnsafe("turn-2");
          let thread = {
            id: threadId,
            interactionMode: "default",
            modelSelection: textGenerationSelection,
            latestTurn: { turnId, state: "completed" },
            session: { status: "ready", activeTurnId: null },
            archivedAt: null,
            deletingAt: null,
            deletedAt: null,
            queuedPrompts: [],
            activities: [],
            messages: ["user", "assistant", "user", "assistant"].map((role, index) => ({
              id: MessageId.makeUnsafe(`m${index}`),
              role,
              text: "Build and test native routing",
              streaming: false,
            })),
          } as unknown as OrchestrationThread;
          const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
          const generate = vi.fn(() =>
            scenario === "timeout"
              ? Effect.never
              : Effect.fail(
                  new TextGenerationError({
                    operation: "generatePromptSuggestion",
                    kind: "uncertain",
                    uncertaintyId: "ses_retained",
                    detail: "Unconfirmed",
                  }),
                ),
          );
          const settings = {
            ...DEFAULT_SERVER_SETTINGS,
            textGenerationModelSelection: textGenerationSelection,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: true },
            },
          };
          const router = makeInternalTextGenerationRouter({
            codex: {} as never,
            claude: {} as never,
            cursor: {} as never,
            opencodeV2: { generatePromptSuggestion: generate } as never,
            serverSettingsService: { getSettings: Effect.succeed(settings) } as never,
            opencodeServerManager: {} as never,
          });
          const start = () =>
            startPromptSuggestionReactor({
              orchestrationEngine: {
                getReadModel: () => Effect.succeed({ threads: [thread], projects: [] } as never),
                streamDomainEvents: Stream.empty as Stream.Stream<OrchestrationEvent>,
                dispatch: (command) =>
                  Effect.sync(() => {
                    if (command.type === "thread.activity.append")
                      thread = { ...thread, activities: [...thread.activities, command.activity] };
                    return { sequence: 1 } as never;
                  }),
              },
              providerEvents: Stream.fromPubSub(events),
              getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
              textGeneration: router,
              resolveCwd: () => Effect.succeed("/fixture"),
              timeout: Duration.millis(10),
              getSettings: Effect.succeed(settings),
            });
          yield* start();
          yield* Effect.yieldNow;
          const event = {
            type: "turn.completed",
            threadId,
            turnId,
            payload: { state: "completed" },
          } as ProviderRuntimeEvent;
          yield* PubSub.publish(events, event);
          yield* Effect.promise(() =>
            vi.waitFor(() =>
              expect(
                thread.activities.some((item) => item.kind === "text-generation.uncertain"),
              ).toBe(true),
            ),
          );
          yield* PubSub.publish(events, event);
          yield* Effect.sleep("20 millis");
          expect(generate).toHaveBeenCalledTimes(1);
          yield* start();
          yield* Effect.yieldNow;
          yield* PubSub.publish(events, event);
          yield* Effect.sleep("20 millis");
          expect(generate).toHaveBeenCalledTimes(1);
        }),
      ),
    );
  },
);
