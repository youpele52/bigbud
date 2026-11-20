import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inspectSystemOpenPath, normalizeSystemOpenPath } from "./systemOpenPath";
import {
  hasExecutableMagic,
  hasLaunchableDirectoryExtension,
  hasLaunchableFileExtension,
  lastPathExtension,
} from "./systemOpenPath.launchable";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("normalizeSystemOpenPath", () => {
  it("refuses non-strings, empty, relative, NUL and over-long input", () => {
    for (const raw of [
      undefined,
      42,
      "",
      "a.txt",
      "./a",
      "../a",
      "~/a",
      "/a\0b",
      "/".repeat(5000),
    ]) {
      expect(normalizeSystemOpenPath(raw, "darwin"), String(raw).slice(0, 20)).toBeNull();
    }
  });

  it("normalises traversal and refuses Windows-style paths on POSIX", () => {
    expect(normalizeSystemOpenPath("/a/b/../c//d", "linux")).toBe("/a/c/d");
    expect(normalizeSystemOpenPath("C:\\a.txt", "darwin")).toBeNull();
    expect(normalizeSystemOpenPath("\\\\server\\share\\a", "linux")).toBeNull();
  });

  it("accepts drive paths on Windows and refuses UNC, device and drive-relative paths", () => {
    expect(normalizeSystemOpenPath("C:/a/../b.txt", "win32")).toBe("C:\\b.txt");
    for (const raw of [
      "\\\\server\\share\\a",
      "\\\\?\\C:\\a",
      "\\\\.\\PhysicalDrive0",
      "/a",
      "//h/s",
    ]) {
      expect(normalizeSystemOpenPath(raw, "win32"), raw).toBeNull();
    }
  });
});

describe("launchable classification", () => {
  it("matches launchable extensions case-insensitively on the last component", () => {
    for (const name of ["/x/A.APP", "/x/run.sh", "C:\\x\\setup.exe", "/x/i.AppImage", "/x/a.ps1"]) {
      expect(hasLaunchableFileExtension(name), name).toBe(true);
    }
    for (const name of ["/x/notes.md", "/x/report.docx", "/x/.sh", "/x/sh", "/x.app/readme.txt"]) {
      expect(hasLaunchableFileExtension(name), name).toBe(false);
    }
    expect(hasLaunchableDirectoryExtension("/Applications/Safari.app/")).toBe(true);
    expect(hasLaunchableDirectoryExtension("/Users/me/Documents")).toBe(false);
    expect(lastPathExtension("/a.b/c")).toBe("");
  });

  it("recognises ELF, Mach-O, PE and shebang headers only", () => {
    for (const header of [
      bytes(0x7f, 0x45, 0x4c, 0x46),
      bytes(0xcf, 0xfa, 0xed, 0xfe),
      bytes(0xfe, 0xed, 0xfa, 0xce),
      bytes(0xca, 0xfe, 0xba, 0xbe),
      bytes(0x4d, 0x5a),
      bytes(0x23, 0x21, 0x2f),
    ]) {
      expect(hasExecutableMagic(header)).toBe(true);
    }
    for (const header of [bytes(), bytes(0x25, 0x50, 0x44, 0x46), bytes(0x7f, 0x45, 0x4c)]) {
      expect(hasExecutableMagic(header)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === "win32")("inspectSystemOpenPath (POSIX)", () => {
  let dir: string;
  const write = (name: string, contents: string | Uint8Array, mode = 0o644) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, contents, { mode });
    fs.chmodSync(target, mode);
    return target;
  };

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-system-open-")));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("accepts a plain document as a non-launchable file", async () => {
    const target = write("notes.txt", "hello");
    await expect(inspectSystemOpenPath(target)).resolves.toEqual({
      ok: true,
      realPath: target,
      kind: "file",
      launchable: false,
    });
  });

  it("refuses relative and missing paths", async () => {
    await expect(inspectSystemOpenPath("notes.txt")).resolves.toEqual({
      ok: false,
      reason: "invalid-path",
    });
    await expect(inspectSystemOpenPath(path.join(dir, "missing.txt"))).resolves.toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("marks extension, execute-bit and magic-header executables as launchable", async () => {
    const cases = [
      write("run.sh", "echo hi"),
      write("tool", "plain text", 0o755),
      write("binary.dat", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0])),
      write("script.txt", "#!/bin/sh\necho hi"),
    ];
    for (const target of cases) {
      const result = await inspectSystemOpenPath(target);
      expect(result, target).toMatchObject({ ok: true, launchable: true });
    }
  });

  it("resolves symlinks and judges both names", async () => {
    const real = write("real.sh", "echo hi");
    const link = path.join(dir, "innocent.txt");
    fs.symlinkSync(real, link);
    await expect(inspectSystemOpenPath(link)).resolves.toEqual({
      ok: true,
      realPath: real,
      kind: "file",
      launchable: true,
    });
    const plain = write("plain.txt", "hello");
    const scriptLink = path.join(dir, "launcher.command");
    fs.symlinkSync(plain, scriptLink);
    await expect(inspectSystemOpenPath(scriptLink)).resolves.toMatchObject({
      realPath: plain,
      launchable: true,
    });
  });

  it("treats bundles as launchable directories and plain folders as openable", async () => {
    const bundle = path.join(dir, "Thing.app");
    fs.mkdirSync(bundle);
    await expect(inspectSystemOpenPath(bundle)).resolves.toMatchObject({
      kind: "directory",
      launchable: true,
    });
    await expect(inspectSystemOpenPath(dir)).resolves.toMatchObject({
      kind: "directory",
      launchable: false,
    });
  });
});
