import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import type { ProviderTurnAdmissionsShape } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { assertV2RetainedWorkspace } from "./Runtime.workspaceLocation.ts";

function fixture(lineage: boolean) {
  const admission = Schema.decodeUnknownSync(ProviderTurnAdmission)({
    namespace: "foreground",
    ownerThreadId: "thread",
    requestMessageId: "message",
    binding: {
      provider: "opencodeV2",
      threadId: "thread",
      nativeSessionId: "native",
      storageIdentity: "storage",
      location: "/old",
      runtimeTargetId: "local",
      workspaceTargetId: "local",
    },
    fingerprint: "immutable",
    nativeAdmissionId: "native-message",
    turnId: "turn",
    state: "terminal",
    revision: 3,
    createdAt: "now",
    updatedAt: "now",
    finalText: "original output",
  });
  const unexpected = () => Effect.die(new Error("Unexpected mutation/replay/recovery call"));
  const resolve = vi.fn(() => Effect.succeed("/new"));
  const journal: ProviderTurnAdmissionsShape = {
    assertOwnerAvailable: unexpected,
    listBoundPage: unexpected,
    compactTerminal: unexpected,
    listBound: unexpected,
    reserve: unexpected,
    find: unexpected,
    transition: unexpected,
    settleProvenRefusal: unexpected,
    listUnresolved: unexpected,
    latestBound: () => Effect.succeed(admission),
    ...(lineage ? { effectiveWorkspaceLocation: resolve } : {}),
  };
  const cursor = {
    provider: "opencodeV2",
    nativeSessionId: "native",
    storageIdentity: "storage",
    directory: "/old",
    connectionMode: "shared",
    model: { id: "original-model", providerID: "provider" },
  };
  const input = {
    threadId: admission.binding.threadId,
    runtimeMode: "full-access" as const,
    resumeCursor: cursor,
  };
  const binding = {
    nativeSessionId: "native",
    storageIdentity: "storage",
    directory: "/new",
    runtimeTarget: "local",
    workspaceTarget: "local",
  };
  return { journal, resolve, admission, cursor, input, binding };
}

describe("V2 retained workspace lineage attachment", () => {
  it("resolves only effective directory while retaining exact native/model identity and raw history", async () => {
    const f = fixture(true);
    const before = JSON.stringify(f.admission);
    const result = await assertV2RetainedWorkspace(f.journal, f.input, f.binding, "shared");
    expect(result.cursor).toEqual({ ...f.cursor, directory: "/new" });
    expect(result.retained).toBe(f.admission);
    expect(JSON.stringify(f.admission)).toBe(before);
    expect(f.cursor.directory).toBe("/old");
    expect(f.resolve).toHaveBeenCalledWith(f.admission.binding);
  });

  it("never accepts an old Location without verified lineage support", async () => {
    const f = fixture(false);
    await expect(
      assertV2RetainedWorkspace(f.journal, f.input, f.binding, "shared"),
    ).rejects.toThrow("read-only");
  });

  it.each(["nativeSessionId", "storageIdentity", "runtimeTarget", "workspaceTarget"] as const)(
    "never substitutes another %s even with a verified effective directory",
    async (key) => {
      const f = fixture(true);
      await expect(
        assertV2RetainedWorkspace(f.journal, f.input, { ...f.binding, [key]: "foreign" }, "shared"),
      ).rejects.toThrow("read-only");
    },
  );

  it("does not turn retired isolated cursor ownership into shared ownership", async () => {
    const f = fixture(true);
    await expect(
      assertV2RetainedWorkspace(
        f.journal,
        { ...f.input, resumeCursor: { ...f.cursor, connectionMode: "isolated" } },
        f.binding,
        "shared",
      ),
    ).rejects.toThrow("resume ownership mismatch");
  });
});
