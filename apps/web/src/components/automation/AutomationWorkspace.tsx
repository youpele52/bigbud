import {
  BUILT_IN_CHATS_PROJECT_ID,
  ProjectId,
  isBuiltInChatsProject,
  type AutomationId,
} from "@bigbud/contracts";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import type { Project } from "~/models/types";
import { readNativeApi } from "~/rpc/nativeApi";
import { useDefaultChatCwd } from "~/rpc/serverState";
import { useWsConnectionStatus } from "~/rpc/wsConnectionState";
import { useStore } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";
import {
  buildAutomationProjectLabelById,
  listAllAutomations,
  type AutomationProjectOption,
} from "./automationDirectory";
import { AutomationListRow } from "./AutomationListRow";

type AutomationSummary = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["listAutomations"]>
>["automations"][number];

export interface AutomationWorkspaceState {
  readonly automations: ReadonlyArray<AutomationSummary>;
  readonly loading: boolean;
  readonly projectOptions: ReadonlyArray<AutomationProjectOption>;
  readonly projectLabelById: ReadonlyMap<ProjectId, string>;
  readonly selectedProject: Project | null;
  readonly selectedProjectId: ProjectId | null;
  readonly setSelectedProjectId: (projectId: ProjectId) => void;
  readonly reloadAutomations: () => Promise<void>;
}

export function useAutomationWorkspace(
  preferredProjectId?: ProjectId | null,
): AutomationWorkspaceState {
  const api = readNativeApi();
  const allProjects = useStore((store) => store.projects);
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const wsPhase = useWsConnectionStatus().phase;
  const uiSelectedProjectId = useUiStateStore((store) => store.selectedProjectId);
  const defaultChatCwd = useDefaultChatCwd();
  const readyToLoad = Boolean(api) && bootstrapComplete && wsPhase === "connected";
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [automations, setAutomations] = useState<ReadonlyArray<AutomationSummary>>([]);
  const [loading, setLoading] = useState(true);

  const { projects, projectOptions } = useMemo(() => {
    const visibleProjects = allProjects.filter((project) => !isBuiltInChatsProject(project.id));
    const options: AutomationProjectOption[] = [
      { id: BUILT_IN_CHATS_PROJECT_ID, label: "Chats", isChats: true },
      ...visibleProjects.map((project) => ({
        id: project.id,
        label: project.name,
        isChats: false,
      })),
    ];
    return { projects: visibleProjects, projectOptions: options };
  }, [allProjects]);
  const projectLabelById = useMemo(
    () => buildAutomationProjectLabelById(projectOptions),
    [projectOptions],
  );

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    const fallbackProjectId = resolveAutomationDefaultProjectId({
      defaultChatCwd,
      preferredProjectId: preferredProjectId ?? null,
      projects,
      uiSelectedProjectId,
    });

    if (
      preferredProjectId &&
      (preferredProjectId === BUILT_IN_CHATS_PROJECT_ID || projectIds.has(preferredProjectId)) &&
      preferredProjectId !== selectedProjectId
    ) {
      setSelectedProjectId(preferredProjectId);
      return;
    }

    const isSelectedProjectValid =
      selectedProjectId === BUILT_IN_CHATS_PROJECT_ID ||
      (selectedProjectId !== null && projectIds.has(selectedProjectId));

    if (!isSelectedProjectValid && fallbackProjectId !== selectedProjectId) {
      setSelectedProjectId(fallbackProjectId);
    }
  }, [defaultChatCwd, preferredProjectId, projects, selectedProjectId, uiSelectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const loadAutomations = useCallback(async () => {
    if (!api || !readyToLoad) {
      return;
    }

    setLoading(true);
    try {
      const result = await listAllAutomations(api.server);
      setAutomations(result);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to load automations",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      setAutomations([]);
    } finally {
      setLoading(false);
    }
  }, [api, readyToLoad]);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  return {
    automations,
    loading: loading || !readyToLoad,
    projectOptions,
    projectLabelById,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId,
    reloadAutomations: loadAutomations,
  };
}

export function AutomationListContent({
  automations,
  className,
  layout = "standalone",
  loading,
  onAutomationsChange,
  selectedAutomationId,
  viewingAutomationId = null,
}: {
  readonly automations: ReadonlyArray<AutomationSummary>;
  readonly className?: string;
  readonly layout?: "inset" | "standalone";
  readonly loading: boolean;
  readonly onAutomationsChange: () => void;
  readonly selectedAutomationId: AutomationId | null;
  readonly viewingAutomationId?: AutomationId | null;
}) {
  const contentWidthClass =
    layout === "inset" ? "w-full" : "mx-auto w-full max-w-[44rem] px-4 sm:px-6";

  return (
    <div className={className ?? "min-h-0 flex-1 overflow-y-auto"}>
      {loading ? (
        <p className={`${contentWidthClass} py-4 text-sm text-muted-foreground`}>
          Loading automations...
        </p>
      ) : null}
      {!loading && automations.length === 0 ? (
        <p className={`${contentWidthClass} py-4 text-sm text-muted-foreground`}>
          No automations yet.
        </p>
      ) : null}
      {!loading && automations.length > 0 ? (
        <div className={contentWidthClass}>
          {automations.map((automation) => (
            <AutomationListRow
              key={automation.automationId}
              automation={automation}
              onAutomationsChange={onAutomationsChange}
              selected={selectedAutomationId === automation.automationId}
              viewingAutomationId={viewingAutomationId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AutomationListPane({
  automations,
  className,
  footer,
  loading,
  onAutomationsChange,
  selectedAutomationId,
  viewingAutomationId = null,
}: {
  readonly automations: ReadonlyArray<AutomationSummary>;
  readonly className?: string;
  readonly footer?: ReactNode;
  readonly loading: boolean;
  readonly onAutomationsChange: () => void;
  readonly selectedAutomationId: AutomationId | null;
  readonly viewingAutomationId?: AutomationId | null;
}) {
  return (
    <aside
      className={`flex min-h-0 flex-col border-r border-border/70 ${className ?? "min-w-0 flex-1"}`}
    >
      <AutomationListContent
        automations={automations}
        loading={loading}
        onAutomationsChange={onAutomationsChange}
        selectedAutomationId={selectedAutomationId}
        viewingAutomationId={viewingAutomationId}
      />
      {footer ? <div className="shrink-0 px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2">{footer}</div> : null}
    </aside>
  );
}

export function resolveAutomationDefaultProjectId(input: {
  readonly defaultChatCwd: string | null;
  readonly preferredProjectId: ProjectId | null;
  readonly projects: ReadonlyArray<Project>;
  readonly uiSelectedProjectId: ProjectId | null;
}): ProjectId | null {
  const projectIds = new Set(input.projects.map((project) => project.id));

  if (
    input.preferredProjectId &&
    (input.preferredProjectId === BUILT_IN_CHATS_PROJECT_ID ||
      projectIds.has(input.preferredProjectId))
  ) {
    return input.preferredProjectId;
  }

  if (
    input.uiSelectedProjectId &&
    (input.uiSelectedProjectId === BUILT_IN_CHATS_PROJECT_ID ||
      projectIds.has(input.uiSelectedProjectId))
  ) {
    return input.uiSelectedProjectId;
  }

  if (input.defaultChatCwd) {
    const defaultChatProject = input.projects.find(
      (project) => project.cwd === input.defaultChatCwd,
    );
    if (defaultChatProject) {
      return defaultChatProject.id;
    }
  }

  return BUILT_IN_CHATS_PROJECT_ID;
}
