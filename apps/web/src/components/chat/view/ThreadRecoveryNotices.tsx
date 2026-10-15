import { useMemo } from "react";

import { useContinueInNewThread } from "../../../hooks/useContinueInNewThread";
import type { Thread } from "../../../models/types/app.types";
import { ThreadForkNotice } from "./ThreadForkNotice";
import { deriveSourceForkNotice } from "./ThreadForkNotice.logic";
import { useForkPresence } from "./ThreadForkNotice.presence";
import { ThreadRecoveryNotice } from "./ThreadRecoveryNotice";

/** Recovery status plus fork lineage for a server thread (plan D15-D17, D20-D21). */
export function ThreadRecoveryNotices({ thread }: { readonly thread: Thread }) {
  const { continueInNewThread, carryToContinuedThread, pending } = useContinueInNewThread(thread);
  const { messages, activities } = thread;
  const isForkPresent = useForkPresence(activities);
  // Once the thread continued in a fork that still exists, the fork notice links it instead.
  const alreadyForked = useMemo(
    () => deriveSourceForkNotice({ messages, activities }, isForkPresent) !== null,
    [messages, activities, isForkPresent],
  );
  return (
    <>
      <ThreadForkNotice
        thread={thread}
        isForkPresent={isForkPresent}
        onCarryToContinuedThread={(forkThreadId, carry) =>
          void carryToContinuedThread(forkThreadId, carry)
        }
        carryPending={pending}
      />
      <ThreadRecoveryNotice
        thread={thread}
        onContinueInNewThread={alreadyForked ? undefined : () => void continueInNewThread()}
        continuePending={pending}
      />
    </>
  );
}
