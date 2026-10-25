import { useCallback, useEffect, useRef, useState } from "react";

import type { ServerListRemoteFoldersResult } from "@bigbud/contracts/server/server.remoteFolders";
import { readNativeApi } from "../../rpc/nativeApi";
import type { RequestRemoteProjectUnlock } from "./Sidebar.projects.logic";

export type RemoteFolderBrowserState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: ServerListRemoteFoldersResult }
  | { readonly status: "error"; readonly message: string; readonly path: string | undefined };

const UNAVAILABLE_MESSAGE =
  "This bigbud server can't browse remote folders. Type the path instead.";
const LOCKED_MESSAGE = "Unlock SSH access to browse folders.";

/**
 * Browses folders on the SSH target over plain SSH (works before the remote agent is installed).
 * Closes and forgets results whenever the connection target changes.
 */
export function useRemoteFolderBrowser({
  executionTargetId,
  requestUnlock,
}: {
  executionTargetId: string | null;
  requestUnlock: RequestRemoteProjectUnlock;
}) {
  const [state, setState] = useState<RemoteFolderBrowserState>({ status: "closed" });
  const [homePath, setHomePath] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    setState({ status: "closed" });
    setHomePath(null);
  }, [executionTargetId]);

  const load = useCallback(
    (path?: string) => {
      const requestId = ++requestIdRef.current;
      const listRemoteFolders = readNativeApi()?.server.listRemoteFolders;
      if (!executionTargetId) return;
      if (typeof listRemoteFolders !== "function") {
        setState({ status: "error", message: UNAVAILABLE_MESSAGE, path });
        return;
      }
      setState({ status: "loading" });
      listRemoteFolders({ executionTargetId, ...(path ? { path } : {}) }).then(
        (result) => {
          if (requestId !== requestIdRef.current) return;
          setHomePath(result.homePath);
          setState({ status: "ready", result });
        },
        (error: unknown) => {
          if (requestId !== requestIdRef.current) return;
          const message =
            error instanceof Error && error.message.trim()
              ? error.message
              : "Failed to list remote folders.";
          if (requestUnlock(message, () => load(path))) {
            setState({ status: "error", message: LOCKED_MESSAGE, path });
            return;
          }
          setState({
            status: "error",
            message: message.startsWith("Unknown request tag") ? UNAVAILABLE_MESSAGE : message,
            path,
          });
        },
      );
    },
    [executionTargetId, requestUnlock],
  );

  const close = useCallback(() => {
    requestIdRef.current += 1;
    setState({ status: "closed" });
  }, []);

  return { state, homePath, load, close };
}
