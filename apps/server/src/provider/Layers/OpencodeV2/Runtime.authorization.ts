import { Effect } from "effect";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";
import { assertV2SavedGrantsCompatible } from "./Runtime.permissions.saved.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { assertV2CallerCurrent } from "./Runtime.caller.ts";

/** Native execution mutations require a live canonical owner as well as exact process/settings ownership. */
export function v2ExecutionGuard(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  canonicalOwnerThreadId: ThreadId = session.threadId,
) {
  const guard = v2ReplyGuard(runtime.options, runtime.sessions, session);
  return async () => {
    assertV2CallerCurrent();
    if (session.localTools)
      await assertV2SavedGrantsCompatible(
        session.lease.process.client,
        session.native,
        session.toolPolicy,
      );
    await Effect.runPromise(runtime.options.journal.assertOwnerAvailable(canonicalOwnerThreadId));
    assertV2CallerCurrent();
    const validate = await guard();
    assertV2CallerCurrent();
    return () => {
      assertV2CallerCurrent();
      validate();
    };
  };
}
