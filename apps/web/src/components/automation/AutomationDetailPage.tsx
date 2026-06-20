import { AutomationId, isBuiltInChatsProject } from "@bigbud/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { usePageTitle } from "~/hooks/usePageTitle";
import {
  AUTOMATION_SKILL_PROMPT,
  extractAutomationRequest,
  findLatestAutomationAssistantMessage,
  getDeviceTimeZone,
  resolveAutomationStatus,
  validateAutomationSkillRequest,
} from "~/lib/automation";
import { readNativeApi } from "~/rpc/nativeApi";
import { EMPTY_THREAD_DRAFT, useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { AutomationDetailActions } from "./AutomationDetailActions";
import { AutomationDetailPane } from "./AutomationDetailPane";
import { AutomationDetailPageHeader } from "./AutomationPageHeader";
import { AutomationPageShell } from "./AutomationPageShell";
import {
  resolveAutomationComposerModelSelection,
  syncAutomationTargetThreadModelSelection,
} from "./automationComposer";
import { useAutomationEditorThread } from "./useAutomationEditorThread";

type AutomationDetail = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["getAutomation"]>
>["automation"];
type AutomationRun = Awaited<
  ReturnType<NonNullable<ReturnType<typeof readNativeApi>>["server"]["listAutomationRuns"]>
>["runs"][number];

interface AutomationDetailPageProps {
  readonly automationId: AutomationId;
}

export function AutomationDetailPage({ automationId }: AutomationDetailPageProps) {
  const api = readNativeApi();
  const [automation, setAutomation] = useState<AutomationDetail | null>(null);
  const [runs, setRuns] = useState<ReadonlyArray<AutomationRun>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestMessageId, setRequestMessageId] = useState<string | null>(null);
  const handledAssistantMessageIdRef = useRef<string | null>(null);
  const allProjects = useStore((store) => store.projects);
  const thread = useStore((store) =>
    automation
      ? (store.threads.find((candidate) => candidate.id === automation.targetThreadId) ?? null)
      : null,
  );
  const { thread: editorThread, threadId: editorThreadId } = useAutomationEditorThread(
    automation?.projectId ?? null,
    automation ? `${automation.automationId}:${automation.updatedAt}` : null,
  );
  const editorDraft = useComposerDraftStore((store) =>
    editorThreadId
      ? (store.draftsByThreadId[editorThreadId] ?? EMPTY_THREAD_DRAFT)
      : EMPTY_THREAD_DRAFT,
  );

  const latestAssistantMessage = useMemo(
    () =>
      editorThread
        ? findLatestAutomationAssistantMessage(editorThread.messages, requestMessageId)
        : null,
    [editorThread, requestMessageId],
  );

  usePageTitle(automation?.title ?? "Automation");

  const load = useCallback(async () => {
    if (!api) {
      return;
    }

    setLoading(true);
    setLoadError(null);
    try {
      const [automationResult, runsResult] = await Promise.all([
        api.server.getAutomation({ automationId }),
        api.server.listAutomationRuns({ automationId, limit: 10 }),
      ]);
      setAutomation(automationResult.automation);
      setRuns(runsResult.runs);
    } catch (error) {
      const description = error instanceof Error ? error.message : "An error occurred.";
      setAutomation(null);
      setRuns([]);
      setLoadError(description);
      toastManager.add({
        type: "error",
        title: "Failed to load automation",
        description,
      });
    } finally {
      setLoading(false);
    }
  }, [api, automationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!editorThreadId || !thread?.modelSelection) {
      return;
    }

    useComposerDraftStore.getState().setModelSelection(editorThreadId, thread.modelSelection);
  }, [editorThreadId, thread?.modelSelection]);

  useEffect(() => {
    const automationRequest = latestAssistantMessage
      ? extractAutomationRequest(latestAssistantMessage.text)
      : null;

    if (!api || !automation || !editorThreadId || !latestAssistantMessage || !automationRequest) {
      return;
    }

    if (handledAssistantMessageIdRef.current === latestAssistantMessage.id) {
      return;
    }

    handledAssistantMessageIdRef.current = latestAssistantMessage.id;

    void (async () => {
      try {
        const validationError = validateAutomationSkillRequest(automationRequest);
        if (validationError) {
          throw new Error(validationError);
        }

        const modelSelection = resolveAutomationComposerModelSelection(editorDraft);
        await api.server.updateAutomation({
          automationId,
          title: automationRequest.title,
          prompt: automationRequest.prompt,
          scheduleKind: automationRequest.scheduleKind,
          scheduleLabel: automationRequest.scheduleLabel,
          cronExpression: automationRequest.cronExpression,
          timezone: automationRequest.timezone || getDeviceTimeZone(),
          runAt: automationRequest.runAt ?? null,
        });
        await syncAutomationTargetThreadModelSelection(api, {
          modelSelection,
          targetThreadId: automation.targetThreadId,
        });
        useComposerDraftStore.getState().setPrompt(editorThreadId, AUTOMATION_SKILL_PROMPT);
        setRequestMessageId(null);
        await load();
        toastManager.add({ type: "success", title: "Automation updated" });
      } catch (error) {
        handledAssistantMessageIdRef.current = null;
        toastManager.add({
          type: "error",
          title: "Failed to update automation",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    })();
  }, [api, automation, automationId, editorDraft, editorThreadId, latestAssistantMessage, load]);

  const projectName = useMemo(() => {
    if (!automation) {
      return "Unknown project";
    }
    if (isBuiltInChatsProject(automation.projectId)) {
      return "Chats";
    }
    const project = allProjects.find((candidate) => candidate.id === automation.projectId);
    return project?.name ?? automation.projectId;
  }, [allProjects, automation]);
  const modelLabel = thread?.modelSelection.model ?? "Unknown";
  const providerLabel = thread?.modelSelection.provider ?? "Unknown";
  const reasoningLabel = formatReasoningLabel(thread?.modelSelection.options);
  const statusLabel = automation ? resolveAutomationStatus(automation) : "Active";

  return (
    <AutomationPageShell
      header={
        <AutomationDetailPageHeader
          title={automation?.title ?? "Automation"}
          actions={
            automation ? (
              <AutomationDetailActions automation={automation} onReload={load} />
            ) : undefined
          }
        />
      }
    >
      {automation ? (
        <AutomationDetailPane
          automation={automation}
          editorThreadId={editorThreadId}
          loadError={loadError}
          loading={loading}
          modelLabel={modelLabel}
          onOptimisticUserMessage={setRequestMessageId}
          projectName={projectName}
          providerLabel={providerLabel}
          reasoningLabel={reasoningLabel}
          runs={runs}
          statusLabel={statusLabel}
        />
      ) : (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading automation...</p>
            ) : loadError ? (
              <div className="rounded-xl border border-border/70 bg-card/50 p-5">
                <h1 className="text-lg font-medium">Automation unavailable</h1>
                <p className="mt-2 text-sm text-muted-foreground">{loadError}</p>
              </div>
            ) : null}
          </div>
        </section>
      )}
    </AutomationPageShell>
  );
}

function formatReasoningLabel(options: Record<string, unknown> | null | undefined) {
  const rawValue = typeof options?.effort === "string" ? options.effort : options?.reasoningEffort;
  return typeof rawValue === "string" ? rawValue[0]?.toUpperCase() + rawValue.slice(1) : "Default";
}
