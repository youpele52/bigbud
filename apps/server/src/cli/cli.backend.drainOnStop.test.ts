import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  BackendDrainError,
  planFollowerDrain,
  runBackendForUpgradeStop,
  type BackendLockLease,
} from "./cli.backend.drain.ts";

const lease = () => {
  const release = vi.fn(async () => undefined);
  return { lease: { release } as BackendLockLease, release };
};

describe("backend stop --for-upgrade", () => {
  it("exits successfully only after the drain released the lock", async () => {
    const { lease: lock, release } = lease();
    const outcome = await Effect.runPromise(
      runBackendForUpgradeStop({
        acquireLock: Effect.succeed(lock),
        drain: (acquired) =>
          Effect.promise(async () => {
            await acquired.release();
            return "drained" as const;
          }),
      }),
    );
    expect(outcome).toBe("drained");
    expect(release).toHaveBeenCalledOnce();
  });

  it("refuses while the backend still holds its lock and drains nothing", async () => {
    const release = vi.fn(async () => undefined);
    await expect(
      Effect.runPromise(
        runBackendForUpgradeStop({
          acquireLock: Effect.fail(
            new BackendDrainError("backend-running", "the backend still owns the lock"),
          ),
          drain: () => Effect.succeed("drained"),
        }),
      ),
    ).rejects.toMatchObject({ reason: "backend-running" });
    expect(release).not.toHaveBeenCalled();
  });

  it("cancels with no release and no marker", async () => {
    const { lease: lock, release } = lease();
    const marker = vi.fn();
    await expect(
      Effect.runPromise(
        runBackendForUpgradeStop({
          acquireLock: Effect.succeed(lock),
          drain: () => Effect.succeed("cancelled" as const),
        }),
      ),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(release).not.toHaveBeenCalled();
    expect(marker).not.toHaveBeenCalled();
  });

  it("propagates a refusal or failure without releasing the lock", async () => {
    const { lease: lock, release } = lease();
    await expect(
      Effect.runPromise(
        runBackendForUpgradeStop({
          acquireLock: Effect.succeed(lock),
          drain: () => Effect.fail(new BackendDrainError("failed", "drain failed")),
        }),
      ),
    ).rejects.toMatchObject({ reason: "failed" });
    expect(release).not.toHaveBeenCalled();
  });

  it("refuses a follower set this build cannot drain through the coordinator", () => {
    expect(planFollowerDrain(0)).toEqual({ kind: "drain-through-coordinator", followers: 0 });
    expect(planFollowerDrain(2)).toMatchObject({
      kind: "refuse",
      error: { reason: "drain-hook-unavailable" },
    });
    expect(planFollowerDrain(-1)).toMatchObject({ kind: "refuse" });
  });

  it("renders ExecStop before ExecStopPost and never silently omits the drain", () => {
    const unit = readFileSync(
      new URL(
        "../../../../crates/bigbud-remote-agent/src/backend_service/unit.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const cli = readFileSync(
      new URL("../../../../crates/bigbud-remote-agent/src/backend_service/cli.rs", import.meta.url),
      "utf8",
    );
    const execStop = unit.indexOf("ExecStop={launcher} --backend-service drain {path}");
    const execStopPost = unit.indexOf("{BACKEND_STOP_POST}");
    expect(execStop).toBeGreaterThan(-1);
    expect(execStopPost).toBeGreaterThan(-1);
    expect(execStop).toBeLessThan(execStopPost);
    expect(cli).toContain("--for-upgrade");
  });
});
