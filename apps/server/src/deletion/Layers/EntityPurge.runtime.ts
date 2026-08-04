import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { makeEntityPurgeSql } from "./EntityPurge.sql.ts";

export const assertThreadRuntimeQuiescent = Effect.fn("EntityPurge.assertThreadRuntimeQuiescent")(
  function* (queries: ReturnType<typeof makeEntityPurgeSql>, threadId: ThreadId) {
    const active = yield* queries.countThreadRuntimes({ threadId });
    if (active.count > 0) {
      return yield* Effect.fail(new Error("thread has an active durable activity lease"));
    }
  },
);
