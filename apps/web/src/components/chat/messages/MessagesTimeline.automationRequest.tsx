import {
  CheckCircle2Icon,
  ChevronDownIcon,
  Clock3Icon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUILT_IN_CHATS_PROJECT_ID,
  isBuiltInChatsProject,
  type MessageId,
} from "@bigbud/contracts";

import { createAutomationFromRequest } from "~/components/automation/automationCreate";
import type { AutomationProjectOption } from "~/components/automation/automationDirectory";
import {
  type AutomationSkillRequest,
  formatAutomationDateTime,
  getDeviceTimeZone,
  validateAutomationSkillRequest,
} from "~/lib/automation";
import { readNativeApi } from "~/rpc/nativeApi";
import { useDefaultChatCwd, useServerProviders } from "~/rpc/serverState";
import { useStore } from "~/stores/main";
import { Button } from "../../ui/button";

const AUTOMATION_REQUEST_AUTO_CREATE_LOADED_AT_MS = Date.now();
const autoCreateAttemptedMessageIds = new Set<string>();

function isAutomationRoute() {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/automations");
}

export function MessagesTimelineAutomationRequest(props: {
  readonly messageCreatedAt: string;
  readonly messageId: MessageId;
  readonly request: AutomationSkillRequest;
  readonly requestPayload: string | null;
  readonly streaming: boolean;
}) {
  const { messageCreatedAt, messageId, request, requestPayload, streaming } = props;
  const allProjects = useStore((store) => store.projects);
  const sourceThread = useStore(
    (store) =>
      store.threads.find((thread) => thread.messages.some((message) => message.id === messageId)) ??
      null,
  );
  const defaultChatCwd = useDefaultChatCwd();
  const serverProviders = useServerProviders();
  const [state, setState] = useState<
    | { readonly status: "idle" }
    | { readonly status: "creating" }
    | { readonly status: "created"; readonly created: boolean }
    | { readonly status: "error"; readonly message: string }
  >({ status: "idle" });
  const autoCreateStartedRef = useRef(false);
  const projectOptions = useMemo<ReadonlyArray<AutomationProjectOption>>(
    () => [
      { id: BUILT_IN_CHATS_PROJECT_ID, label: "Chats", isChats: true },
      ...allProjects
        .filter((project) => !isBuiltInChatsProject(project.id))
        .map((project) => ({
          id: project.id,
          label: project.name,
          isChats: false,
        })),
    ],
    [allProjects],
  );

  const createAutomation = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !sourceThread) {
      setState({ status: "error", message: "Automation setup is not ready yet." });
      return;
    }

    const normalizedRequest = {
      ...request,
      timezone: request.timezone || getDeviceTimeZone(),
    };
    const validationError = validateAutomationSkillRequest(normalizedRequest);
    if (validationError) {
      setState({ status: "error", message: validationError });
      return;
    }

    setState({ status: "creating" });
    try {
      const result = await createAutomationFromRequest({
        api,
        allProjects,
        defaultChatCwd,
        modelSelection: sourceThread.modelSelection,
        projectOptions,
        providers: serverProviders,
        request: normalizedRequest,
        selectedProjectId: sourceThread.projectId,
      });
      setState({ status: "created", created: result.created });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to create automation.",
      });
    }
  }, [allProjects, defaultChatCwd, projectOptions, request, serverProviders, sourceThread]);

  useEffect(() => {
    if (
      streaming ||
      isAutomationRoute() ||
      autoCreateStartedRef.current ||
      autoCreateAttemptedMessageIds.has(messageId)
    ) {
      return;
    }
    const createdAtMs = Date.parse(messageCreatedAt);
    if (
      Number.isNaN(createdAtMs) ||
      createdAtMs < AUTOMATION_REQUEST_AUTO_CREATE_LOADED_AT_MS - 1_000
    ) {
      return;
    }

    autoCreateStartedRef.current = true;
    autoCreateAttemptedMessageIds.add(messageId);
    void createAutomation();
  }, [createAutomation, messageCreatedAt, messageId, streaming]);

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-background/35 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock3Icon className="size-3.5 shrink-0 text-info" />
          <span className="text-xs font-medium text-foreground">Automation request</span>
        </div>
        <AutomationRequestStatus state={state} onCreate={() => void createAutomation()} />
      </div>

      <table className="w-full text-left text-xs">
        <tbody className="[&_tr:last-child_td]:border-b-0">
          <AutomationRow label="Title" value={request.title} />
          <AutomationRow label="Project" value={request.projectTitle ?? "Chats"} />
          <AutomationRow label="Schedule" value={request.scheduleLabel} />
          <AutomationRow label="Timezone" value={request.timezone} />
          {request.runAt ? (
            <AutomationRow label="Run at" value={formatAutomationDateTime(request.runAt)} />
          ) : null}
        </tbody>
      </table>

      {requestPayload ? (
        <details className="mt-3 group/automation-request">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground/80">
            <ChevronDownIcon className="size-3 shrink-0 -rotate-90 transition-transform duration-150 group-open/automation-request:rotate-0" />
            Automation request data
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-background/45 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/80">
            {requestPayload}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function AutomationRequestStatus(props: {
  readonly state:
    | { readonly status: "idle" }
    | { readonly status: "creating" }
    | { readonly status: "created"; readonly created: boolean }
    | { readonly status: "error"; readonly message: string };
  readonly onCreate: () => void;
}) {
  if (props.state.status === "creating") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        Creating...
      </span>
    );
  }

  if (props.state.status === "created") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-success">
        <CheckCircle2Icon className="size-3" />
        {props.state.created ? "Created" : "Already created"}
      </span>
    );
  }

  if (props.state.status === "error") {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex max-w-72 items-center gap-1.5 truncate text-xs text-destructive">
          <XCircleIcon className="size-3 shrink-0" />
          <span className="truncate">{props.state.message}</span>
        </span>
        <Button type="button" size="xs" variant="outline" onClick={props.onCreate}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Button type="button" size="xs" variant="outline" onClick={props.onCreate}>
      Create automation
    </Button>
  );
}

function AutomationRow(props: { readonly label: string; readonly value: string }) {
  return (
    <tr className="border-b border-border/50 align-top">
      <td className="w-24 py-1.5 pr-3 text-muted-foreground">{props.label}</td>
      <td className="py-1.5 text-foreground">{props.value}</td>
    </tr>
  );
}
