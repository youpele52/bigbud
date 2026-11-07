import { useContext, useState } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { useStore } from "~/stores/main/main.store";
import { hasTurnWorkActivities } from "~/stores/main/helpers.turnActivities.store";
import type { ChatMessage } from "../../../models/types";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { isKnownEmptyTurn, loadTurnActivities } from "./MessagesTimeline.turnActivities";
import { TimelineThreadIdContext } from "./MessagesTimeline.truncatedMessage";

/**
 * Older turns arrive without their work log (only the latest turn's activities load with the
 * thread). Expanding one loads that turn's bounded activities on demand.
 */
export function OlderTurnWorkLogButton(props: { readonly message: ChatMessage }) {
  const { message } = props;
  const threadId = useContext(TimelineThreadIdContext);
  const turnId = message.turnId ?? null;
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "empty">("idle");
  const missing = useStore((state) => {
    if (!threadId || turnId === null || message.streaming) return false;
    const thread = state.threads.find((entry) => entry.id === threadId);
    return thread !== undefined && !hasTurnWorkActivities(thread, turnId);
  });
  if (!missing || !threadId || turnId === null || status === "empty") return null;
  if (isKnownEmptyTurn(threadId, turnId)) return null;

  const load = () => {
    const api = readNativeApi();
    if (!api) return;
    setStatus("loading");
    loadTurnActivities({
      api: api.orchestration,
      threadId,
      turnId,
      merge: useStore.getState().mergeTurnActivities,
    }).then(
      () => setStatus(isKnownEmptyTurn(threadId, turnId) ? "empty" : "idle"),
      () => setStatus("error"),
    );
  };

  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="text-xs text-muted-foreground"
      disabled={status === "loading"}
      onClick={load}
    >
      {status === "loading" ? <Spinner className="size-3" /> : null}
      {status === "error" ? "Couldn't load the work log. Retry" : "Show work log"}
    </Button>
  );
}
