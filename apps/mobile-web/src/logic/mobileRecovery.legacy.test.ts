import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it, vi } from "vitest";

import { makeSnapshot } from "./mobileRecovery.test.utils";
import { readLegacyMobileBaseline } from "./mobileRecovery.legacy";

const selectedThreadId = ThreadId.makeUnsafe("thread-missing");

function makeClient(threadError: Error) {
  return {
    getSnapshot: vi.fn(async () => makeSnapshot(4)),
    getMobileThread: vi.fn(async () => {
      throw threadError;
    }),
    getMobileRecoveryBaseline: vi.fn(),
    startMobileRecoveryStream: vi.fn(),
    onDomainEvent: vi.fn(() => () => undefined),
  };
}

function read(client: ReturnType<typeof makeClient>) {
  return readLegacyMobileBaseline({
    client: client as never,
    recoveryAttemptId: "legacy-1",
    selectedThreadId,
    isCurrent: () => true,
  });
}

describe("legacy mobile recovery", () => {
  it("maps the legacy endpoint's explicit missing response", async () => {
    const baseline = await read(
      makeClient(new Error("Thread not found in orchestration snapshot")),
    );

    expect(baseline.selectedThread).toEqual({ status: "missing" });
  });

  it("does not hide generic selected-thread failures as missing", async () => {
    await expect(
      read(makeClient(new Error("Timed out waiting for the desktop thread."))),
    ).rejects.toThrow("Timed out waiting for the desktop thread.");
  });
});
