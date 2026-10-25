import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { buildSessionConfig } from "./Adapter.session.config.ts";
import type { PendingApprovalRequest } from "./Adapter.types.ts";

afterEach(() => vi.useRealTimers());

it("never schedules managed-policy auto approval in full-access mode", async () => {
  vi.useFakeTimers();
  const pendingApprovals = new Map<string, PendingApprovalRequest>();
  const opened: unknown[] = [];
  const config = buildSessionConfig({
    threadId: ThreadId.makeUnsafe("managed"),
    runtimeMode: "full-access",
    pendingApprovals,
    pendingUserInputs: new Map(),
    activeTurnId: () => undefined,
    stoppedRef: { stopped: false },
    emit: () => Effect.void,
    makeSyntheticEvent: (_id, _type, payload) => {
      opened.push(payload);
      return Effect.succeed({} as never);
    },
  });
  const response = config.onPermissionRequest!(
    { kind: "read", managedApprovalRequired: true } as PermissionRequest,
    { sessionId: "test" },
  );
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pendingApprovals.size).toBe(1);
  expect(opened[0]).not.toHaveProperty("autoApproveAfterMs");
  expect(opened[0]).toHaveProperty("sessionApprovalAvailable", false);
  pendingApprovals.values().next().value!.resolve({ kind: "approve-once" });
  await expect(response).resolves.toEqual({ kind: "approve-once" });
});
