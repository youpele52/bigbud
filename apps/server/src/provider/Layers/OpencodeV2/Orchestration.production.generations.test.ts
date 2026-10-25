import { expect, it } from "vitest";
import { runV2ProductionGenerationsFixture } from "./Orchestration.production.generations.fixture.ts";

it("genuine frozen A/B handlers stay pinned across selection/rollback through actual canonical HTTP/SQLite", async () => {
  const result = await runV2ProductionGenerationsFixture();
  expect(result).toMatchObject({
    nativeQualified: false,
    canonicalCreates: 1,
    aReturnedCount: 2,
    bReturnedCount: 1,
    completedDuplicates: true,
    bootstrapBytesAndInodesUnchanged: true,
  });
  expect(result.aDigest).not.toBe(result.bDigest);
});
