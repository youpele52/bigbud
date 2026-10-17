import type { NativeApi, ThreadId } from "@bigbud/contracts";
import type { TerminalWslDistributions } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readNativeApi } from "../../rpc/nativeApi";
import { useThreadById, useProjectById } from "../../stores/main";
import { useComposerDraftStore } from "../../stores/composer";
import { useTerminalStateStore } from "../../stores/terminal";
import { readTerminalLaunch, subscribeTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { resolveTerminalExecutionTargetId } from "./useThreadTerminalDrawer";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { TerminalSquare } from "lucide-react";

const pending = new WeakMap<NativeApi, Promise<TerminalWslDistributions>>();
function discover(api: NativeApi): Promise<TerminalWslDistributions> {
  const previous = pending.get(api);
  if (previous) return previous;
  if (!api.terminal.wslDistributions)
    return Promise.resolve({ supported: false, distributions: [] });
  const request = api.terminal.wslDistributions();
  pending.set(api, request);
  void request
    .finally(() => {
      if (pending.get(api) === request) pending.delete(api);
    })
    .catch(() => undefined);
  return request;
}

/** Both terminal surfaces share a per-chat preference for new manual sessions only. */
export function TerminalTargetPicker({
  threadId,
  terminalId,
  compact = false,
}: {
  threadId: ThreadId;
  terminalId: string;
  compact?: boolean;
}) {
  const thread = useThreadById(threadId);
  const draft = useComposerDraftStore((state) => state.draftThreadsByThreadId[threadId]);
  const project = useProjectById(thread?.projectId ?? draft?.projectId);
  const workspaceTarget = resolveTerminalExecutionTargetId({ serverThread: thread, project });
  const localWorkspace = (workspaceTarget ?? "local") === "local";
  const distribution = useTerminalStateStore(
    (state) => state.terminalWslDistributionByThreadId[threadId],
  );
  const setDistribution = useTerminalStateStore((state) => state.setTerminalWslDistribution);
  const launch = useSyncExternalStore(
    subscribeTerminalLaunch,
    () => readTerminalLaunch(threadId, terminalId),
    () => undefined,
  );
  const [listing, setListing] = useState<TerminalWslDistributions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const api = readNativeApi();
    if (!localWorkspace || !api) return;
    const current = ++generation.current;
    setLoading(true);
    void discover(api)
      .then(
        (value) => {
          if (generation.current !== current) return;
          setListing(value);
          setError(null);
        },
        (cause: unknown) => {
          if (generation.current !== current) return;
          setError(
            cause instanceof Error ? cause.message : "WSL discovery failed. Retry the target menu.",
          );
        },
      )
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
  }, [localWorkspace]);
  useEffect(() => {
    refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  if (!localWorkspace || (!error && !listing?.supported)) return null;
  const identity = launch?.wslIdentity;
  const actual = identity
    ? `${identity.distribution} · ${identity.username} (uid ${identity.uid})`
    : launch
      ? (launch.executionTargetId ?? "local")
      : "Not started";
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) refresh();
      }}
    >
      <MenuTrigger
        className="max-w-40 truncate px-2 text-sm text-muted-foreground hover:text-foreground"
        aria-label="New terminal target"
      >
        {compact ? (
          <TerminalSquare className="size-3 shrink-0" />
        ) : (
          <>New: {distribution ?? "Chat workspace"}</>
        )}
      </MenuTrigger>
      <MenuPopup align="end" className="max-w-80">
        <p
          aria-label="Selected new terminal target"
          className="px-2 py-1 text-xs text-muted-foreground"
        >
          New: {distribution ?? "Chat workspace"}
        </p>
        <p className="px-2 py-1 text-xs text-muted-foreground" aria-label="Active terminal target">
          Active: {actual}
        </p>
        <MenuItem className="text-sm" onClick={() => setDistribution(threadId, null)}>
          Chat workspace
        </MenuItem>
        {listing?.distributions.map((name) => (
          <MenuItem key={name} className="text-sm" onClick={() => setDistribution(threadId, name)}>
            WSL: {name}
          </MenuItem>
        ))}
        {distribution && !listing?.distributions.includes(distribution) && (
          <p className="px-2 py-1 text-xs text-amber-600">
            Selected distro is unavailable. Choose another target; it will not be replaced
            automatically.
          </p>
        )}
        {loading && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Refreshing distributions…</p>
        )}
        {error && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
        <p className="px-2 py-1 text-xs text-muted-foreground">
          New manual terminals only. WSL uses its default Linux user and may start a stopped distro.
          Scripts stay in the chat workspace. WSL file links and drops are unavailable.
        </p>
      </MenuPopup>
    </Menu>
  );
}
