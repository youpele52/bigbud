import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { resolveLocalWorkspaceWatchAgentBinary } from "../../remote-agent/localWorkspaceWatchAgent.binary.ts";
import { makeDirectResourceCleanupExecutor } from "./DirectResourceCleanupExecutor.ts";

const BINARY_RESOLVED = "binary resolution reached";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function prepareFailure(host: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  const executor = makeDirectResourceCleanupExecutor(() => {
    throw new Error(BINARY_RESOLVED);
  }, host);
  return Effect.runPromise(Effect.flip(executor.prepare()));
}

describe("DirectResourceCleanupExecutor platform support", () => {
  it.each([
    ["linux", "arm64"],
    ["linux", "x64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ] as const)("admits %s/%s to binary resolution", async (platform, arch) => {
    const error = await prepareFailure({ platform, arch });
    expect(error.detail).toBe(`Error: ${BINARY_RESOLVED}`);
  });

  it("names the unsupported host in the error detail and message", async () => {
    const error = await prepareFailure({ platform: "linux", arch: "ia32" });
    expect(error.detail).toContain("Resource cleanup is unsupported on linux/ia32.");
    expect(error.message).toBe(error.detail);
    expect(String(error)).toContain("unsupported on linux/ia32");
  });

  it("resolves a pinned linux/arm64 agent such as the remote service's Rust agent", () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-cleanup-arm64-"));
    temporaryDirectories.push(root);
    const agent = join(root, "bigbud-remote-agent");
    writeFileSync(agent, "#!/bin/sh\n");
    chmodSync(agent, 0o700);
    const verified: string[] = [];

    const resolved = resolveLocalWorkspaceWatchAgentBinary({
      environment: { BIGBUD_DESKTOP_PACKAGED: "1" },
      platform: "linux",
      architecture: "arm64",
      packagedBinaryPath: agent,
      packageRoot: root,
      searchFrom: [root],
      verifyBinary: (path, platform, architecture) => {
        verified.push(`${path} ${platform}/${architecture}`);
      },
    });

    expect(resolved).toBe(agent);
    expect(verified).toEqual([`${agent} linux/arm64`]);
  });
});
