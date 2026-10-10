import { Effect } from "effect";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { assertV2NoSavedGrants } from "./Runtime.permissions.saved.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

/** Native execution mutations require a live canonical owner as well as exact process/settings ownership. */
export function v2ExecutionGuard(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  canonicalOwnerThreadId: ThreadId = session.threadId,
) {
  const guard = v2ReplyGuard(runtime.options, runtime.sessions, session);
  return async () => {
    if (session.localTools)
      await assertV2NoSavedGrants(session.lease.process.client, session.native);
    await Effect.runPromise(runtime.options.journal.assertOwnerAvailable(canonicalOwnerThreadId));
    return guard();
  };
}
