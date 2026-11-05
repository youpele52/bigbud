import { describe, expect, it } from "vitest";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "./codexAppServerManager.reliability.test.helpers.ts";
import {
  prepareCodexRewind,
  revertCodexThread,
  verifyCodexRewind,
} from "./codexAppServerManager.rewind.ts";
import { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";

function harness() {
  const test = codexReliabilityHarness();
  const original = [...test.state.turns];
  const maintenance = (id: string) => ({
    ...original[0]!,
    id,
    items: [{ type: "contextCompaction", id: `item-${id}` }],
  });
  test.state.turns = [
    maintenance("m0"),
    original[0]!,
    maintenance("m1"),
    original[1]!,
    maintenance("m2"),
  ];
  const input = {
    ...exactRewindInput,
    maintenanceTurns: { m0: "item-m0", m1: "item-m1", m2: "item-m2" },
  };
  return { ...test, input };
}

describe("exact native boundaries with durable manual compaction proofs", () => {
  it.each(["0.164.0", "0.166.0"])(
    "retains the precise native prefix for pinned %s",
    async (version) => {
      for (const target of [0, 1, 2]) {
        const test = harness();
        test.context.runtimeVersion = version;
        const input = {
          ...test.input,
          runtimeVersion: version,
          targetTurnCount: target,
          retainedTurnId: test.input.expectedTurnIds[target - 1] ?? null,
          firstRemovedTurnId: test.input.expectedTurnIds[target] ?? null,
        };
        const prepared = await prepareCodexRewind(test.context, input, test.ops);
        expect(prepared.nativeTurnIds).toEqual(["m0", "t1", "m1", "t2", "m2"]);
        // The durable marker, not mutable live counters, carries the full native identity prefix.
        const persisted = JSON.parse(JSON.stringify({ ...input, ...prepared }));
        const result = await revertCodexThread(test.context, persisted, test.ops);
        expect(result.turns.map((turn) => turn.id)).toEqual(
          target === 0
            ? ["m0"]
            : target === 1
              ? ["m0", "t1", "m1"]
              : ["m0", "t1", "m1", "t2", "m2"],
        );
        const mutations = test.sendRequest.mock.calls.filter((call) => call[1] === "thread/revert");
        expect(mutations.map((call) => call[2])).toEqual(
          target === 2 ? [] : [{ threadId: "native", beforeTurnId: target === 0 ? "t1" : "t2" }],
        );
        await verifyCodexRewind(test.context, persisted, test.ops);
      }
    },
  );
  it.each([
    "missing-proof",
    "wrong-item",
    "empty",
    "user-auto",
    "unproven-auto",
    "failed",
    "unknown",
  ])("rejects %s without a native mutation", async (fault) => {
    const test = harness();
    if (fault === "missing-proof")
      delete (test.input.maintenanceTurns as Record<string, string>).m1;
    if (fault === "wrong-item")
      test.state.turns[2]!.items = [{ type: "contextCompaction", id: "other" }];
    if (fault === "empty") test.state.turns[2]!.items = [];
    if (fault === "user-auto")
      test.state.turns[2]!.items.push({ type: "userMessage", id: "prompt" });
    if (fault === "unproven-auto") {
      test.state.turns[2]!.id = "automatic-before-user-message";
    }
    if (fault === "failed") test.state.turns[2]!.status = "failed";
    if (fault === "unknown")
      test.state.turns.splice(3, 0, { ...test.state.turns[1]!, id: "unknown", items: [] });
    await expect(revertCodexThread(test.context, test.input, test.ops)).rejects.toThrow("boundary");
    expect(test.sendRequest.mock.calls.some((call) => call[1] === "thread/revert")).toBe(false);
  });
  it("never excludes a canonical user turn containing automatic compaction", async () => {
    const test = harness();
    test.state.turns[1]!.items = [
      { type: "userMessage", id: "u1" },
      { type: "contextCompaction", id: "auto1" },
    ];
    test.state.turns[3]!.items = [
      { type: "contextCompaction", id: "auto2" },
      { type: "userMessage", id: "u2" },
    ];
    const prepared = await prepareCodexRewind(test.context, test.input, test.ops);
    const result = await revertCodexThread(test.context, { ...test.input, ...prepared }, test.ops);
    expect(result.turns.map((turn) => turn.id)).toEqual(["m0", "t1", "m1"]);
    expect(result.turns[1]?.items).toEqual(test.state.turns[1]?.items);
  });
  it("rejects unknown history introduced after durable preflight", async () => {
    const test = harness();
    const prepared = await prepareCodexRewind(test.context, test.input, test.ops);
    test.state.turns.splice(2, 0, {
      ...test.state.turns[0]!,
      id: "unproven",
      items: [{ type: "contextCompaction", id: "not-a-proof" }],
    });
    await expect(
      revertCodexThread(test.context, { ...test.input, ...prepared }, test.ops),
    ).rejects.toThrow();
    expect(test.sendRequest.mock.calls.some((call) => call[1] === "thread/revert")).toBe(false);
  });
  it("rejects even a proven turn inserted after the persisted native prefix was frozen", async () => {
    const test = harness();
    const prepared = await prepareCodexRewind(test.context, test.input, test.ops);
    test.state.turns.push({
      ...test.state.turns[0]!,
      id: "later",
      items: [{ type: "contextCompaction", id: "later-item" }],
    });
    const input = {
      ...test.input,
      ...prepared,
      maintenanceTurns: { ...test.input.maintenanceTurns, later: "later-item" },
    };
    await expect(revertCodexThread(test.context, input, test.ops)).rejects.toThrow(
      "identity changed",
    );
  });
  it("rejects losing a legitimate retained maintenance turn during hydration", async () => {
    const test = harness();
    const prepared = await prepareCodexRewind(test.context, test.input, test.ops);
    const persisted = { ...test.input, ...prepared };
    await revertCodexThread(test.context, persisted, test.ops);
    test.state.turns = test.state.turns.filter((turn) => turn.id !== "m1");
    await expect(verifyCodexRewind(test.context, persisted, test.ops)).rejects.toThrow(
      "exact checkpoint prefix",
    );
  });
  it("refuses reordered canonical turns even when a maintenance proof names one", async () => {
    const test = harness();
    test.state.turns[1]!.id = "t2";
    test.state.turns[3]!.id = "t1";
    await expect(
      prepareCodexRewind(
        test.context,
        { ...test.input, maintenanceTurns: { ...test.input.maintenanceTurns, t2: "auto" } },
        test.ops,
      ),
    ).rejects.toThrow("boundary");
    expect(TurnId.makeUnsafe("t1")).toBe(test.input.retainedTurnId);
  });
});
