import { BUILT_IN_CHATS_PROJECT_ID, type ModelSelection, type ProjectId } from "@bigbud/contracts";

import { buildExplicitExecutionTargets } from "~/lib/providerExecutionTargets";
import { getDefaultModelSelection } from "~/models/provider/provider.models";
import type { Project } from "~/models/types";
import { readNativeApi } from "~/rpc/nativeApi";
import { useServerProviders } from "~/rpc/serverState";

import type { AutomationSkillRequest } from "~/lib/automation";
import type { AutomationProjectOption } from "./automationDirectory";
import { invalidateAutomationThreadIds } from "./automationThreadIds.store";

type NativeApi = NonNullable<ReturnType<typeof readNativeApi>>;
type CreateOwnedAutomationInput = Parameters<NativeApi["server"]["createOwnedAutomation"]>[0];
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
  input: Omit<
    CreateOwnedAutomationInput,
    "modelSelection" | "runtimeMode" | "interactionMode" | "branch" | "worktreePath"
  >,
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
  input: Omit<
    CreateOwnedAutomationInput,
    "modelSelection" | "runtimeMode" | "interactionMode" | "branch" | "worktreePath"
  >,
) {
  const { automations } = await api.server.listAllAutomations({});
  return automations.find((automation) => isSameAutomationRequest(automation, input)) ?? null;
}

function automationOwnedThreadInput(input: {
  defaultChatCwd: string | null;
  modelSelection: ModelSelection | null;
  projectId: ProjectId;
  project: Project | null;
  providers: ReturnType<typeof useServerProviders>;
}): Pick<
  CreateOwnedAutomationInput,
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "branch"
  | "worktreePath"
  | "providerRuntimeExecutionTargetId"
  | "workspaceExecutionTargetId"
  | "executionTargetId"
> {
  const { defaultChatCwd, modelSelection, projectId, project, providers } = input;
  const base = {
    modelSelection: modelSelection ?? getDefaultModelSelection(providers),
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
  };

  if (projectId === BUILT_IN_CHATS_PROJECT_ID) {
    return {
      ...base,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      worktreePath: defaultChatCwd,
    };
  }

  if (!project) {
    throw new Error("Project not found for automation request.");
  }

  const executionTargets = buildExplicitExecutionTargets({
    providerRuntimeExecutionTargetId: project.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: project.workspaceExecutionTargetId,
  });
  return {
    ...base,
    ...executionTargets,
    modelSelection:
      modelSelection ?? project.defaultModelSelection ?? getDefaultModelSelection(providers),
    worktreePath: null,
  };
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
  } satisfies Omit<
    CreateOwnedAutomationInput,
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
    | "providerRuntimeExecutionTargetId"
    | "workspaceExecutionTargetId"
    | "executionTargetId"
  >;

  const existingAutomation = await findExistingAutomation(api, createInput);
  if (existingAutomation) {
    invalidateAutomationThreadIds();
    return { automation: existingAutomation, created: false as const };
  }

  const { automation } = await api.server.createOwnedAutomation({
    ...createInput,
    ...automationOwnedThreadInput({
      defaultChatCwd,
      projectId,
      project: projectOptions.find((option) => option.id === projectId)?.isChats
        ? null
        : (allProjects.find((project) => project.id === projectId) ?? null),
      modelSelection,
      providers,
    }),
  });
  invalidateAutomationThreadIds();
  return { automation, created: true as const };
}
