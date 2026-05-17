import {
  BUILT_IN_CHATS_PROJECT_ID,
  BUILT_IN_CHATS_PROJECT_TITLE,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  PROVIDER_KINDS,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Option, Path } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry";
import { ServerConfig } from "./config";
import { resolveDefaultChatCwd, ServerSettingsService } from "../ws/serverSettings";

/**
 * Resolve the default model selection for a newly bootstrapped project.
 *
 * Uses the first provider that is already ready in the current snapshot.
 * Falls back immediately to the first provider in PROVIDER_KINDS with its
 * static default model so startup never waits on optional provider probes.
 */
export const resolveBootstrapModelSelection = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const providers = yield* providerRegistry.getProviders;
  const provider = providers.find((candidate) => candidate.enabled && candidate.status === "ready");
  if (provider) {
    const model = provider.models[0]?.slug ?? DEFAULT_MODEL_BY_PROVIDER[provider.provider];
    return { provider: provider.provider, model } satisfies ModelSelection;
  }
  const fallbackProvider = PROVIDER_KINDS[0];
  return {
    provider: fallbackProvider,
    model: DEFAULT_MODEL_BY_PROVIDER[fallbackProvider],
  } satisfies ModelSelection;
});

export const autoBootstrapWelcome = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  const chatsProject = yield* orchestrationEngine
    .getReadModel()
    .pipe(
      Effect.map((readModel) =>
        readModel.projects.find((project) => project.id === BUILT_IN_CHATS_PROJECT_ID),
      ),
    );
  if (!chatsProject) {
    const createdAt = new Date(0).toISOString();
    yield* orchestrationEngine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      title: BUILT_IN_CHATS_PROJECT_TITLE,
      workspaceRoot: null,
      defaultModelSelection: null,
      createdAt,
    });
  }

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = new Date().toISOString();
        nextProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = yield* resolveBootstrapModelSelection;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection =
          existingProject.value.defaultModelSelection ?? (yield* resolveBootstrapModelSelection);
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = new Date().toISOString();
        const createdThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
        const targetProject = Option.getOrUndefined(existingProject);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          ...(targetProject?.providerRuntimeExecutionTargetId
            ? {
                providerRuntimeExecutionTargetId: targetProject.providerRuntimeExecutionTargetId,
              }
            : {}),
          ...(targetProject?.workspaceExecutionTargetId
            ? {
                workspaceExecutionTargetId: targetProject.workspaceExecutionTargetId,
              }
            : {}),
          ...(targetProject?.executionTargetId
            ? { executionTargetId: targetProject.executionTargetId }
            : {}),
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const defaultChatCwd = resolveDefaultChatCwd(settings);

  return {
    cwd: serverConfig.cwd,
    projectName,
    defaultChatCwd,
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});
