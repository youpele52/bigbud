import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LEGACY_BRIDGE_MIN_AGE_MS, sweepStaleBigbudTempDirs } from "./tempDirSweep.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60_000;

/** A pid that existed and has exited. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

function mcpBridge(root: string, suffix: string, owner: "dead" | "live" | "none") {
  const dir = path.join(root, `bigbud-orchestration-mcp-${suffix}`);
  mkdirSync(path.join(dir, ".bigbud"), { recursive: true });
  writeFileSync(path.join(dir, ".bigbud", "orchestration-mcp-server.mjs"), "");
  // Another live process (this test's parent) owns it.
  if (owner === "live")
    writeFileSync(path.join(dir, ".bigbud", "owner.json"), JSON.stringify({ pid: process.ppid }));
  if (owner === "dead")
    writeFileSync(path.join(dir, ".bigbud", "owner.json"), JSON.stringify({ pid: deadPid() }));
  return dir;
}

describe("startup temp directory sweep", () => {
  it("removes only stale, verified bigbud directories whose owner is gone", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "sweep-root-"));
    roots.push(root);
    const crashed = mcpBridge(root, "Aa1Bb2", "dead");
    const live = mcpBridge(root, "Cc3Dd4", "live");
    const legacy = mcpBridge(root, "Ee5Ff6", "none");
    const sandbox = path.join(root, "bigbud-v2-exec-Gg7Hh8");
    mkdirSync(sandbox);
    const withoutBridgeFile = path.join(root, "bigbud-orchestration-mcp-notsix");
    mkdirSync(withoutBridgeFile);
    const unrelated = path.join(root, "someone-else-Ii9Jj0");
    mkdirSync(unrelated);
    const target = path.join(root, "target");
    mkdirSync(target);
    const link = path.join(root, "bigbud-v2-exec-Kk1Ll2");
    symlinkSync(target, link);

    // Fresh: nothing is old enough yet.
    expect(await sweepStaleBigbudTempDirs({ tempDir: root })).toEqual([]);

    // Two hours later: the crashed bridge and the sandbox go; the live owner, the marker-less
    // bridge (younger than a week), and anything not matching the exact pattern stay.
    const later = Date.now() + 2 * 60 * 60_000;
    const removed = await sweepStaleBigbudTempDirs({ tempDir: root, nowMs: later });
    expect(removed.toSorted()).toEqual([crashed, sandbox].toSorted());
    for (const kept of [live, legacy, withoutBridgeFile, unrelated, link, target])
      expect(existsSync(kept)).toBe(true);

    // A marker-less bridge from an older version is swept once it is over a week old.
    const weekLater = Date.now() + LEGACY_BRIDGE_MIN_AGE_MS + DAY;
    expect(await sweepStaleBigbudTempDirs({ tempDir: root, nowMs: weekLater })).toEqual([legacy]);
    expect(existsSync(live)).toBe(true);
  });
});
