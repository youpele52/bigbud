import type { OrchestrationThread } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import { installMobileSelectedThread, selectedThreadRecoveryState } from "./mobileRecovery.cache";
import { makeBaseline, makeQueryClient, sessionId } from "./mobileRecovery.test.utils";
import { threadKey } from "./mobileRecovery.types";

const threadId = ThreadId.makeUnsafe("thread-bounded");
const thread = { id: threadId } as unknown as OrchestrationThread;

describe("selectedThreadRecoveryState", () => {
  it("carries the baseline's older-history flag for a present selected thread", () => {
    const baseline = makeBaseline("attempt", 4, {
      status: "present",
      thread,
      hasOlderHistory: true,
    });
    const queryClient = makeQueryClient();

    installMobileSelectedThread(queryClient, sessionId, threadId, baseline);

    expect(selectedThreadRecoveryState(threadId, baseline)).toEqual({
      selectedThreadStatus: "present",
      selectedThreadHasOlderHistory: true,
    });
    expect(queryClient.getQueryData(threadKey(sessionId, threadId))).toBe(thread);
  });

  it("treats an absent flag, missing thread, or no selection as complete history", () => {
    expect(
      selectedThreadRecoveryState(
        threadId,
        makeBaseline("attempt", 4, { status: "present", thread }),
      ),
    ).toEqual({ selectedThreadStatus: "present", selectedThreadHasOlderHistory: false });
    expect(
      selectedThreadRecoveryState(threadId, makeBaseline("attempt", 4, { status: "missing" })),
    ).toEqual({ selectedThreadStatus: "missing", selectedThreadHasOlderHistory: false });
    expect(selectedThreadRecoveryState(null, makeBaseline("attempt", 4))).toEqual({
      selectedThreadStatus: "none",
      selectedThreadHasOlderHistory: false,
    });
  });
});
