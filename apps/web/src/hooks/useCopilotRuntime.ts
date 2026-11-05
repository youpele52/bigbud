import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CopilotRuntimeInput,
  CopilotRuntimeState,
} from "@bigbud/contracts/server/copilotRuntime";
import { ensureNativeApi } from "../rpc/nativeApi";

export const copilotRuntimeQueryKey = ["server", "copilot-runtime"] as const;
const pendingDismissalKey = ["server", "copilot-runtime", "pending-dismissal"] as const;
export const copilotJobBusy = (phase: string | undefined) =>
  phase !== undefined && ["downloading", "verifying", "installing"].includes(phase);
export const COPILOT_SETUP_EVENT = "bigbud:copilot-setup";
export function requestCopilotSetup() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COPILOT_SETUP_EVENT));
}

/** All settings/progress/prompt consumers share status; polling never creates a download job. */
export function useCopilotRuntime() {
  const client = useQueryClient();
  const pendingDismissal = useQuery({
    queryKey: pendingDismissalKey,
    queryFn: () => false,
    initialData: false,
    enabled: false,
    gcTime: Infinity,
  });
  const query = useQuery({
    queryKey: copilotRuntimeQueryKey,
    queryFn: async () => ensureNativeApi().server.copilotRuntime?.({ action: "status" }) ?? null,
    refetchInterval: (query) => (copilotJobBusy(query.state.data?.job?.phase) ? 500 : 15_000),
    staleTime: 2_000,
  });
  const act = useCallback(
    async (input: CopilotRuntimeInput) => {
      const state = await ensureNativeApi().server.copilotRuntime?.(input);
      if (!state) throw new Error("Copilot runtime management is unavailable on this server.");
      client.setQueryData(copilotRuntimeQueryKey, state);
      if (state.error) throw new Error(state.error);
      return state;
    },
    [client],
  );
  const dismiss = useCallback(async () => {
    client.setQueryData(pendingDismissalKey, true);
    client.setQueryData<CopilotRuntimeState | null>(copilotRuntimeQueryKey, (previous) =>
      previous ? { ...previous, onboarding: false } : previous,
    );
    const state = await act({ action: "acknowledge" });
    client.setQueryData(pendingDismissalKey, false);
    return state;
  }, [act, client]);
  return { ...query, act, dismiss, pendingDismissal: pendingDismissal.data };
}
