import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";
import {
  assertLocalTerminalHostCheck,
  collectLocalTerminalHostRuntimes,
  parseLocalAgentCheck,
  stageLocalTerminalHostBinary,
  verifyStagedLocalTerminalHostBinary,
  type LocalAgentCheck,
} from "./localTerminalHost.binary.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";

const target = findWorkspaceAgentTarget(process.platform, process.arch)!;
const check: LocalAgentCheck = {
  version: "0.4.0",
  protocolMajor: 1,
  protocolMinor: 8,
  buildDigest: "digest-a",
  os: target.rustOs,
  architecture: target.rustArch,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(bytes = "#!/bin/sh\necho agent\n") {
  const root = await makeShortTerminalHostRoot();
  cleanups.push(root.cleanup);
  const sourceDir = join(root.stateDir, "app");
  await mkdir(sourceDir);
  const source = join(sourceDir, "bigbud-remote-agent");
  await writeFile(source, bytes);
  await chmod(source, 0o755);
  return { ...root, source };
}

describe("local terminal host binary", () => {
  it("parses --check and accepts any minor on the same major and platform", () => {
    const line = `bigbud-remote-agent\t0.4.0\t1\t9\tdigest-a\t${target.rustOs}\t${target.rustArch}\n`;
    const parsed = parseLocalAgentCheck(line);
    expect(parsed).toMatchObject({ protocolMajor: 1, protocolMinor: 9, buildDigest: "digest-a" });
    expect(assertLocalTerminalHostCheck(parsed, "/x")).toBe(parsed);
    expect(() => assertLocalTerminalHostCheck({ ...check, protocolMajor: 2 }, "/x")).toThrow();
    expect(() => assertLocalTerminalHostCheck({ ...check, os: "plan9" }, "/x")).toThrow();
    expect(parseLocalAgentCheck("something else")).toBeUndefined();
  });

  it("stages a private 0700 copy under runtimes/<digest> and verifies its digest", async () => {
    const { paths, source } = await setup();
    const staged = await stageLocalTerminalHostBinary(paths, { path: source, check }, () => check);
    expect(staged.path).toBe(join(paths.runtimesDir, "digest-a", "bigbud-remote-agent"));
    expect((await lstat(staged.path)).mode & 0o7777).toBe(0o700);
    expect((await lstat(paths.runtimesDir)).mode & 0o777).toBe(0o700);
    await verifyStagedLocalTerminalHostBinary(paths, staged);
    // Same bytes: the existing staged copy is reused without another probe.
    const again = await stageLocalTerminalHostBinary(paths, { path: source, check }, () => {
      throw new Error("must not re-probe");
    });
    expect(again.sha256).toBe(staged.sha256);
  });

  it("refuses a staged copy whose own --check reports another build", async () => {
    const { paths, source } = await setup();
    await expect(
      stageLocalTerminalHostBinary(paths, { path: source, check }, () => ({
        ...check,
        buildDigest: "digest-b",
      })),
    ).rejects.toThrow("failed verification");
    expect(await readdir(join(paths.runtimesDir, "digest-a"))).toEqual([]);
  });

  it("detects a staged binary changed on disk before launch, and re-stages it", async () => {
    const { paths, source } = await setup();
    const staged = await stageLocalTerminalHostBinary(paths, { path: source, check }, () => check);
    await writeFile(staged.path, "tampered");
    await expect(verifyStagedLocalTerminalHostBinary(paths, staged)).rejects.toThrow();
    const restaged = await stageLocalTerminalHostBinary(
      paths,
      { path: source, check },
      () => check,
    );
    await verifyStagedLocalTerminalHostBinary(paths, restaged);
  });

  it("garbage-collects only runtimes no live generation references", async () => {
    const { paths, source } = await setup();
    await stageLocalTerminalHostBinary(paths, { path: source, check }, () => check);
    for (const digest of ["digest-old", "digest-live"]) {
      await mkdir(join(paths.runtimesDir, digest), { mode: 0o700 });
      await writeFile(join(paths.runtimesDir, digest, "bigbud-remote-agent"), "x");
    }
    const removed = await collectLocalTerminalHostRuntimes(paths, ["digest-a", "digest-live"]);
    expect(removed).toEqual(["digest-old"]);
    expect((await readdir(paths.runtimesDir)).toSorted()).toEqual(["digest-a", "digest-live"]);
  });
});
