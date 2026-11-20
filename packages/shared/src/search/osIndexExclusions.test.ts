import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { inspectSystemOpenPath } from "../systemOpenPath";
import { exclusionGlobMatches, isOsIndexExcludedPath } from "./osIndexExclusions";

const HOME = "/Users/me";

describe("isOsIndexExcludedPath", () => {
  it("excludes the plan's sensitive folders and file names, ignoring ASCII case", () => {
    for (const excluded of [
      "/Users/me/.ssh/config",
      "/Users/me/Library/Keychains/login.keychain-db",
      "/Users/me/Library/Application Support/Google/Chrome Beta/Default/History",
      "/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/data.sqlite",
      "/Users/me/.bigbud/state/db.sqlite",
      "/Users/me/Documents/.env.local",
      "/Users/me/Documents/server.PEM",
      "/Users/me/Downloads/id_ed25519",
      "/Users/me/Documents/Secrets/notes.txt",
      "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Credentials\\blob",
      "/home/me/.config/google-chrome/Default/Login Data",
    ]) {
      expect(isOsIndexExcludedPath(excluded, HOME), excluded).toBe(true);
    }
  });

  it("keeps ordinary documents and never lets a user or volume name hide everything", () => {
    for (const allowed of [
      "/Users/me/Documents/invoice.pdf",
      "/Users/me/Projects/keynote-deck.key.md",
      "/Users/id_admin/Documents/report.pdf",
      "/Volumes/secrets-backup/photos/a.jpg",
    ]) {
      const home = allowed.startsWith("/Users/id_admin") ? "/Users/id_admin" : HOME;
      expect(isOsIndexExcludedPath(allowed, home), allowed).toBe(false);
    }
  });

  it("matches the agent's star-only glob semantics", () => {
    expect(exclusionGlobMatches("*.pem", "a.PEM")).toBe(true);
    expect(exclusionGlobMatches(".env*", ".env")).toBe(true);
    expect(exclusionGlobMatches("Chrome*", "chromium")).toBe(false);
    expect(exclusionGlobMatches("*.com.1password*", "2BUA8C4S2C.com.1password")).toBe(true);
    expect(exclusionGlobMatches("a*b*c", "aXbYbZc")).toBe(true);
    expect(exclusionGlobMatches("a*b", "acbd")).toBe(false);
  });
});

describe("inspectSystemOpenPath exclusions", () => {
  it("refuses excluded paths, including names below the home folder", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-exclusions-"));
    try {
      fs.writeFileSync(path.join(home, ".env"), "TOKEN=1");
      fs.mkdirSync(path.join(home, "secrets"));
      fs.writeFileSync(path.join(home, "secrets", "notes.txt"), "x");
      fs.writeFileSync(path.join(home, "notes.txt"), "x");
      const inspect = (name: string) =>
        inspectSystemOpenPath(path.join(home, name), process.platform, { home });
      expect(await inspect(".env")).toEqual({ ok: false, reason: "inaccessible" });
      expect(await inspect("secrets/notes.txt")).toEqual({ ok: false, reason: "inaccessible" });
      expect(await inspect("notes.txt")).toMatchObject({ ok: true, kind: "file" });
      // A symlink with an innocent name cannot smuggle an excluded target out.
      fs.symlinkSync(path.join(home, ".env"), path.join(home, "harmless.txt"));
      expect(await inspect("harmless.txt")).toEqual({ ok: false, reason: "inaccessible" });
      // Excluded requests are refused before any file-system call: a missing `.ssh` file is
      // reported as inaccessible, never as not found.
      expect(await inspect(".ssh/id_ed25519")).toEqual({ ok: false, reason: "inaccessible" });
      expect(await inspect("missing.txt")).toEqual({ ok: false, reason: "not-found" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
