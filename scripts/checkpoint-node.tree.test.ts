import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runCheckpointNodeTest } from "./lib/checkpoint-node-tests";
import {
  createCheckpointTreeFixture,
  fixtureProcessRunning,
} from "./lib/checkpoint-node-tests.tree-fixture";
import {
  createOwnedNodeExecutor,
  OwnedNodeHarnessError,
} from "./lib/checkpoint-node-tests.process";
import { scriptsRoot } from "./lib/checkpoint-node-tests.inventory";
import { combinedCheckpointFailure } from "./lib/checkpoint-node-tests.errors";

type Outcome = Promise<OwnedNodeHarnessError | undefined>;

it("nested compiler execution stays inside the outer owned boundary", async () => {
  const fixture = await createCheckpointTreeFixture(false, false, { nestedCompiler: true });
  const controller = new AbortController();
  const outcome: Outcome = runCheckpointNodeTest(fixture.file, {
    timeoutMs: 20000,
    signal: controller.signal,
  }).then(
    () => undefined,
    (error: OwnedNodeHarnessError) => error,
  );
  let primary: unknown;
  try {
    const identity = await fixture.ready();
    if (process.platform !== "win32") expect(identity.group).toBe(identity.root);
    controller.abort();
    expect((await outcome)?.code).toBe("NODE_CANCELLED");
    const heartbeat = await fixture.heartbeat();
    await delay(200);
    expect(await fixture.heartbeat()).toBe(heartbeat);
    expect(await fixtureProcessRunning(identity.root)).toBe(false);
    expect(await fixtureProcessRunning(identity.descendant)).toBe(false);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await finishFixture(fixture, outcome, controller, primary);
  }
}, 40000);
async function finishFixture(
  fixture: Awaited<ReturnType<typeof createCheckpointTreeFixture>>,
  outcome: Outcome,
  controller: AbortController,
  primary?: unknown,
) {
  controller.abort();
  const result = await outcome;
  try {
    await fixture.dispose(result?.code !== "NODE_TREE_CLEANUP_UNKNOWN");
  } catch (cleanup) {
    if (primary)
      throw combinedCheckpointFailure(
        primary,
        cleanup,
        "Tree regression and fixture cleanup failed",
      );
    throw cleanup;
  }
}
const options = { cwd: path.resolve(scriptsRoot, ".."), timeoutMs: 20000, maxBuffer: 512 };
const args = (file: string) => ["--test", "--test-isolation=none", "--test-reporter=tap", file];

it.each([false, true])(
  "stops the descendant after readiness-controlled cancellation, overflow=%s",
  async (overflow) => {
    const fixture = await createCheckpointTreeFixture(overflow);
    const controller = new AbortController();
    const outcome: Outcome = runCheckpointNodeTest(fixture.file, {
      timeoutMs: 20000,
      signal: controller.signal,
      ...(overflow ? { maxBuffer: 512 } : {}),
    }).then(
      () => undefined,
      (error: OwnedNodeHarnessError) => error,
    );
    let primary: unknown;
    try {
      const identity = await fixture.ready();
      if (process.platform !== "win32") {
        expect(identity.group).toBe(identity.root);
        expect(identity.group).not.toBe(process.pid);
        expect(identity.group).not.toBe(process.ppid);
      }
      if (overflow) await fixture.trigger();
      else controller.abort();
      expect((await outcome)?.code).toBe(overflow ? "NODE_OUTPUT_LIMIT" : "NODE_CANCELLED");
      const heartbeat = await fixture.heartbeat();
      await delay(200);
      expect(await fixture.heartbeat()).toBe(heartbeat);
      expect(await fixtureProcessRunning(identity.root)).toBe(false);
      expect(await fixtureProcessRunning(identity.descendant)).toBe(false);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      await finishFixture(fixture, outcome, controller, primary);
    }
  },
  40000,
);

it.skipIf(process.platform === "win32")(
  "failed group termination blocks retries even after late reap",
  async () => {
    const fixture = await createCheckpointTreeFixture(true);
    const controller = new AbortController();
    const originalKill = process.kill;
    const signals: number[] = [];
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, kind) => {
      if (pid < 0) {
        signals.push(pid);
        throw new Error("synthetic group EPERM");
      }
      return originalKill(pid, kind);
    });
    const execute = createOwnedNodeExecutor();
    const outcome: Outcome = execute(args(fixture.file), {
      ...options,
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: OwnedNodeHarnessError) => error,
    );
    let primary: unknown;
    try {
      const identity = await fixture.ready();
      await fixture.trigger();
      expect((await outcome)?.code).toBe("NODE_TREE_CLEANUP_UNKNOWN");
      await expect(execute(["--version"], options)).rejects.toMatchObject({
        code: "NODE_TREE_CLEANUP_UNKNOWN",
      });
      expect(signals).toEqual([-identity.root]);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        await finishFixture(fixture, outcome, controller, primary);
      } finally {
        signal.mockRestore();
      }
    }
    await expect(execute(["--version"], options)).rejects.toMatchObject({
      code: "NODE_TREE_CLEANUP_UNKNOWN",
    });
    expect(signals).toHaveLength(1);
  },
  40000,
);

it("never acts on a numeric PID after leader reap/lost identity", async () => {
  const fixture = await createCheckpointTreeFixture(false, true);
  const controller = new AbortController();
  const signal = vi.spyOn(process, "kill");
  const execute = createOwnedNodeExecutor();
  const outcome: Outcome = execute(args(fixture.file), {
    ...options,
    maxBuffer: 65536,
    signal: controller.signal,
  }).then(
    () => undefined,
    (error: OwnedNodeHarnessError) => error,
  );
  let primary: unknown;
  try {
    const identity = await fixture.ready();
    await fixture.waitForRootExit();
    controller.abort();
    expect((await outcome)?.code).toBe("NODE_TREE_CLEANUP_UNKNOWN");
    expect(await fixtureProcessRunning(identity.root)).toBe(false);
    expect(signal.mock.calls.filter(([pid]) => pid < 0)).toEqual([]);
    await expect(execute(["--version"], options)).rejects.toMatchObject({
      code: "NODE_TREE_CLEANUP_UNKNOWN",
    });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await finishFixture(fixture, outcome, controller, primary);
    } finally {
      signal.mockRestore();
    }
  }
}, 40000);

it("cleans a cancelled tree when readiness never arrives, without a second readiness wait", async () => {
  const fixture = await createCheckpointTreeFixture(false, false, {
    publishReadiness: false,
    startupBudgetMs: 500,
  });
  const controller = new AbortController();
  const outcome: Outcome = runCheckpointNodeTest(fixture.file, {
    timeoutMs: 20000,
    signal: controller.signal,
  }).then(
    () => undefined,
    (error: OwnedNodeHarnessError) => error,
  );
  let primary: unknown;
  try {
    await expect(fixture.ready()).rejects.toThrow("startup budget");
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await finishFixture(fixture, outcome, controller, primary);
  }
  await expect(access(fixture.directory)).rejects.toMatchObject({ code: "ENOENT" });
}, 40000);
