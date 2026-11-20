import { describe, expect, it } from "vitest";

import { probeFileAccess, type FileAccessProbeEntry } from "./ipcHandlers.fileAccess";

const HOME = "/Users/me";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function folder(name: string): FileAccessProbeEntry {
  return { name, isDirectory: () => true };
}

function file(name: string): FileAccessProbeEntry {
  return { name, isDirectory: () => false };
}

/** A fake file system: listed folders open, `denied` ones refuse (a declined prompt). */
function fakeFolders(
  listings: Record<string, ReadonlyArray<FileAccessProbeEntry>>,
  denied: ReadonlyArray<string> = [],
) {
  const read: string[] = [];
  const readFolder = async (path: string) => {
    read.push(path);
    if (denied.includes(path)) throw errno("EPERM");
    const entries = listings[path];
    if (!entries) throw errno("ENOENT");
    return entries;
  };
  return { read, readFolder };
}

describe("probeFileAccess", () => {
  it("opens exactly the common folders search reads, ignoring missing ones", async () => {
    const fs = fakeFolders({
      [`${HOME}/Desktop`]: [],
      [`${HOME}/Documents`]: [],
      [`${HOME}/Music`]: [],
      [`${HOME}/Pictures`]: [],
    });
    const result = await probeFileAccess("common-folders", {
      home: HOME,
      platform: "darwin",
      ...fs,
    });
    expect(fs.read).toEqual(
      ["Desktop", "Documents", "Downloads", "Music", "Pictures"].map((name) => `${HOME}/${name}`),
    );
    expect(result).toEqual({
      success: true,
      granted: ["Desktop", "Documents", "Music", "Pictures"].map((name) => `${HOME}/${name}`),
      denied: [],
    });
  });

  it("opens home folders, iCloud Drive and each File Provider at unrestricted on macOS", async () => {
    const fs = fakeFolders(
      {
        "/": [],
        "/Users": [],
        [HOME]: [
          folder("Projects"),
          folder("Library"),
          folder(".ssh"),
          folder("secrets"),
          file("notes.txt"),
        ],
        [`${HOME}/Documents`]: [],
        [`${HOME}/Projects`]: [],
        [`${HOME}/Library/Mobile Documents`]: [folder("com~apple~CloudDocs")],
        [`${HOME}/Library/Mobile Documents/com~apple~CloudDocs`]: [],
        [`${HOME}/Library/CloudStorage`]: [folder("Dropbox"), folder("GoogleDrive-me")],
        [`${HOME}/Library/CloudStorage/Dropbox`]: [],
      },
      // "Don't Allow" for Google Drive: recorded, never a failure.
      [`${HOME}/Library/CloudStorage/GoogleDrive-me`],
    );
    const result = await probeFileAccess("unrestricted", { home: HOME, platform: "darwin", ...fs });
    expect(fs.read).toContain(`${HOME}/Library/Mobile Documents`);
    expect(fs.read).toContain(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs`);
    expect(fs.read).toContain(`${HOME}/Library/CloudStorage/Dropbox`);
    expect(fs.read).toContain(`${HOME}/Downloads`);
    // The noise folder, hidden folders and excluded folders are never opened.
    expect(fs.read).not.toContain(`${HOME}/Library`);
    expect(fs.read).not.toContain(`${HOME}/.ssh`);
    expect(fs.read).not.toContain(`${HOME}/secrets`);
    expect(new Set(fs.read).size).toBe(fs.read.length);
    expect(result.success).toBe(true);
    expect(result.denied).toEqual([`${HOME}/Library/CloudStorage/GoogleDrive-me`]);
    expect(result.granted).toContain(`${HOME}/Projects`);
  });

  it("skips the macOS cloud folders elsewhere and opens nothing for other levels", async () => {
    const linux = fakeFolders({ "/": [], "/home/me": [folder("Library")] });
    await probeFileAccess("unrestricted", { home: "/home/me", platform: "linux", ...linux });
    expect(linux.read.some((path) => path.includes("CloudStorage"))).toBe(false);
    expect(linux.read).toContain("/home/me/Library");

    const none = fakeFolders({});
    expect(await probeFileAccess("none", { home: HOME, platform: "darwin", ...none })).toEqual({
      success: false,
      granted: [],
      denied: [],
    });
    expect(none.read).toEqual([]);
  });

  it("reports a fully declined probe without throwing", async () => {
    const fs = fakeFolders({}, [`${HOME}/Desktop`, `${HOME}/Documents`]);
    const result = await probeFileAccess("common-folders", {
      home: HOME,
      platform: "darwin",
      ...fs,
    });
    expect(result).toEqual({
      success: false,
      granted: [],
      denied: [`${HOME}/Desktop`, `${HOME}/Documents`],
    });
  });
});
