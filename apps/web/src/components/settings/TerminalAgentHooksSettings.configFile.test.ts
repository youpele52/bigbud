import type { NativeApi, ProjectEntry } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createHookConfigFile,
  resolveHookConfigFile,
  splitHomeConfigPath,
} from "./TerminalAgentHooksSettings.configFile";

function fakeApi(listings: Record<string, ProjectEntry[]>) {
  const listDirectory = vi.fn(async (input: { cwd: string; relativePath?: string }) => {
    const entries = listings[input.cwd];
    if (!entries) throw new Error(`missing ${input.cwd}`);
    return { entries };
  });
  const writeFile = vi.fn(async (input: { relativePath: string }) => ({
    relativePath: input.relativePath,
  }));
  return {
    api: { projects: { listDirectory, writeFile } } as unknown as NativeApi,
    listDirectory,
    writeFile,
  };
}

describe("terminal agent hook config files", () => {
  it("splits home-relative config paths and rejects others", () => {
    expect(splitHomeConfigPath("~/.config/opencode/plugin/bigbud-done.js")).toEqual({
      relativeDirectory: ".config/opencode/plugin",
      fileName: "bigbud-done.js",
    });
    expect(splitHomeConfigPath("/etc/settings.json")).toBeNull();
    expect(splitHomeConfigPath("~/settings.json")).toBeNull();
  });

  it("reports an existing file below the server-reported home folder", async () => {
    const { api, listDirectory, writeFile } = fakeApi({
      "/Users/ada/.claude": [{ path: "settings.json", kind: "file" }],
    });
    await expect(
      resolveHookConfigFile(api, "~/.claude/settings.json", "/Users/ada"),
    ).resolves.toEqual({
      status: "exists",
      directory: "/Users/ada/.claude",
      fileName: "settings.json",
    });
    expect(listDirectory).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("reports a missing file or folder with its location, without creating anything", async () => {
    const { api, writeFile } = fakeApi({});
    await expect(
      resolveHookConfigFile(api, "~/.codex/config.toml", "C:\\Users\\ada"),
    ).resolves.toEqual({
      status: "missing",
      directory: "C:\\Users\\ada\\.codex",
      fileName: "config.toml",
    });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("is unavailable when the server reports no home folder", async () => {
    const { api, listDirectory } = fakeApi({});
    await expect(resolveHookConfigFile(api, "~/.claude/settings.json", undefined)).resolves.toEqual(
      { status: "unavailable" },
    );
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("creates a missing file create-only below the home folder", async () => {
    const { api, writeFile } = fakeApi({});
    await expect(
      createHookConfigFile(api, "~/.config/opencode/plugin/bigbud-done.js", "/home/ada", "x\n"),
    ).resolves.toEqual({
      directory: "/home/ada/.config/opencode/plugin",
      fileName: "bigbud-done.js",
    });
    expect(writeFile).toHaveBeenCalledWith({
      cwd: "/home/ada",
      relativePath: ".config/opencode/plugin/bigbud-done.js",
      contents: "x\n",
      createOnly: true,
    });
  });

  it("returns the existing file when it appeared meanwhile, and rethrows other failures", async () => {
    const { api, writeFile } = fakeApi({});
    writeFile.mockRejectedValueOnce(
      Object.assign(new Error("Workspace file already exists."), { alreadyExists: true }),
    );
    await expect(
      createHookConfigFile(api, "~/.claude/settings.json", "/Users/ada", "{}\n"),
    ).resolves.toEqual({ directory: "/Users/ada/.claude", fileName: "settings.json" });

    writeFile.mockRejectedValueOnce(new Error("Failed to write workspace file"));
    await expect(
      createHookConfigFile(api, "~/.claude/settings.json", "/Users/ada", "{}\n"),
    ).rejects.toThrow("Failed to write workspace file");
  });
});
