import { assert, describe, it } from "@effect/vitest";

import { reconcileClaudeInterruptQueue } from "./Adapter.utils.ts";

describe("Claude interrupt receipt reconciliation", () => {
  it("retains only queued UUIDs reported by the SDK and drops cancelled UUIDs", () => {
    const result = reconcileClaudeInterruptQueue(new Set(["keep", "cancel", "unknown"]), {
      still_queued: ["keep"],
      cancelled: ["cancel"],
    });

    assert.deepEqual(result, { stillQueued: ["keep"], cancelled: ["cancel"] });
  });

  it("preserves the bounded queue when an older SDK returns no receipt", () => {
    assert.deepEqual(reconcileClaudeInterruptQueue(new Set(["queued"]), undefined), {
      stillQueued: ["queued"],
      cancelled: [],
    });
  });
});
