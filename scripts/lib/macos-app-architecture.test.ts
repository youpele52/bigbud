import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  auditMacApp,
  findArchitectureOffenders,
  findMacAppBundles,
  formatAuditReport,
  machOKind,
  parseAuditArgs,
  parseLipoArchs,
} from "./macos-app-architecture.ts";

const header = (...words: number[]) => {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, false));
  return bytes;
};

describe("machOKind", () => {
  it("recognises thin Mach-O headers in both byte orders", () => {
    expect(machOKind(header(0xcffaedfe, 0x07000001))).toBe("thin");
    expect(machOKind(header(0xfeedfacf, 0x01000007))).toBe("thin");
    expect(machOKind(header(0xcefaedfe, 0))).toBe("thin");
  });

  it("recognises fat binaries and rejects Java class files and short or other files", () => {
    expect(machOKind(header(0xcafebabe, 2))).toBe("fat");
    expect(machOKind(header(0xcafebabf, 1))).toBe("fat");
    // Java class: minor 0, major 61 (Java 17).
    expect(machOKind(header(0xcafebabe, 61))).toBeUndefined();
    expect(machOKind(header(0x7f454c46, 0))).toBeUndefined();
    expect(machOKind(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]))).toBeUndefined();
  });
});

describe("architecture decisions", () => {
  it("parses lipo output", () => {
    expect(parseLipoArchs("x86_64 arm64\n")).toEqual(["x86_64", "arm64"]);
    expect(parseLipoArchs("\n")).toEqual([]);
  });

  it("accepts thin and universal files with the target slice and reports the rest", () => {
    const entries = [
      { path: "/a", archs: ["x86_64"] },
      { path: "/b", archs: ["x86_64", "arm64"] },
      { path: "/c", archs: ["arm64"] },
      { path: "/d", archs: [] },
    ];
    expect(findArchitectureOffenders(entries, "x64").map((entry) => entry.path)).toEqual([
      "/c",
      "/d",
    ]);
    expect(findArchitectureOffenders(entries, "arm64").map((entry) => entry.path)).toEqual([
      "/a",
      "/d",
    ]);
  });

  it("parses the CLI arguments, ignoring a forwarded --", () => {
    expect(parseAuditArgs(["--", "release", "x64"])).toEqual({
      releaseRoot: "release",
      arch: "x64",
    });
    expect(() => parseAuditArgs(["release", "universal"])).toThrow("Usage:");
    expect(() => parseAuditArgs(["release"])).toThrow("Usage:");
  });
});

describe("auditMacApp", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const write = (path: string, bytes: Uint8Array | string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };

  it("audits every Mach-O file, skips symlinks and non-Mach-O files, and names offenders", () => {
    root = mkdtempSync(join(tmpdir(), "macos-app-architecture-"));
    const app = join(root, "mac", "bigbud.app");
    const thin = header(0xcffaedfe, 0x07000001);
    write(join(app, "Contents/MacOS/bigbud"), thin);
    write(join(app, "Contents/Resources/server/_modules/addon.node"), thin);
    write(join(app, "Contents/Resources/server/_modules/darwin-arm64/pty.node"), thin);
    write(join(app, "Contents/Resources/app.asar"), "not a binary at all");
    symlinkSync(join(app, "Contents/MacOS/bigbud"), join(app, "Contents/Resources/bigbud-link"));
    const archs: Record<string, string[]> = {
      [join(app, "Contents/MacOS/bigbud")]: ["x86_64"],
      [join(app, "Contents/Resources/server/_modules/addon.node")]: ["x86_64", "arm64"],
      [join(app, "Contents/Resources/server/_modules/darwin-arm64/pty.node")]: ["arm64"],
    };

    expect(findMacAppBundles(root)).toEqual([app]);
    const result = auditMacApp(app, "x64", (path) => archs[path] ?? []);
    expect(result.audited).toHaveLength(3);
    expect(result.offenders.map((entry) => entry.path)).toEqual([
      join(app, "Contents/Resources/server/_modules/darwin-arm64/pty.node"),
    ]);
    expect(formatAuditReport(result, "x64")).toContain(
      "Contents/Resources/server/_modules/darwin-arm64/pty.node (arm64)",
    );
  });

  it("reports files lipo cannot read and fails when the main executable is missing", () => {
    root = mkdtempSync(join(tmpdir(), "macos-app-architecture-"));
    const app = join(root, "bigbud.app");
    write(join(app, "Contents/MacOS/bigbud"), header(0xcffaedfe, 0x0100000c));
    const unreadable = auditMacApp(app, "arm64", () => {
      throw new Error("lipo failed");
    });
    expect(formatAuditReport(unreadable, "arm64")).toContain("unreadable by lipo");

    const empty = join(root, "empty.app");
    write(join(empty, "Contents/Frameworks/lib.dylib"), header(0xcffaedfe, 0x0100000c));
    expect(() => auditMacApp(empty, "arm64", () => ["arm64"])).toThrow("No Mach-O main executable");
  });
});
