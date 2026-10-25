import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { firstProviderTurnFailure } from "@bigbud/shared/providerTurnFailure";

import { welcomeAtom } from "../../../rpc/serverState";
import { useStore } from "../../../stores/main/main.store";
import { useProviderFailureNoticeStore } from "../../../stores/ui/providerFailureNotice.store";

/** Failure presentation is independent of native runtime readiness and provider-session identity. */
export function useProviderFailureNotice(threadId: string) {
  const serverRunId = useAtomValue(welcomeAtom)?.serverRunId;
  const candidate = useStore((state) => {
    if (!serverRunId) return null;
    const thread = state.threads.find((entry) => entry.id === threadId);
    return thread ? firstProviderTurnFailure(thread.activities, serverRunId) : null;
  });
  const notice = useProviderFailureNoticeStore((state) =>
    state.serverRunId === serverRunId ? state.notices[threadId] : undefined,
  );
  const observe = useProviderFailureNoticeStore((state) => state.observe);
  const dismiss = useProviderFailureNoticeStore((state) => state.dismiss);
  useEffect(() => {
    if (serverRunId) observe(serverRunId, threadId, candidate);
  }, [serverRunId, threadId, candidate, observe]);
  return {
    message: notice && !notice.dismissed ? notice.message : null,
    originalMessage: notice?.message ?? candidate,
    dismiss: () => {
      if (serverRunId) dismiss(serverRunId, threadId);
    },
  };
}
