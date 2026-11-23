/**
 * `list_available_models`: the read-only sibling of `create_thread` (D6). Lists only models the
 * user can use right now for a tributary of the caller, recently used first.
 *
 * @module ThreadOrchestrationTools.listAvailableModels
 */
import { ModelSelection, type ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";

import {
  type OrchestrationEngineShape,
  ensureOrchestrationProjectState,
  getOrchestrationThread,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import {
  loadModelChoiceContext,
  resolveDelegatedChildTarget,
} from "./ThreadOrchestrationTools.modelChoice.context.ts";
import {
  indexEffortCatalog,
  listDelegatedEffort,
} from "./ThreadOrchestrationTools.modelChoice.effort.ts";
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
    const caller = yield* getOrchestrationThread(input.orchestrationEngine, input.callerThreadId);
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
    const project = yield* ensureOrchestrationProjectState(
      input.orchestrationEngine,
      caller.projectId,
    ).pipe(Effect.orElseSucceed(() => null));
    const target = resolveDelegatedChildTarget(project ?? undefined, caller);
    const scope = {
      providerRuntimeExecutionTargetId: target.providerRuntimeExecutionTargetId ?? null,
      workspaceExecutionTargetId: target.workspaceExecutionTargetId ?? null,
      modelCatalog: "local-registry" as const,
      targetEffortCatalogAvailable: isLocalExecutionTarget(target.providerRuntimeExecutionTargetId),
    };
    const context = yield* loadModelChoiceContext({
      sources: input.modelSources,
      qualifyWorkspaceEffort: true,
      target,
    });
    if (context === null) {
      return {
        parentModel,
        scope: { ...scope, targetEffortCatalogAvailable: false },
        agentModelChoice: "agent" as const,
        catalogAvailable: false,
        models: [],
        hasMore: false,
      };
    }
    const agentModelChoice = context.settings.delegatedThreadModelChoice;
    const ranked =
      agentModelChoice === "parent" || !Schema.is(ModelSelection)(caller.modelSelection)
        ? []
        : listRankedUsableModels(context, caller.modelSelection);
    const effortCatalog = indexEffortCatalog(context);
    const summarize = (option: (typeof ranked)[number]) => ({
      provider: option.selection.provider,
      providerLabel: option.providerLabel,
      model: option.selection.model,
      name: option.label,
      ...("subProviderID" in option.selection && option.selection.subProviderID !== undefined
        ? { subProviderID: option.selection.subProviderID }
        : {}),
      lastUsedAt: option.lastUsedAt,
      isParentModel: option.isFallback,
      effort: listDelegatedEffort(context, option.selection, effortCatalog),
    });
    return {
      parentModel,
      scope,
      agentModelChoice,
      catalogAvailable: true,
      models: ranked.slice(0, limit).map(summarize),
      hasMore: ranked.length > limit,
    };
  },
);
