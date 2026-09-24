import { useCallback, useEffect, useRef, useState } from "react";
import { runRpc } from "../../rpc/client";
import type { SidebarActionId } from "./Sidebar.actions.logic";

export type PluginGitStatus = "checking" | "available" | "missing" | "unknown";

export function effectiveHiddenSidebarActions(
  hidden: readonly SidebarActionId[],
  gitStatus: PluginGitStatus,
): SidebarActionId[] {
  return gitStatus === "available" ? [...hidden] : [...new Set([...hidden, "plugins" as const])];
}

export async function requestShowPlugins(input: {
  check: () => Promise<PluginGitStatus>;
  show: () => void;
  onMissing: () => void;
  onUnknown: () => void;
}): Promise<void> {
  const status = await input.check();
  if (status === "available") input.show();
  else if (status === "missing") input.onMissing();
  else input.onUnknown();
}

export function usePluginGitAvailability() {
  const [status, setStatus] = useState<PluginGitStatus>("checking");
  const requestId = useRef(0);
  const check = useCallback(async (): Promise<PluginGitStatus> => {
    const currentRequest = ++requestId.current;
    let result: PluginGitStatus;
    try {
      result = await runRpc((client) => client("plugins.gitAvailability", undefined));
    } catch {
      result = "unknown";
    }
    if (requestId.current === currentRequest) setStatus(result);
    return result;
  }, []);

  useEffect(() => {
    const currentRequestId = requestId;
    void check();
    return () => {
      currentRequestId.current++;
    };
  }, [check]);

  return { status, check };
}
