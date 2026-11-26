import { realpath } from "node:fs/promises";
import { Effect, Option } from "effect";

import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";
import {
  resolveProviderSessionExecutionTargets,
  type ProviderSessionExecutionTargetsInput,
} from "../provider/providerSessionExecutionTargets.ts";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import type { ThreadToolModelSources } from "./ThreadOrchestrationToolDispatcher.ts";
import type { ModelChoiceContext } from "./ThreadOrchestrationTools.modelChoice.usable.ts";

/** Enough recency for ranking; the query is deduplicated per provider+model+subProviderID. */
export const RECENT_MODEL_SELECTION_LIMIT = 200;

/**
 * Reads the cached inputs of a model decision. Never fails: missing sources, unreadable settings
 * or any defect yield `null` (reason `catalog-unavailable`, the trunk's model is used).
 */
export const loadModelChoiceContext = Effect.fn("loadModelChoiceContext")(function* (input: {
  readonly sources: ThreadToolModelSources | null | undefined;
  readonly target: ModelChoiceContext["target"];
  readonly qualifyWorkspaceEffort?: boolean;
}) {
  const sources = input.sources;
  if (!sources) return null;
  return yield* Effect.gen(function* () {
    const settings = yield* Effect.option(sources.getSettings);
    if (Option.isNone(settings)) return null;
    const providers = yield* sources.getProviders;
    const recent = yield* sources
      .listRecent(RECENT_MODEL_SELECTION_LIMIT)
      .pipe(Effect.orElseSucceed(() => []));
    const { workspaceRoot } = input.target;
    const opencode =
      input.qualifyWorkspaceEffort &&
      isLocalExecutionTarget(input.target.providerRuntimeExecutionTargetId) &&
      isLocalExecutionTarget(input.target.workspaceExecutionTargetId)
        ? providers.find((provider) => provider.provider === "opencodeV2")
        : undefined;
    const readWorkspaceModels = opencode && sources.getOpencodeWorkspaceModels;
    // OpenCode's native catalog uses the canonical Location, not the user's path spelling.
    const canonicalRoot =
      workspaceRoot &&
      (readWorkspaceModels || opencode?.models.some((model) => model.effortCatalogDirectory))
        ? yield* Effect.promise(() => realpath(workspaceRoot).catch(() => undefined))
        : workspaceRoot;
    const workspaceModels =
      readWorkspaceModels && canonicalRoot ? readWorkspaceModels(canonicalRoot) : undefined;
    const scopedOpencode =
      opencode && workspaceModels !== undefined
        ? { ...opencode, models: workspaceModels }
        : undefined;
    return {
      providers:
        scopedOpencode === undefined
          ? providers
          : providers.map((provider) => (provider === opencode ? scopedOpencode : provider)),
      settings: settings.value,
      recent,
      target: {
        ...input.target,
        workspaceRoot:
          readWorkspaceModels && workspaceModels === undefined ? undefined : canonicalRoot,
      },
      hasInteractiveClient: sources.hasInteractiveClient(),
    } satisfies ModelChoiceContext;
  }).pipe(Effect.catchCause(() => Effect.succeed(null)));
});

/** Mirror the thread.create decider's effective targets, including legacy project defaults. */
export function resolveDelegatedChildTarget(
  project:
    | (ProviderSessionExecutionTargetsInput & { readonly workspaceRoot: string | null })
    | undefined,
  sameProjectCaller?: ProviderSessionExecutionTargetsInput,
): ModelChoiceContext["target"] {
  return {
    ...resolveProviderSessionExecutionTargets({
      providerRuntimeExecutionTargetId: sameProjectCaller?.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: sameProjectCaller?.workspaceExecutionTargetId,
      executionTargetId: sameProjectCaller?.executionTargetId,
      defaultProviderRuntimeExecutionTargetId:
        project?.providerRuntimeExecutionTargetId ??
        project?.executionTargetId ??
        LOCAL_EXECUTION_TARGET_ID,
      defaultWorkspaceExecutionTargetId:
        project?.workspaceExecutionTargetId ??
        project?.executionTargetId ??
        LOCAL_EXECUTION_TARGET_ID,
    }),
    workspaceRoot: project?.workspaceRoot,
  };
}
