import { describe, expect, it } from "vitest";

import {
  createSshDeadline,
  runSshLocalCommand,
  runSshLocalCommandSync,
} from "./sshLocalCommand.ts";

/** Longest gap between 10 ms timer ticks while `run` is pending. */
async function measureMaxLoopGap<T>(
  run: () => Promise<T>,
): Promise<{ result: T; maxGapMs: number }> {
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 10);
  try {
    const result = await run();
    return { result, maxGapMs: Math.max(maxGapMs, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

describe.skipIf(process.platform === "win32")("runSshLocalCommand", () => {
  it("captures output and the exit status", async () => {
    const result = await runSshLocalCommand("sh", ["-c", "echo out; echo err >&2; exit 3"], {
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ status: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("kills a hung command at the deadline without blocking the event loop", async () => {
    const startedAt = performance.now();
    const { result, maxGapMs } = await measureMaxLoopGap(() =>
      runSshLocalCommand("sleep", ["30"], { timeoutMs: 300 }),
    );
    expect(result.timedOut).toBe(true);
    expect(result.error?.message).toMatch(/did not finish/);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(maxGapMs).toBeLessThan(200);
  });

  it("settles on exit even when a daemonized child keeps the output pipe open", async () => {
    const startedAt = performance.now();
    const result = await runSshLocalCommand("sh", ["-c", "sleep 5 & echo started"], {
      timeoutMs: 4_000,
    });
    expect(result).toMatchObject({ status: 0, stdout: "started\n", timedOut: false });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("reports a missing command as an error rather than hanging", async () => {
    const result = await runSshLocalCommand("bigbud-missing-command-for-test", [], {
      timeoutMs: 5_000,
    });
    expect(result.error).toBeDefined();
    expect(result.timedOut).toBe(false);
  });

  it("bounds the synchronous runner with its timeout", () => {
    const startedAt = performance.now();
    const result = runSshLocalCommandSync("sleep", ["30"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("createSshDeadline", () => {
  it("caps each command by the remaining overall budget", () => {
    const deadline = createSshDeadline(1_000);
    expect(deadline.remainingMs(5_000)).toBeLessThanOrEqual(1_000);
    expect(deadline.remainingMs(10)).toBe(10);
  });
});
