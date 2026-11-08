import { useEffect, useMemo } from "react";
import type { ComponentProps } from "react";
import { ChatBanner } from "../../common/ChatBanner";
import { useTextGenerationWarnings } from "../../../../stores/ui/textGenerationWarnings.store";
import { useThreadNoticeDismissal } from "../../../../stores/ui/threadNoticeDismissal.store";
import { MAX_NOTICE_DISMISSALS } from "../../../../stores/ui/noticeDismissal.retention";

/** Claim only a rendered warning, not every unseen failure activity received in the background. */
export function ThreadTextGenerationWarning({
  threadId,
  operation,
  ...props
}: Omit<ComponentProps<typeof ChatBanner>, "onDismiss"> & {
  threadId: string;
  operation: "title" | "summary";
}) {
  const key = JSON.stringify([threadId, operation]);
  const identity = useMemo(() => Symbol(key), [key]);
  const owner = useTextGenerationWarnings((state) => state.owners.get(key));
  const hasCapacity = useTextGenerationWarnings(
    (state) => state.owners.size < MAX_NOTICE_DISMISSALS,
  );
  const claim = useTextGenerationWarnings((state) => state.claim);
  const { dismissed, dismiss } = useThreadNoticeDismissal(threadId, `text-generation-${operation}`);
  const visible = !dismissed && (owner === identity || (owner === undefined && hasCapacity));
  useEffect(() => {
    if (visible) claim(key, identity);
  }, [visible, claim, key, identity]);
  return visible ? <ChatBanner {...props} onDismiss={dismiss} /> : null;
}
