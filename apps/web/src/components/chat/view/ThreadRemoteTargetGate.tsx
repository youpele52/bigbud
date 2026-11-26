import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, CloudOff, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { reconnectRemoteThreadTerminalsInBackground } from "../../../hooks/remoteThreadTerminals";
import { useThreadRemoteTarget } from "../../../hooks/useThreadRemoteTarget";
import { startRemoteExecutionCheck } from "../../../hooks/useRemoteExecutionAccessGate.checks";
import { verifyRemoteExecutionTarget } from "../../../hooks/useRemoteExecutionAccessGate.verification";
import { useStore } from "../../../stores/main";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import {
  promptRemoteTargetAuth,
  reconnectRemoteTargetAccess,
} from "../../../stores/remoteAccess/remoteTargetAccess";
import { useRemoteTargetFailureInvalidation } from "../../../stores/remoteAccess/remoteTargetInvalidation";
import {
  clearRestoredThreadRoute,
  peekThreadNavigationIntent,
  type ThreadNavigationIntent,
} from "../../../stores/remoteAccess/threadNavigationIntent";
import { Button } from "../../ui/button";
import { deriveServerTurnFailure } from "./ThreadRecoveryNotice.failure";
import {
  deriveRemoteThreadGateState,
  describeRemoteThreadGate,
  type RemoteThreadGateTone,
} from "./ThreadRemoteTargetGate.logic";

interface GateVisit {
  readonly threadId: ThreadId;
  readonly intent: ThreadNavigationIntent;
  readonly autoAttempted: boolean;
  readonly latchedOpen: boolean;
  readonly wasGated: boolean;
}

const newVisit = (threadId: ThreadId): GateVisit => ({
  threadId,
  intent: peekThreadNavigationIntent(threadId),
  autoAttempted: false,
  latchedOpen: false,
  wasGated: false,
});

/** TanStack history stores the entry index in `history.state`; 0 is the app's first entry. */
function canGoBackInApp(): boolean {
  const index = (window.history.state as { __TSR_index?: unknown } | null)?.__TSR_index;
  return typeof index === "number" && index > 0;
}

const TONE_CLASS: Record<RemoteThreadGateTone, string> = {
  info: "text-info-foreground",
  warning: "text-warning",
  error: "text-destructive",
};

function GateIcon({ tone }: { readonly tone: RemoteThreadGateTone }) {
  const className = `size-6 ${TONE_CLASS[tone]}`;
  if (tone === "info") return <LoaderCircle className={`${className} animate-spin`} aria-hidden />;
  return tone === "warning" ? (
    <AlertTriangle className={className} aria-hidden />
  ) : (
    <CloudOff className={className} aria-hidden />
  );
}

/**
 * Route-level gate for threads of an SSH workspace whose connection is known dead: reconnects
 * before the thread opens (silently when no input is needed, otherwise through the global auth
 * dialog). Covers every navigation path because it wraps the thread route, not a click handler.
 */
