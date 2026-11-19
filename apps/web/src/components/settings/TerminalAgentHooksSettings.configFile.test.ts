import type { NativeApi, ProjectEntry } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  inferHomeCandidates,
  resolveHookConfigFile,
  resolveServerHome,
  splitHomeConfigPath,
} from "./TerminalAgentHooksSettings.configFile";

const HOME_ENTRIES: ProjectEntry[] = [
  { path: ".claude", kind: "directory" },
  { path: "notes.txt", kind: "file" },
];

function fakeApi(listings: Record<string, ProjectEntry[]>) {
  const listDirectory = vi.fn(async (input: { cwd: string; relativePath?: string }) => {
    const entries = listings[input.cwd];
    if (!entries) throw new Error(`missing ${input.cwd}`);
    return { entries };
  });
  const writeFile = vi.fn();
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

  it("infers distinct home candidates from server paths", () => {
    expect(
      inferHomeCandidates([
        "/Users/ada/DevWorld/bigbud",
        "/Users/ada/Documents",
        "/home/ada/.bigbud/keybindings.json",
        null,
        "/opt/bigbud",
      ]),
    ).toEqual(["/Users/ada", "/home/ada"]);
  });

  it("accepts only a candidate whose listing matches the server's ~ listing", async () => {
    const { api } = fakeApi({
      "~": HOME_ENTRIES,
      "/Users/other": [{ path: "elsewhere", kind: "directory" }],
      "/Users/ada": [...HOME_ENTRIES].toReversed(),
    });
    await expect(resolveServerHome(api, ["/Users/other", "/Users/ada"])).resolves.toBe(
      "/Users/ada",
    );
    await expect(resolveServerHome(api, ["/Users/other"])).resolves.toBeNull();
  });

  it("reports an existing file with its absolute folder", async () => {
    const { api, writeFile } = fakeApi({
      "~": HOME_ENTRIES,
      "/Users/ada": HOME_ENTRIES,
      "/Users/ada/.claude": [{ path: "settings.json", kind: "file" }],
    });
    await expect(
      resolveHookConfigFile(api, "~/.claude/settings.json", ["/Users/ada"]),
    ).resolves.toEqual({
      status: "exists",
      directory: "/Users/ada/.claude",
      fileName: "settings.json",
    });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("reports a missing file or folder without creating anything", async () => {
    const { api, writeFile } = fakeApi({ "~": HOME_ENTRIES, "/Users/ada": HOME_ENTRIES });
    await expect(
      resolveHookConfigFile(api, "~/.codex/config.toml", ["/Users/ada"]),
    ).resolves.toEqual({ status: "missing" });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("is unavailable when the home folder cannot be confirmed", async () => {
    const { api } = fakeApi({ "~": HOME_ENTRIES });
    await expect(resolveHookConfigFile(api, "~/.claude/settings.json", [])).resolves.toEqual({
      status: "unavailable",
    });
  });
});
