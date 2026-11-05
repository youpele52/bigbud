import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cliProxyVersionMetadata,
  isHomebrewCliProxyPath,
  makeCliProxyInstallationInspector,
  stableCliProxyVersion,
} from "./Version.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("CLIProxyAPI version evidence", () => {
  it.each([
    ["8.0.30", null, "runtime"],
    ["8.0.51", "8.0.30", undefined],
    ["8.0.100", "8.0.30", undefined],
    ["9.0.0", "8.0.30", undefined],
    ["7.99.100", "8.0.51", "runtime"],
    [null, "8.0.30", "installed"],
    [null, "8.0.51", undefined],
    [null, "8.1.0", undefined],
    [null, null, undefined],
    ["8.0.51-dev", "8.0.30", undefined],
    ["dev", "8.0.30", undefined],
  ] as const)("compares runtime %s against installed %s honestly", (runtime, installed, source) => {
    expect(
      cliProxyVersionMetadata(runtime, { version: installed, installation: "unknown" }),
    ).toMatchObject({
      recommendedVersion: "8.0.51",
      runtimeVersion: runtime,
      installedVersion: installed,
    });
    expect(
      cliProxyVersionMetadata(runtime, { version: installed, installation: "unknown" })
        .updateSource,
    ).toBe(source);
  });

  it.each([
    "dev",
    "8.0.51-rc1",
    "8.0.51+dev",
    "Version: 8.0.30",
    "08.0.30",
    "8.0",
    "999999999999999999.0.0",
  ])("does not qualify %s as a stable release", (value) =>
    expect(stableCliProxyVersion(value)).toBeNull(),
  );

  it("accepts only exact stable version strings and canonical Homebrew formula paths", () => {
    expect(stableCliProxyVersion(" v8.0.51 ")).toBe("8.0.51");
    expect(isHomebrewCliProxyPath("/opt/homebrew/Cellar/cliproxyapi/8.0.30/bin/cliproxyapi")).toBe(
      true,
    );
    expect(isHomebrewCliProxyPath("/usr/local/Cellar/cliproxyapi/8.0.30/bin/cliproxyapi")).toBe(
      true,
    );
    expect(isHomebrewCliProxyPath("/opt/homebrew/bin/cliproxyapi")).toBe(false);
    expect(isHomebrewCliProxyPath("/usr/local/bin/cliproxyapi")).toBe(false);
  });
});

describe("installed binary inspection", () => {
  async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bigbud-cliproxy-version-"));
    directories.push(directory);
    const binary = path.join(directory, "cliproxyapi");
    await writeFile(binary, "fixture");
    return binary;
  }
  const output = {
    code: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "CLIProxyAPI Version: 8.0.30, Commit: Homebrew, BuiltAt: today\nUsage",
  };

  it("uses bounded --help only, coalesces calls and invalidates on binary changes", async () => {
    const binary = await fixture();
    const run = vi.fn().mockResolvedValue(output);
    const inspect = makeCliProxyInstallationInspector({ resolve: () => binary, run });
    await expect(Promise.all([inspect(), inspect()])).resolves.toEqual([
      { version: "8.0.30", installation: "unknown" },
      { version: "8.0.30", installation: "unknown" },
    ]);
    await inspect();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(binary, ["--help"], {
      timeoutMs: 2_000,
      settleOnTimeout: true,
      maxBufferBytes: 4_000,
      outputMode: "truncate",
      allowNonZeroExit: true,
      shell: false,
    });
    await writeFile(binary, "replacement binary with different size");
    run.mockResolvedValue({ ...output, stderr: "CLIProxyAPI Version: 8.0.51, Commit: release" });
    await expect(inspect()).resolves.toMatchObject({ version: "8.0.51" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns unknown without executing anything when neither executable is on PATH", async () => {
    const resolve = vi.fn().mockReturnValue(null);
    const run = vi.fn();
    await expect(makeCliProxyInstallationInspector({ resolve, run })()).resolves.toEqual({
      version: null,
      installation: "unknown",
    });
    expect(resolve.mock.calls.map((args) => args[0])).toEqual(["cliproxyapi", "cli-proxy-api"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("treats process failure, timeout, malformed or development output as unknown", async () => {
    const binary = await fixture();
    for (const result of [
      { ...output, timedOut: true },
      { ...output, code: 1 },
      { ...output, stderr: "unrelated version 8.0.30" },
      { ...output, stderr: "CLIProxyAPI Version: dev, Commit: unknown" },
    ]) {
      await expect(
        makeCliProxyInstallationInspector({
          resolve: () => binary,
          run: vi.fn().mockResolvedValue(result),
        })(),
      ).resolves.toMatchObject({ version: null });
    }
    await expect(
      makeCliProxyInstallationInspector({
        resolve: () => binary,
        run: vi.fn().mockRejectedValue(new Error("failure")),
      })(),
    ).resolves.toEqual({ version: null, installation: "unknown" });
  });
});
