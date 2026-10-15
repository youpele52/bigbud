import { useMemo } from "react";

import { useContinueInNewThread } from "../../../hooks/useContinueInNewThread";
import type { Thread } from "../../../models/types/app.types";
import { ThreadForkNotice } from "./ThreadForkNotice";
import { deriveSourceForkNotice } from "./ThreadForkNotice.logic";
import { ThreadRecoveryNotice } from "./ThreadRecoveryNotice";

/** Recovery status plus fork lineage for a server thread (plan D15-D17). */
export function ThreadRecoveryNotices({ thread }: { readonly thread: Thread }) {
  const { continueInNewThread, pending } = useContinueInNewThread(thread);
  const { messages, activities } = thread;
  // Once the pending request continued in a fork, the fork notice links it instead.
  const alreadyForked = useMemo(
    () => deriveSourceForkNotice({ messages, activities }) !== null,
    [messages, activities],
  );
  return (
    <>
      <ThreadForkNotice thread={thread} />
      <ThreadRecoveryNotice
        thread={thread}
        onContinueInNewThread={alreadyForked ? undefined : () => void continueInNewThread()}
        continuePending={pending}
      />
    </>
  );
}
