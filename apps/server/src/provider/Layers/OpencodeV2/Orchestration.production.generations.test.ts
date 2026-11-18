import { expect, it } from "vitest";
import {
  runV2ProductionCurrentFixture,
  runV2ProductionGenerationsFixture,
} from "./Orchestration.production.generations.fixture.ts";

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

it("current v5 bootstrap keeps the preferred path and rejects incompatible rollback", async () => {
  expect(await runV2ProductionCurrentFixture()).toEqual({
    bootstrapAbi: "bigbud.thread.bootstrap.v5",
    incompatibleRollbackRejected: true,
    completedDuplicate: true,
  });
});
