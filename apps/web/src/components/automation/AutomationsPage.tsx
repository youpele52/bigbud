import { type ProjectId } from "@bigbud/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, MessageSquareIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { ThreadComposerSurface } from "~/components/chat/view/ThreadComposerSurface";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { usePageTitle } from "~/hooks/usePageTitle";
import {
  AUTOMATION_SKILL_PROMPT,
  buildAutomationSkillDispatchPrompt,
  extractAutomationRequest,
  findLatestAutomationAssistantMessage,
  getDeviceTimeZone,
  validateAutomationSkillRequest,
} from "~/lib/automation";
import { readNativeApi } from "~/rpc/nativeApi";
import { useDefaultChatCwd, useServerProviders } from "~/rpc/serverState";
import { EMPTY_THREAD_DRAFT, useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { AutomationListContent, useAutomationWorkspace } from "./AutomationWorkspace";
import { AutomationListPageHeader } from "./AutomationPageHeader";
import { AutomationPageShell } from "./AutomationPageShell";
import { type AutomationProjectOption } from "./automationDirectory";
import { createAutomationFromRequest } from "./automationCreate";
import { resolveAutomationComposerModelSelection } from "./automationComposer";
import {
  disposeAutomationBuilderThread,
  useAutomationBuilderThread,
} from "./useAutomationBuilderThread";

export function AutomationsPage() {
  usePageTitle("Automations");

  const api = readNativeApi();
  const navigate = useNavigate();
  const allProjects = useStore((store) => store.projects);
  const defaultChatCwd = useDefaultChatCwd();
  const serverProviders = useServerProviders();
  const {
    automations,
    loading,
    projectOptions,
    reloadAutomations,
    selectedProjectId,
    setSelectedProjectId,
  } = useAutomationWorkspace();
  const { builderThread, builderThreadId } = useAutomationBuilderThread(selectedProjectId);
  const builderDraft = useComposerDraftStore((store) =>
    builderThreadId
      ? (store.draftsByThreadId[builderThreadId] ?? EMPTY_THREAD_DRAFT)
      : EMPTY_THREAD_DRAFT,
  );
  const [requestMessageId, setRequestMessageId] = useState<string | null>(null);
  const handledAssistantMessageIdRef = useRef<string | null>(null);
  const latestAssistantMessage = useMemo(
    () =>
      builderThread
        ? findLatestAutomationAssistantMessage(builderThread.messages, requestMessageId)
        : null,
    [builderThread, requestMessageId],
  );

  useEffect(() => {
    const automationRequest = latestAssistantMessage
      ? extractAutomationRequest(latestAssistantMessage.text)
      : null;

    if (!api || !builderThreadId || !latestAssistantMessage || !automationRequest) {
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

        const modelSelection = resolveAutomationComposerModelSelection(builderDraft);
        const { automation } = await createAutomationFromRequest({
          api,
          allProjects,
          defaultChatCwd,
          modelSelection,
          projectOptions,
          providers: serverProviders,
          request: {
            ...automationRequest,
            timezone: automationRequest.timezone || getDeviceTimeZone(),
          },
          selectedProjectId,
        });

        await disposeAutomationBuilderThread(api, builderThreadId);
        setRequestMessageId(null);
        toastManager.add({ type: "success", title: "Automation created" });
        await navigate({
          to: "/automations/$automationId",
          params: { automationId: automation.automationId },
        });
      } catch (error) {
        handledAssistantMessageIdRef.current = null;
        toastManager.add({
          type: "error",
          title: "Failed to create automation",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    })();
  }, [
    api,
    builderDraft,
    builderThread,
    builderThreadId,
    latestAssistantMessage,
    allProjects,
    defaultChatCwd,
    navigate,
    projectOptions,
    selectedProjectId,
    serverProviders,
  ]);

  const selectedProjectLabel =
    projectOptions.find((option) => option.id === selectedProjectId)?.label ?? null;

  return (
    <AutomationPageShell header={<AutomationListPageHeader />}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <div className="mx-auto w-full max-w-[44rem] px-4 sm:px-6">
            <div className="border-b border-border/70 pt-7 pb-2">
              <p className="text-sm text-foreground">Schedule tasks</p>
            </div>

            <AutomationListContent
              automations={automations}
              loading={loading}
              className=""
              layout="inset"
              onAutomationsChange={() => {
                void reloadAutomations();
              }}
              selectedAutomationId={null}
            />
          </div>
        </div>

        {builderThreadId && selectedProjectId ? (
          <div className="shrink-0 px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2">
            <ThreadComposerSurface
              className="[&_[data-testid=composer-editor]]:min-h-12"
              threadId={builderThreadId}
              seedPrompt={AUTOMATION_SKILL_PROMPT}
              onOptimisticUserMessage={setRequestMessageId}
              transformPromptForSend={(prompt) =>
                buildAutomationSkillDispatchPrompt({
                  rawPrompt: prompt,
                  defaultProjectName: selectedProjectLabel ?? "Chats",
                  deviceTimeZone: getDeviceTimeZone(),
                })
              }
            />
            <div className="mx-auto flex w-full max-w-[52rem] items-center px-2.5 pt-1 pb-3 sm:px-3">
              <AutomationProjectMenu
                projectOptions={projectOptions}
                selectedProjectId={selectedProjectId}
                selectedProjectName={selectedProjectLabel}
                onSelectProject={setSelectedProjectId}
              />
            </div>
          </div>
        ) : null}
      </div>
    </AutomationPageShell>
  );
}

function AutomationProjectMenu({
  projectOptions,
  selectedProjectId,
  selectedProjectName,
  onSelectProject,
}: {
  readonly projectOptions: ReadonlyArray<AutomationProjectOption>;
  readonly selectedProjectId: ProjectId | null;
  readonly selectedProjectName: string | null;
  readonly onSelectProject: (projectId: ProjectId) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-2 text-muted-foreground/60 hover:text-foreground/80"
          />
        }
      >
        <FolderIcon className="size-3" />
        <span className="max-w-[8rem] truncate text-xs">
          {selectedProjectName ?? "Select project"}
        </span>
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-64">
        {projectOptions.map((option) => (
          <MenuItem
            key={option.id}
            onClick={() => onSelectProject(option.id)}
            inset
            className="sm:text-sm"
          >
            {option.isChats ? (
              <MessageSquareIcon className="size-3 opacity-60" />
            ) : (
              <FolderIcon className="size-3 opacity-60" />
            )}
            {option.label}
            {option.id === selectedProjectId ? <CheckIcon className="ms-auto size-3" /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
