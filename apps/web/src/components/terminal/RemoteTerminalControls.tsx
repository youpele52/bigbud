import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type {
  TerminalRemoteInventory,
  TerminalRemoteSession,
} from "@bigbud/contracts/workspace/terminal.remote.ts";
import { Unplug } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readNativeApi } from "../../rpc/nativeApi";
import { useThreadById, useProjectById } from "../../stores/main";
import { useComposerDraftStore } from "../../stores/composer";
import { useTerminalStateStore } from "../../stores/terminal";
import {
  readTerminalLaunch,
  recordTerminalLaunch,
  subscribeTerminalLaunch,
} from "../../lib/terminalLaunchBinding";
import { resolveTerminalExecutionTargetId } from "./useThreadTerminalDrawer";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { BigbudLoader } from "../layout/BigbudLoader";
import { withTerminalLifecycleDeadline } from "./terminalLifecycle.operations";

export function RemoteTerminalControls(props: { threadId: ThreadId; terminalId: string }) {
  const thread = useThreadById(props.threadId);
  const draft = useComposerDraftStore((state) => state.draftThreadsByThreadId[props.threadId]);
  const project = useProjectById(thread?.projectId ?? draft?.projectId);
  const launch = useSyncExternalStore(
    subscribeTerminalLaunch,
    () => readTerminalLaunch(props.threadId, props.terminalId),
    () => undefined,
  );
  const target =
    launch?.executionTargetId ??
    resolveTerminalExecutionTargetId({ serverThread: thread, project });
  if (!target?.startsWith("ssh:") || target.includes("transport=direct-ssh")) return null;
  return (
    <RemoteTerminalMenu
      key={JSON.stringify([props.threadId, props.terminalId, target])}
      {...props}
      target={target}
    />
  );
}

function RemoteTerminalMenu({
  threadId,
  terminalId,
  target,
}: {
  threadId: ThreadId;
  terminalId: string;
  target: string;
}) {
  const [page, setPage] = useState<TerminalRemoteInventory>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  const request = useRef(0);
  const actionPending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const requestCounter = request;
    return () => {
      mounted.current = false;
      requestCounter.current++;
    };
  }, []);
  const launch = useSyncExternalStore(
    subscribeTerminalLaunch,
    () => readTerminalLaunch(threadId, terminalId),
    () => undefined,
  );
  const refresh = async (after = "") => {
    if (actionPending.current) return;
    const api = readNativeApi();
    const current = ++request.current;
    setBusy(true);
    setError(undefined);
    try {
      if (!api?.terminal.remoteInventory)
        throw new Error("This backend does not support terminal discovery.");
      const result = await withTerminalLifecycleDeadline(
        api.terminal.remoteInventory({ executionTargetId: target, after }),
      );
      if (mounted.current && current === request.current) setPage(result);
    } catch (cause) {
      if (mounted.current && current === request.current)
        setError(cause instanceof Error ? cause.message : "Terminal inventory is unavailable.");
    } finally {
      if (mounted.current && current === request.current) setBusy(false);
    }
  };
  const removePane = (id: string) => {
    const store = useTerminalStateStore.getState();
    store.closeTerminal(threadId, id);
    store.closePanelTerminal(threadId, id);
  };
  const perform = async (action: "attach" | "stop" | "detach", row?: TerminalRemoteSession) => {
    if (busy || actionPending.current) return;
    actionPending.current = true;
    request.current++;
    const selectedId = row?.terminalId ?? terminalId;
    const expectedView = readTerminalLaunch(threadId, selectedId)?.runtimeGeneration;
    const viewIsCurrent = () =>
      mounted.current &&
      readTerminalLaunch(threadId, selectedId)?.runtimeGeneration === expectedView;
    const api = readNativeApi();
    setBusy(true);
    setError(undefined);
    try {
      if (!api) throw new Error("Backend connection is unavailable.");
      if (action === "detach") {
        if (!api.terminal.remoteDetach || !launch?.runtimeGeneration)
          throw new Error("Reconnect this terminal before detaching it.");
        await withTerminalLifecycleDeadline(
          api.terminal.remoteDetach({
            threadId,
            terminalId,
            expectedGeneration: launch.runtimeGeneration,
          }),
        );
        if (!viewIsCurrent()) return;
        removePane(terminalId);
        setOpen(false);
      } else {
        const cwd = row?.cwd ?? (row?.terminalId === terminalId ? launch?.cwd : undefined);
        if (!row || !cwd)
          throw new Error(
            "Reopen this terminal from its original workspace to recover its saved directory.",
          );
        const input = {
          threadId,
          terminalId: row.terminalId,
          executionTargetId: target,
          resourceId: row.resourceId,
          cwd,
        };
        if (action === "stop") {
          if (!api.terminal.remoteStop)
            throw new Error("This backend does not support confirmed Stop.");
          await withTerminalLifecycleDeadline(api.terminal.remoteStop(input));
          if (!viewIsCurrent()) return;
          removePane(row.terminalId);
        } else {
          if (!api.terminal.remoteAttach)
            throw new Error("This backend does not support attach-only recovery.");
          const snapshot = await withTerminalLifecycleDeadline(api.terminal.remoteAttach(input));
          if (!viewIsCurrent()) return;
          recordTerminalLaunch(snapshot);
          const store = useTerminalStateStore.getState();
          store.hydrateTerminalAgentFromSnapshot(snapshot);
          store.ensureTerminal(threadId, row.terminalId, { open: true, active: true });
          setOpen(false);
        }
      }
      actionPending.current = false;
      if (mounted.current) await refresh();
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Terminal action is unconfirmed. Reconnect to inspect it.",
        );
    } finally {
      actionPending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const sessions = page?.sessions.filter((row) => row.threadId === threadId) ?? [];
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void refresh();
      }}
    >
      <PopoverTrigger
        className="px-1 text-sm text-muted-foreground hover:text-foreground"
        aria-label="Persistent remote terminals"
      >
        <Unplug className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-96 max-w-[90vw] p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-sm font-medium">Remote terminals</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !launch?.runtimeGeneration}
            onClick={() => void perform("detach")}
          >
            Detach current
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Detach keeps your process running. Stop ends it.
        </p>
        {busy && !page ? (
          <div className="h-40">
            <BigbudLoader label="Discovering remote terminals" />
          </div>
        ) : (
          <>
            {error && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                {error}
              </p>
            )}
            {!error && page && sessions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No terminals for this chat on this page.
              </p>
            )}
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {sessions.map((row) => (
                <div key={row.resourceId} className="rounded-md border p-2">
                  <p className="truncate text-sm">
                    {row.terminalId} · {row.status}
                  </p>
                  {row.status === "unknown" && (
                    <p className="text-xs text-muted-foreground">
                      The process may still be running. Reconnect to inspect it.
                    </p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || row.status === "stopped"}
                      onClick={() => void perform("attach", row)}
                    >
                      Attach
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || row.status === "stopped"}
                      onClick={() => void perform("stop", row)}
                    >
                      Stop
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                Refresh
              </Button>
              {page?.nextCursor && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void refresh(page.nextCursor)}
                >
                  Next page
                </Button>
              )}
            </div>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}
