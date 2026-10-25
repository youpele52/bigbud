import { useEffect, useState } from "react";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ensureNativeApi } from "~/rpc/nativeApi";

/** This read-only projection never refreshes native setup or enrolls a chat. */
export function useOpencodeV2RetainedHistory(
  threadId: ThreadId | undefined,
  directory: string | undefined,
  settingsRevision: string,
) {
  const [state, setState] = useState<{
    threadId: ThreadId;
    directory: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    let current = true;
    setState(null);
    if (!threadId || !directory) return;
    void ensureNativeApi()
      .server.getOpencodeV2ThreadToolsSetup({ threadId, directory, refresh: false })
      .then((result) => {
        if (current && result.status === "incompatible-history")
          setState({ threadId, directory, message: result.message });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [threadId, directory, settingsRevision]);
  return state && state.threadId === threadId && state.directory === directory
    ? state.message
    : null;
}
