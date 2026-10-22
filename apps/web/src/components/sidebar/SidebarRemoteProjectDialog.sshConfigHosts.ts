import { useCallback, useEffect, useRef, useState } from "react";

import type { ServerListSshConfigHostsResult } from "@bigbud/contracts/server/server.sshConfig";
import { readNativeApi } from "../../rpc/nativeApi";

export type SshConfigHostsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: ServerListSshConfigHostsResult }
  | { readonly status: "error"; readonly message: string };

const UNAVAILABLE_MESSAGE =
  "This bigbud server can't list SSH config hosts. Enter the host manually.";

/** Reads SSH config hosts from the backend while `enabled`; stale responses are dropped. */
export function useSshConfigHosts(enabled: boolean): SshConfigHostsState & {
  readonly refresh: () => void;
} {
  const [state, setState] = useState<SshConfigHostsState>({ status: "idle" });
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const listSshConfigHosts = readNativeApi()?.server.listSshConfigHosts;
    if (typeof listSshConfigHosts !== "function") {
      setState({ status: "error", message: UNAVAILABLE_MESSAGE });
      return;
    }
    setState({ status: "loading" });
    listSshConfigHosts({}).then(
      (result) => {
        if (requestId === requestIdRef.current) setState({ status: "ready", result });
      },
      (error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        const message =
          error instanceof Error && error.message.startsWith("Unknown request tag")
            ? UNAVAILABLE_MESSAGE
            : error instanceof Error && error.message.trim()
              ? error.message
              : "Failed to read SSH config.";
        setState({ status: "error", message });
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current += 1;
      setState({ status: "idle" });
      return;
    }
    load();
  }, [enabled, load]);

  return { ...state, refresh: load };
}
