import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSupportedRemoteCodexCliVersionAsync,
  startRemoteCodexAppServerProcess,
  startRemoteCodexAppServerProcessAsync,
} from "./codexAppServerManager.process.remote.ts";
import { readCodexProcessVersion } from "./codexAppServerManager.process.version.ts";

const directory = mkdtempSync(join(tmpdir(), "bigbud-fake-remote-codex-"));
const argsFile = join(directory, "args.txt");
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** Installs a fake `ssh` that records its argv and then runs `body`. */
function installFakeSsh(body: string): void {
  writeFileSync(join(directory, "ssh"), `#!/bin/sh\necho "$@" > "${argsFile}"\n${body}\n`);
  chmodSync(join(directory, "ssh"), 0o755);
}

const input = (host: string) => ({
  threadId: ThreadId.makeUnsafe("thread-remote"),
  provider: "codex" as const,
  executionTargetId: `ssh:host=${host}&user=root&port=22&auth=ssh-key`,
  cwd: "/root/project",
  runtimeMode: "full-access" as const,
  binaryPath: "codex",
});

describe.skipIf(process.platform === "win32")("assertSupportedRemoteCodexCliVersionAsync", () => {
  let originalPath: string | undefined;
  beforeEach(() => {
    originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
  });
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("checks the remote version over ssh with an explicit ConnectTimeout", async () => {
    installFakeSsh('echo "codex-cli 9.0.0"');
    await assertSupportedRemoteCodexCliVersionAsync(input("198.51.100.1"));
    expect(readFileSync(argsFile, "utf8")).toMatch(/ConnectTimeout=10/);
  });

  it("refuses the removed synchronous remote launcher without spawning ssh", () => {
    rmSync(argsFile, { force: true });
    installFakeSsh('echo "codex-cli 0.167.0"');
    expect(() => startRemoteCodexAppServerProcess(input("198.51.100.1"))).toThrow(/asynchronous/);
    expect(existsSync(argsFile)).toBe(false);
  });

  it("launches the legacy app-server with pipes and the version-conditioned config", async () => {
    installFakeSsh(`case "$*" in
      *--version*) echo "codex-cli 0.167.0" ;;
      *) printf "ready\\n" ;;
    esac`);
    const child = await startRemoteCodexAppServerProcessAsync({
      ...input("198.51.100.1"),
      configArgs: ["-c", "feature=true"],
    });
    const closed = once(child, "close");
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdin.end();
    expect(await closed).toEqual([0, null]);
    expect(Buffer.concat(chunks).toString()).toBe("ready\n");
    expect(readCodexProcessVersion(child)).toBe("0.167.0");
    expect(readFileSync(argsFile, "utf8")).toContain(
      "'app-server' '-c' 'feature=true' '-c' 'features.default_mode_request_user_input=true'",
    );
  });

  it("does not launch a legacy app-server after a cancelled start", async () => {
    installFakeSsh('echo "codex-cli 0.167.0"');
    const reason = new Error("cancelled start");
    await expect(
      startRemoteCodexAppServerProcessAsync(input("198.51.100.1"), AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(readFileSync(argsFile, "utf8")).toContain("'--version'");
  });

  it("fails at its deadline against an unreachable host while the event loop stays free", async () => {
    installFakeSsh("exec sleep 120");
    let last = performance.now();
    let maxGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 10);
    const startedAt = performance.now();
    try {
      await expect(assertSupportedRemoteCodexCliVersionAsync(input("192.0.2.1"))).rejects.toThrow(
        /version check timed out/,
      );
    } finally {
      clearInterval(timer);
    }
    expect(performance.now() - startedAt).toBeLessThan(22_000);
    expect(maxGapMs).toBeLessThan(250);
  }, 40_000);
});
