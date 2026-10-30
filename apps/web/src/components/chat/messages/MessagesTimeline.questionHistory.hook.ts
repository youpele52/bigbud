import { useEffect, useRef } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { loadOlderThreadMessages } from "~/routes/-__root.bounded-bootstrap";
import { useStore } from "~/stores/main/main.store";
import { toastManager } from "~/components/ui/toast";
import { useChatCitationActions } from "../common/ChatCitation.context";

const MAX_HISTORY_PAGES = 20;

/** Walk bounded message pages: request IDs are not valid message anchors. */
export function useQuestionCitationHistory(hasQuestionRow: boolean) {
  const focus = useChatCitationActions()?.questionFocus;
  const hydration = useStore((state) =>
    focus ? state.threadHydrationById[focus.threadId] : undefined,
  );
  const attempt = useRef({ focus, pages: 0, finished: false });
  useEffect(() => {
    if (attempt.current.focus !== focus) {
      attempt.current = { focus, pages: 0, finished: false };
    }
    if (!focus || hasQuestionRow || attempt.current.finished) return;
    if (hydration?.status === "loading" || hydration?.status === "loadingOlder") return;
    const api = readNativeApi();
    const canLoad = hydration?.status === "loaded" && hydration.nextCursor !== null;
    if (!api || !canLoad || attempt.current.pages >= MAX_HISTORY_PAGES) {
      attempt.current.finished = true;
      toastManager.add({
        type: "warning",
        title: "Could not open saved question",
        description:
          hydration?.status === "failed"
            ? hydration.error
            : "The question was not found in the available history. Load more history and try again.",
      });
      return;
    }
    attempt.current.pages += 1;
    void loadOlderThreadMessages({ api, threadId: focus.threadId });
  }, [focus, hasQuestionRow, hydration]);
}
