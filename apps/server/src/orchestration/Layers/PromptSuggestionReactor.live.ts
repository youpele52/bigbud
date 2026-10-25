/**
 * Wires the generated prompt suggestion reactor to the live services. Started by the provider
 * command reactor, which already owns these services.
 *
 * @module PromptSuggestionReactor.live
 */
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { resolveDefaultChatCwd, ServerSettingsService } from "../../ws/serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { startPromptSuggestionReactor } from "./PromptSuggestionReactor.ts";

export const makePromptSuggestionReactorStart = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;

  return () =>
    startPromptSuggestionReactor({
      orchestrationEngine,
      providerEvents: providerService.streamEvents,
      getCapabilities: providerService.getCapabilities,
      textGeneration,
      getSettings: serverSettingsService.getSettings,
      resolveCwd: (thread) =>
        Effect.gen(function* () {
          const settings = yield* serverSettingsService.getSettings.pipe(
            Effect.catch(() => Effect.succeed(DEFAULT_SERVER_SETTINGS)),
          );
          const readModel = yield* orchestrationEngine.getReadModel();
          return (
            resolveThreadWorkspaceCwd({ thread, projects: readModel.projects }) ??
            resolveDefaultChatCwd(settings)
          );
        }),
    });
});
