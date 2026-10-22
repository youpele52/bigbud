import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProcessRunResult } from "../utils/processRunner.ts";
import {
  LIST_FOLDERS_SCRIPT,
  listRemoteFolders,
  parseRemoteFoldersOutput,
  REMOTE_FOLDERS_MAX_ENTRIES,
} from "./sshRemoteFolders.ts";
import type { RunSshCommandInput } from "./sshProcess.ts";

function runResult(overrides: Partial<ProcessRunResult>): ProcessRunResult {
  return { stdout: "", stderr: "", code: 0, signal: null, timedOut: false, ...overrides };
}

const MARKER = "BIGBUD_REMOTE_FOLDERS_V1\0";

describe("parseRemoteFoldersOutput", () => {
  it("skips login-shell banners, sorts folders, and marks git checkouts", () => {
    const stdout = `Welcome to the box!\n${MARKER}/home/dev\0/home/dev\0d\tzeta\0g\tApi\0d\talpha\0`;

    expect(parseRemoteFoldersOutput(stdout)).toEqual({
      path: "/home/dev",
      homePath: "/home/dev",
      folders: [
        { name: "alpha", isGitRepo: false },
        { name: "Api", isGitRepo: true },
        { name: "zeta", isGitRepo: false },
      ],
      truncated: false,
    });
  });

  it("drops a partial last record when the output was cut off", () => {
    const stdout = `${MARKER}/home/dev\0/srv\0d\tone\0d\ttw`;
    const result = parseRemoteFoldersOutput(stdout, true);

    expect(result.folders.map((folder) => folder.name)).toEqual(["one"]);
    expect(result.truncated).toBe(true);
  });

  it("caps the folder count", () => {
    const records = Array.from({ length: REMOTE_FOLDERS_MAX_ENTRIES + 3 }, (_, index) => {
      return `d\tf${String(index).padStart(5, "0")}\0`;
    }).join("");
    const result = parseRemoteFoldersOutput(`${MARKER}/h\0/h\0${records}`);

    expect(result.folders).toHaveLength(REMOTE_FOLDERS_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it("rejects output without the marker", () => {
    expect(() => parseRemoteFoldersOutput("Permission denied")).toThrow(/unexpected/u);
  });
});

describe("listRemoteFolders", () => {
  it("runs one read-only sh script over SSH with the requested path", async () => {
    const run = vi.fn(async (_input: RunSshCommandInput) =>
      runResult({ stdout: `${MARKER}/home/dev\0/srv/app\0` }),
    );

    const result = await listRemoteFolders(
      { executionTargetId: "ssh:host=box&auth=ssh-key&transport=agent", path: "/srv/app" },
      run,
    );

    expect(result.path).toBe("/srv/app");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: "ssh:host=box&auth=ssh-key&transport=agent",
        command: "sh",
        args: ["-c", LIST_FOLDERS_SCRIPT, "sh", "/srv/app"],
      }),
    );
  });

  it("reports a folder that cannot be opened", async () => {
    const run = vi.fn(async () => runResult({ code: 3 }));

    await expect(
      listRemoteFolders({ executionTargetId: "ssh:box", path: "/missing" }, run),
    ).rejects.toThrow("Folder not found or not accessible: /missing");
  });
});

describe.skipIf(process.platform === "win32")("LIST_FOLDERS_SCRIPT", () => {
  let home: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-remote-folders-")));
    fs.mkdirSync(path.join(home, "repo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(home, "with space", "nested"), { recursive: true });
    fs.mkdirSync(path.join(home, ".hidden"));
    fs.writeFileSync(path.join(home, "file.txt"), "x");
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runScript(target: string) {
    const result = spawnSync("sh", ["-c", LIST_FOLDERS_SCRIPT, "sh", target], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout };
  }

  it("lists home by default, skipping files and hidden folders", () => {
    const { code, stdout } = runScript("");

    expect(code).toBe(0);
    expect(parseRemoteFoldersOutput(stdout)).toEqual({
      path: home,
      homePath: home,
      folders: [
        { name: "repo", isGitRepo: true },
        { name: "with space", isGitRepo: false },
      ],
      truncated: false,
    });
  });

  it("resolves ~/ paths and exits 3 for a missing folder", () => {
    expect(parseRemoteFoldersOutput(runScript("~/with space").stdout).folders).toEqual([
      { name: "nested", isGitRepo: false },
    ]);
    expect(runScript(path.join(home, "missing")).code).toBe(3);
  });
});