export function ThreadRemoteTargetGate({
  threadId,
  projectId,
  children,
}: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly children: ReactNode;
}) {
  const target = useThreadRemoteTarget(threadId, projectId);
  const executionTargetId = target?.executionTargetId;
  const targetCwd = target?.cwd;
  const check = useRemoteAccessStore((state) =>
    executionTargetId ? state.executionTargetChecks[executionTargetId] : undefined,
  );
  const disconnectedTargetsLoaded = useRemoteAccessStore(
    (state) => state.disconnectedTargetsLoaded,
  );
  const userDisconnected = useRemoteAccessStore((state) =>
    executionTargetId ? state.disconnectedExecutionTargetIds[executionTargetId] === true : false,
  );
  const pendingAuthMode = useRemoteAccessStore((state) =>
    executionTargetId && state.pendingAction?.executionTargetId === executionTargetId
      ? (state.authMode ?? "password")
      : null,
  );
  const messages = useStore((state) => state.threads.find((t) => t.id === threadId)?.messages);
  const activities = useStore((state) => state.threads.find((t) => t.id === threadId)?.activities);
  const failure = useMemo(() => {
    const derived =
      messages && activities ? deriveServerTurnFailure({ messages, activities }) : null;
    return derived?.remoteTarget && derived.createdAt
      ? { remoteTarget: derived.remoteTarget, createdAt: derived.createdAt, detail: derived.detail }
      : null;
  }, [messages, activities]);
  useRemoteTargetFailureInvalidation(executionTargetId, failure);

  const [visit, setVisit] = useState(() => newVisit(threadId));
  const current = visit.threadId === threadId ? visit : newVisit(threadId);
  if (current !== visit) setVisit(current);
  useEffect(() => () => clearRestoredThreadRoute(threadId), [threadId]);

  const { state, autoCheck, backgroundCheck } = deriveRemoteThreadGateState({
    isRemote: target !== null,
    disconnectedTargetsLoaded,
    userDisconnected,
    check,
    failure,
    intent: current.intent,
    autoAttempted: current.autoAttempted,
    authPending: pendingAuthMode !== null,
    latchedOpen: current.latchedOpen,
  });
  const open = state.kind === "open";

  useEffect(() => {
    if (!executionTargetId || !autoCheck) return;
    setVisit((previous) =>
      previous.threadId === threadId ? { ...previous, autoAttempted: true } : previous,
    );
    void reconnectRemoteTargetAccess({
      executionTargetId,
      ...(targetCwd ? { cwd: targetCwd } : {}),
      prompt: true,
    });
  }, [autoCheck, executionTargetId, targetCwd, threadId]);

  useEffect(() => {
    if (!executionTargetId || !backgroundCheck || current.latchedOpen) return;
    startRemoteExecutionCheck({
      executionTargetId,
      ...(targetCwd ? { cwd: targetCwd } : {}),
      verify: verifyRemoteExecutionTarget,
    });
  }, [backgroundCheck, current.latchedOpen, executionTargetId, targetCwd]);

  useEffect(() => {
    if (open && current.latchedOpen) return;
    setVisit((previous) =>
      previous.threadId !== threadId
        ? previous
        : open
          ? { ...previous, latchedOpen: true }
          : previous.wasGated
            ? previous
            : { ...previous, wasGated: true },
    );
    // Access came back after the gate showed: re-attach the thread's open terminals.
    if (open && current.wasGated && target) reconnectRemoteThreadTerminalsInBackground(target);
  }, [open, current.latchedOpen, current.wasGated, target, threadId]);

  const navigate = useNavigate();

  if (open || !target) return <>{children}</>;

  const copy = describeRemoteThreadGate(state, target.hostLabel, pendingAuthMode);
  const accessInput = {
    executionTargetId: target.executionTargetId,
    ...(target.cwd ? { cwd: target.cwd } : {}),
  };
  const onPrimary = () => {
    if (state.kind === "auth" && promptRemoteTargetAuth(accessInput)) return;
    void reconnectRemoteTargetAccess({ ...accessInput, prompt: true });
  };
  const goBack = () => {
    if (canGoBackInApp()) window.history.back();
    else void navigate({ to: "/" });
  };

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      role={copy.tone === "error" ? "alert" : "status"}
      aria-live="polite"
      data-remote-target-gate={state.kind}
    >
      <GateIcon tone={copy.tone} />
      <p className={`max-w-sm text-sm font-medium ${TONE_CLASS[copy.tone]}`}>{copy.title}</p>
      {copy.description ? (
        <p className="max-w-sm text-xs text-muted-foreground">{copy.description}</p>
      ) : null}
      <p className="max-w-sm text-xs text-muted-foreground">
        Your thread history is safe. It opens when the connection is back.
      </p>
      <div className="flex items-center gap-2">
        {copy.primaryLabel ? (
          <Button size="sm" onClick={onPrimary}>
            {copy.primaryLabel}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={goBack}>
          Go back
        </Button>
      </div>
    </div>
  );
}
