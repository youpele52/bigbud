/**
 * `list_available_models`: the read-only sibling of `create_thread` (D6). Lists only models the
 * user can use right now for a tributary of the caller, recently used first.
 *
 * @module ThreadOrchestrationTools.listAvailableModels
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import { loadModelChoiceContext } from "./ThreadOrchestrationTools.modelChoice.context.ts";
import { listRankedUsableModels } from "./ThreadOrchestrationTools.modelChoice.usable.ts";
import {
  LIST_AVAILABLE_MODELS_DEFAULT_LIMIT,
  LIST_AVAILABLE_MODELS_MAX_LIMIT,
} from "./threadOrchestrationBridge.shared.ts";

export const listAvailableModelsViaOrchestration = Effect.fn("listAvailableModelsViaOrchestration")(
  function* (input: {
    readonly orchestrationEngine: OrchestrationEngineShape;
    readonly callerThreadId: ThreadId;
    readonly limit?: number | undefined;
    readonly modelSources: ThreadToolModelSources | null | undefined;
  }) {
    const readModel = yield* input.orchestrationEngine.getReadModel();
    const caller = readModel.threads.find((thread) => thread.id === input.callerThreadId);
    if (!caller || caller.deletedAt !== null) {
      return yield* Effect.fail(new Error("Caller thread was not found."));
    }
    const limit = Math.min(
      LIST_AVAILABLE_MODELS_MAX_LIMIT,
      Math.max(1, Math.floor(input.limit ?? LIST_AVAILABLE_MODELS_DEFAULT_LIMIT)),
    );
    const parentModel = {
      provider: caller.modelSelection.provider,
      model: caller.modelSelection.model,
      ...("subProviderID" in caller.modelSelection && caller.modelSelection.subProviderID
        ? { subProviderID: caller.modelSelection.subProviderID }
        : {}),
    };
    const context = yield* loadModelChoiceContext({
      sources: input.modelSources,
      target: {
        providerRuntimeExecutionTargetId: caller.providerRuntimeExecutionTargetId,
        workspaceExecutionTargetId: caller.workspaceExecutionTargetId,
      },
    });
    if (context === null) {
      return {
        parentModel,
        agentModelChoice: "agent" as const,
        catalogAvailable: false,
        models: [],
        hasMore: false,
      };
    }
    const agentModelChoice = context.settings.delegatedThreadModelChoice;
    const ranked =
      agentModelChoice === "parent" ? [] : listRankedUsableModels(context, caller.modelSelection);
    return {
      parentModel,
      agentModelChoice,
      catalogAvailable: true,
      models: ranked.slice(0, limit).map((option) => ({
        provider: option.selection.provider,
        providerLabel: option.providerLabel,
        model: option.selection.model,
        name: option.label,
        ...("subProviderID" in option.selection && option.selection.subProviderID !== undefined
          ? { subProviderID: option.selection.subProviderID }
          : {}),
        lastUsedAt: option.lastUsedAt,
        isParentModel: option.isFallback,
      })),
      hasMore: ranked.length > limit,
    };
  },
);
