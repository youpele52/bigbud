import {
  BUILT_IN_CHATS_PROJECT_ID,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@bigbud/contracts";

import { buildExplicitExecutionTargets } from "~/lib/providerExecutionTargets";
import { newCommandId, newThreadId } from "~/lib/utils";
import { getDefaultModelSelection } from "~/models/provider/provider.models";
import type { Project } from "~/models/types";
import { readNativeApi } from "~/rpc/nativeApi";
import { useServerProviders } from "~/rpc/serverState";

import type { AutomationSkillRequest } from "~/lib/automation";
import type { AutomationProjectOption } from "./automationDirectory";
import { invalidateAutomationThreadIds } from "./automationThreadIds.store";
import { syncAutomationTargetThreadModelSelection } from "./automationComposer";

type NativeApi = NonNullable<ReturnType<typeof readNativeApi>>;
type CreateAutomationInput = Parameters<NativeApi["server"]["createAutomation"]>[0];
type AutomationSummary = Awaited<
  ReturnType<NativeApi["server"]["listAllAutomations"]>
>["automations"][number];

export function resolveProjectForAutomationRequest(
  projectTitle: string | undefined,
  selectedProjectId: ProjectId | null,
  projectOptions: ReadonlyArray<{
    readonly id: ProjectId;
    readonly label: string;
    readonly isChats: boolean;
  }>,
) {
  if (!projectTitle) {
    if (!selectedProjectId) {
      throw new Error("Select a project before creating an automation.");
    }
    return selectedProjectId;
  }

  const normalizedTitle = projectTitle.trim().toLowerCase();
  const matchingOption = projectOptions.find(
    (option) => option.label.toLowerCase() === normalizedTitle,
  );
  if (matchingOption) {
    return matchingOption.id;
  }

  const matchingProject = projectOptions.find(
    (option) => !option.isChats && option.label.toLowerCase() === normalizedTitle,
  );
  if (!matchingProject) {
    throw new Error(`Project '${projectTitle}' was not found.`);
  }
  return matchingProject.id;
}

function isSameAutomationRequest(
  automation: AutomationSummary,
  input: Omit<CreateAutomationInput, "targetThreadId">,
) {
  return (
    automation.deletedAt === null &&
    automation.projectId === input.projectId &&
    automation.title === input.title &&
    automation.prompt === input.prompt &&
    automation.scheduleKind === input.scheduleKind &&
    automation.cronExpression === input.cronExpression &&
    automation.timezone === input.timezone &&
    (automation.runAt ?? null) === (input.runAt ?? null)
  );
}

async function findExistingAutomation(
  api: NativeApi,
  input: Omit<CreateAutomationInput, "targetThreadId">,
) {
  const { automations } = await api.server.listAllAutomations({});
  return automations.find((automation) => isSameAutomationRequest(automation, input)) ?? null;
}

export async function createAutomationWithRetry(
  api: NativeApi,
  input: CreateAutomationInput,
  attempts = 12,
) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await api.server.createAutomation(input);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : "";
      const shouldRetry = message.includes("Automation thread not found") && attempt < attempts - 1;
      if (!shouldRetry) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to create automation.");
}

export async function createAutomationTargetThread(input: {
  api: NativeApi;
  defaultChatCwd: string | null;
  modelSelection: ModelSelection | null;
  projectId: ProjectId;
  project: Project | null;
  providers: ReturnType<typeof useServerProviders>;
  title: string;
}): Promise<ThreadId> {
  const { api, defaultChatCwd, modelSelection, projectId, project, providers, title } = input;
  const threadId = newThreadId();

  if (projectId === BUILT_IN_CHATS_PROJECT_ID) {
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: BUILT_IN_CHATS_PROJECT_ID,
      title,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      modelSelection: modelSelection ?? getDefaultModelSelection(providers),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: defaultChatCwd,
      createdAt: new Date().toISOString(),
    });
    return threadId;
  }

  if (!project) {
    throw new Error("Project not found for automation request.");
  }

  const executionTargets = buildExplicitExecutionTargets({
    providerRuntimeExecutionTargetId: project.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: project.workspaceExecutionTargetId,
  });
  await api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: newCommandId(),
    threadId,
    projectId: project.id,
    title,
    ...executionTargets,
    modelSelection:
      modelSelection ?? project.defaultModelSelection ?? getDefaultModelSelection(providers),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}

export async function createAutomationFromRequest(input: {
  api: NativeApi;
  allProjects: ReadonlyArray<Project>;
  defaultChatCwd: string | null;
  modelSelection: ModelSelection | null;
  projectOptions: ReadonlyArray<AutomationProjectOption>;
  request: AutomationSkillRequest;
  selectedProjectId: ProjectId | null;
  providers: ReturnType<typeof useServerProviders>;
}) {
  const {
    api,
    allProjects,
    defaultChatCwd,
    modelSelection,
    projectOptions,
    request,
    selectedProjectId,
    providers,
  } = input;
  const projectId = resolveProjectForAutomationRequest(
    request.projectTitle,
    selectedProjectId,
    projectOptions,
  );
  const createInput = {
    projectId,
    title: request.title,
    prompt: request.prompt,
    scheduleKind: request.scheduleKind,
    scheduleLabel: request.scheduleLabel,
    cronExpression: request.cronExpression,
    timezone: request.timezone,
    ...(request.runAt ? { runAt: request.runAt } : {}),
  } satisfies Omit<CreateAutomationInput, "targetThreadId">;

  const existingAutomation = await findExistingAutomation(api, createInput);
  if (existingAutomation) {
    invalidateAutomationThreadIds();
    return { automation: existingAutomation, created: false as const };
  }

  let targetThreadId: ThreadId | null = null;
  try {
    targetThreadId = await createAutomationTargetThread({
      api,
      defaultChatCwd,
      projectId,
      project: projectOptions.find((option) => option.id === projectId)?.isChats
        ? null
        : (allProjects.find((project) => project.id === projectId) ?? null),
      modelSelection,
      providers,
      title: request.title,
    });

    const { automation } = await createAutomationWithRetry(api, {
      ...createInput,
      targetThreadId,
    });
    await syncAutomationTargetThreadModelSelection(api, {
      modelSelection,
      targetThreadId,
    });
    invalidateAutomationThreadIds();
    return { automation, created: true as const };
  } catch (error) {
    if (targetThreadId) {
      await api.orchestration
        .dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: targetThreadId,
        })
        .catch(() => undefined);
    }
    throw error;
  }
}
