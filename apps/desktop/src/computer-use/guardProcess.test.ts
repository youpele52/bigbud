import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startGuardProcess } from "./guardProcess";

// Dummy children only: each test starts its own short-lived node process.
const node = process.execPath;
const script = (source: string) => ["-e", source];
const REPO_ROOT = Path.resolve(import.meta.dirname, "../../../..");
const GUARD_BINARY = Path.join(REPO_ROOT, "target", "debug", "bigbud-computer-use");

describe("startGuardProcess", () => {
  afterEach(() => {
    delete process.env.BIGBUD_TEST_GUARD_SECRET;
  });

  it("serves until the lifeline closes, then exits in order", async () => {
    const guard = startGuardProcess({
      binaryPath: node,
      args: script("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"),
    });
    expect(guard.state().kind).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(guard.state().kind).toBe("running");
    expect(await guard.stop()).toMatchObject({ kind: "exited", reason: "settled" });
  });

  it("reports a native conflict exit without restarting", async () => {
    const guard = startGuardProcess({ binaryPath: node, args: script("process.exit(4)") });
    expect(await guard.exited).toMatchObject({ kind: "exited", reason: "conflict" });
    expect(await guard.stop()).toMatchObject({ reason: "conflict" });
  });

  it("kills a guard that ignores the lifeline after the grace period", async () => {
    const guard = startGuardProcess({
      binaryPath: node,
      args: script("process.stdin.resume(); setInterval(() => {}, 1000);"),
      stopGraceMs: 200,
    });
    expect(await guard.stop()).toMatchObject({ kind: "exited", reason: "killed" });
  });

  it("keeps stderr written just before exit in the tail", async () => {
    // Regression (review P3): exit used to settle before stdio drained.
    const guard = startGuardProcess({
      binaryPath: node,
      args: script("process.stderr.write('x'.repeat(2048) + 'END'); process.exitCode = 3"),
    });
    const exited = await guard.exited;
    expect(exited).toMatchObject({ reason: "storage" });
    expect(exited.kind === "exited" && exited.stderrTail.endsWith("END")).toBe(true);
  });

  it("reports spawn failure for a missing binary", async () => {
    const guard = startGuardProcess({ binaryPath: "/nonexistent/bigbud-guard", args: [] });
    expect(await guard.exited).toMatchObject({ kind: "exited", reason: "spawn-failed" });
  });

  it("does not pass the parent environment to the guard", async () => {
    process.env.BIGBUD_TEST_GUARD_SECRET = "secret-value";
    const guard = startGuardProcess({
      binaryPath: node,
      args: script(
        "process.stderr.write(String(process.env.BIGBUD_TEST_GUARD_SECRET), () => process.exit(0))",
      ),
    });
    const exited = await guard.exited;
    expect(exited).toMatchObject({ reason: "settled" });
    expect(exited.kind === "exited" && exited.stderrTail).toBe("undefined");
  });

  it.skipIf(!FS.existsSync(GUARD_BINARY))(
    "maps the real guard's refusal of a root outside the account home",
    async () => {
      const outside = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-guard-"));
      const target = Path.join(outside, "computer-use");
      const guard = startGuardProcess({
        binaryPath: GUARD_BINARY,
        args: ["guard", "--development-root", target],
      });
      expect(await guard.exited).toMatchObject({ reason: "storage" });
      expect(FS.existsSync(target)).toBe(false);
      FS.rmSync(outside, { recursive: true, force: true });
    },
  );
});
