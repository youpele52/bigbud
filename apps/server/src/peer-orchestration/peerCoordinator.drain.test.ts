import { describe, expect, it } from "vitest";

import { requestFollowerDrain } from "../cli/cli.backend.drain.ts";

describe("peer coordinator follower drain", () => {
  it("drains the exact follower set through the coordinator", async () => {
    await expect(requestFollowerDrain(3, async () => 3)).resolves.toEqual({
      kind: "drain-through-coordinator",
      followers: 3,
    });
  });

  it("refuses a partial drain without abandoning the rest", async () => {
    await expect(requestFollowerDrain(3, async () => 2)).resolves.toMatchObject({
      kind: "refuse",
      error: { reason: "refused" },
    });
  });

  it("refuses a rejected coordinator request", async () => {
    await expect(
      requestFollowerDrain(2, async () => Promise.reject(new Error("cancel refused"))),
    ).resolves.toMatchObject({ kind: "refuse", error: { reason: "unavailable" } });
  });

  it("refuses an unreachable coordinator and a follower-count mismatch", async () => {
    await expect(requestFollowerDrain(1, async () => 0)).resolves.toMatchObject({
      kind: "refuse",
    });
    await expect(requestFollowerDrain(1)).resolves.toMatchObject({
      kind: "refuse",
      error: { reason: "drain-hook-unavailable" },
    });
  });
});
