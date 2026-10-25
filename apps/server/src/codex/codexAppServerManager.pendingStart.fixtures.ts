import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

/** Minimal app-server: answers `--version` and every JSON-RPC request with a canned result. */
const FAKE_CODEX_SOURCE = (version: string) => `
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli ${version}");
  process.exit(0);
}
const results = {
  "model/list": { data: [] },
  "account/read": { account: { type: "chatgpt", planType: "pro" } },
  "thread/start": { thread: { id: "provider-thread" } },
};
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = results[message.method] ?? {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  });
setInterval(() => {}, 60_000);
`;

export interface FakeCodexBinaries {
  readonly directory: string;
  /** Absolute path of a fake local `codex` binary. */
  readonly localCodexPath: (version?: string) => string;
  /** Installs a fake `ssh` whose remote `codex --version` takes `versionDelaySeconds`. */
  readonly installFakeSsh: (versionDelaySeconds: number) => void;
  /** True once the fake `ssh` has been asked to run the remote app-server. */
  readonly remoteAppServerSpawned: () => boolean;
  readonly cleanup: () => void;
}

export function createFakeCodexBinaries(): FakeCodexBinaries {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-fake-codex-start-"));
  const marker = join(directory, "remote-app-server-spawned");
  let localCount = 0;

  const localCodexPath = (version = "9.0.0") => {
    localCount += 1;
    const scriptPath = join(directory, `codex-local-${localCount}`);
    writeFileSync(scriptPath, `#!${process.execPath}\n${FAKE_CODEX_SOURCE(version)}`);
    chmodSync(scriptPath, 0o755);
    return scriptPath;
  };
  const remoteCodexPath = localCodexPath();

  return {
    directory,
    localCodexPath,
    installFakeSsh: (versionDelaySeconds) => {
      writeFileSync(
        join(directory, "ssh"),
        [
          "#!/bin/sh",
          'case "$*" in',
          `  *--version*) sleep ${versionDelaySeconds}; echo "codex-cli 9.0.0" ;;`,
          `  *app-server*) echo spawned >> "${marker}"; exec "${remoteCodexPath}" app-server ;;`,
          "esac",
          "",
        ].join("\n"),
      );
      chmodSync(join(directory, "ssh"), 0o755);
      rmSync(marker, { force: true });
    },
    remoteAppServerSpawned: () => existsSync(marker),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

let remoteHostCount = 0;

/** Each call uses a new host, so the remote version-check cache never short-circuits a test. */
export function remoteStartInput(threadId: string): CodexAppServerStartSessionInput {
  remoteHostCount += 1;
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    provider: "codex",
    executionTargetId: `ssh:host=198.51.100.${remoteHostCount}&user=root&port=22&auth=ssh-key`,
    cwd: "/root/project",
    runtimeMode: "full-access",
    binaryPath: "codex",
  };
}

export function localStartInput(
  threadId: string,
  binaryPath: string,
  cwd: string,
): CodexAppServerStartSessionInput {
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    provider: "codex",
    cwd,
    runtimeMode: "full-access",
    binaryPath,
  };
}

/** Records the longest gap between 10 ms ticks, i.e. the worst event-loop stall. */
export function watchEventLoop(): { readonly stop: () => number } {
  let last = performance.now();
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 10);
  return {
    stop: () => {
      clearInterval(timer);
      return maxGapMs;
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
