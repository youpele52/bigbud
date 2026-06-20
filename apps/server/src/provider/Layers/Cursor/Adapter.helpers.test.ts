import { ApprovalRequestId, type ProviderApprovalDecision } from "@bigbud/contracts";
import { FULL_ACCESS_AUTO_APPROVE_AFTER_MS } from "@bigbud/shared/approvals";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { vi } from "vitest";

import {
  scheduleFullAccessPermissionAutoApproval,
  selectAutoApprovedPermissionOption,
} from "./Adapter.helpers.ts";

describe("selectAutoApprovedPermissionOption", () => {
  it("prefers allow_always over allow_once", () => {
    const optionId = selectAutoApprovedPermissionOption({
      options: [
        { optionId: "once", kind: "allow_once", name: "Once" },
        { optionId: "always", kind: "allow_always", name: "Always" },
      ],
    } as unknown as Parameters<typeof selectAutoApprovedPermissionOption>[0]);

    assert.equal(optionId, "always");
  });
});

describe("scheduleFullAccessPermissionAutoApproval", () => {
  it("auto-approves pending requests after the full-access delay", async () => {
    vi.useFakeTimers();

    const requestId = ApprovalRequestId.makeUnsafe("approval-1");
    const decision = await Effect.runPromise(Deferred.make<ProviderApprovalDecision>());
    const pendingApprovals = new Map([[requestId, { decision, kind: "tool" }]]);

    scheduleFullAccessPermissionAutoApproval({
      requestId,
      pendingApprovals,
      stopped: () => false,
      decision,
    });

    await vi.advanceTimersByTimeAsync(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
    const resolved = await Effect.runPromise(Deferred.await(decision));
    assert.equal(resolved, "acceptForSession");

    vi.useRealTimers();
  });

  it("does not resolve approvals after the session stops", async () => {
    vi.useFakeTimers();

    const requestId = ApprovalRequestId.makeUnsafe("approval-2");
    const decision = await Effect.runPromise(Deferred.make<ProviderApprovalDecision>());
    const pendingApprovals = new Map([[requestId, { decision, kind: "tool" }]]);
    let stopped = false;

    scheduleFullAccessPermissionAutoApproval({
      requestId,
      pendingApprovals,
      stopped: () => stopped,
      decision,
    });

    stopped = true;
    await vi.advanceTimersByTimeAsync(FULL_ACCESS_AUTO_APPROVE_AFTER_MS);
    assert.equal(pendingApprovals.has(requestId), true);

    vi.useRealTimers();
  });
});
