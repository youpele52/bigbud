import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UnixSocketPathTooLongError,
  assertUnixSocketPathFits,
  createPrivateSocketDirectory,
  privateSocketRootPath,
  privateSocketScopeTag,
  unixSocketPathMaxBytes,
} from "./privateSocketPath";

const BETA_LOG_PATH =
  "/Users/youpele/.bigbud/channels/beta/runtime/cua-driver/run/bb35e159-b7de-40f3-92f0-ec2579eddce0/cua.sock";

describe("unix socket path limits", () => {
  it("uses sun_path minus the NUL terminator per platform", () => {
    expect(unixSocketPathMaxBytes("darwin")).toBe(103);
    expect(unixSocketPathMaxBytes("freebsd")).toBe(103);
    expect(unixSocketPathMaxBytes("linux")).toBe(107);
  });

  it("rejects the beta-channel path that failed to bind with a clear error", () => {
    expect(() => assertUnixSocketPathFits(BETA_LOG_PATH, "darwin")).toThrow(
      UnixSocketPathTooLongError,
    );
    expect(() => assertUnixSocketPathFits(BETA_LOG_PATH, "darwin")).toThrow(
      /is 10\d bytes but darwin allows at most 103/,
    );
    expect(assertUnixSocketPathFits("/tmp/bigbud-501/cua.sock", "darwin")).toBe(
      "/tmp/bigbud-501/cua.sock",
    );
  });

  it("counts bytes, not UTF-16 code units", () => {
    const path = `/tmp/${"é".repeat(50)}.sock`;
    expect(path.length).toBeLessThanOrEqual(103);
    expect(() => assertUnixSocketPathFits(path, "darwin")).toThrow(UnixSocketPathTooLongError);
  });
});

describe("privateSocketScopeTag", () => {
  it("is short, stable and distinct per base dir", () => {
    const stable = privateSocketScopeTag("/Users/a/.bigbud");
    expect(stable).toMatch(/^[0-9a-f]{12}$/);
    expect(privateSocketScopeTag("/Users/a/.bigbud/")).toBe(stable);
    expect(privateSocketScopeTag("/Users/a/.bigbud/channels/beta")).not.toBe(stable);
    expect(privateSocketScopeTag("/Users/a/.bigbud/dev")).not.toBe(stable);
  });
});

describe.skipIf(OS.platform() === "win32")("createPrivateSocketDirectory", () => {
  const roots: string[] = [];
  const uid = process.getuid!();
  function tmpRoot(): string {
    const directory = FS.mkdtempSync(Path.join("/tmp", "bb-sock-test-"));
    roots.push(directory);
    return directory;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
  });

  it("creates a 0700 per-user root and a unique 0700 directory per call", () => {
    const parent = tmpRoot();
    const first = createPrivateSocketDirectory({ scopeKey: "/b", prefix: "cua", tmpRoot: parent });
    const second = createPrivateSocketDirectory({ scopeKey: "/b", prefix: "cua", tmpRoot: parent });
    const root = privateSocketRootPath(uid, parent);
    expect(Path.dirname(first)).toBe(root);
    expect(Path.basename(first)).toMatch(new RegExp(`^cua-${privateSocketScopeTag("/b")}-`));
    expect(first).not.toBe(second);
    for (const directory of [root, first]) {
      const stat = FS.lstatSync(directory);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(stat.uid).toBe(uid);
    }
  });

  it("tightens an existing owned root with loose permissions", () => {
    const parent = tmpRoot();
    const root = privateSocketRootPath(uid, parent);
    FS.mkdirSync(root, { mode: 0o755 });
    FS.chmodSync(root, 0o755);
    createPrivateSocketDirectory({ scopeKey: "/b", prefix: "cua", tmpRoot: parent });
    expect(FS.lstatSync(root).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlinked root", () => {
    const parent = tmpRoot();
    const target = FS.mkdtempSync(Path.join(parent, "target-"));
    FS.symlinkSync(target, privateSocketRootPath(uid, parent));
    expect(() =>
      createPrivateSocketDirectory({ scopeKey: "/b", prefix: "cua", tmpRoot: parent }),
    ).toThrow(/not a real directory/);
    expect(FS.readdirSync(target)).toEqual([]);
  });

  it("refuses a root that is a regular file", () => {
    const parent = tmpRoot();
    FS.writeFileSync(privateSocketRootPath(uid, parent), "");
    expect(() =>
      createPrivateSocketDirectory({ scopeKey: "/b", prefix: "cua", tmpRoot: parent }),
    ).toThrow(/not a real directory/);
  });

  it("refuses a root owned by another user", () => {
    const parent = tmpRoot();
    const otherUid = uid + 1;
    FS.chmodSync(parent, 0o1777);
    FS.mkdirSync(privateSocketRootPath(otherUid, parent), { mode: 0o700 });
    expect(() =>
      createPrivateSocketDirectory({
        scopeKey: "/b",
        prefix: "cua",
        tmpRoot: parent,
        uid: otherUid,
      }),
    ).toThrow(/owned by uid/);
  });

  it("refuses a shared parent without the sticky bit", () => {
    const parent = tmpRoot();
    FS.chmodSync(parent, 0o777);
    expect(() =>
      createPrivateSocketDirectory({
        scopeKey: "/b",
        prefix: "cua",
        tmpRoot: parent,
        uid: uid + 1,
      }),
    ).toThrow(/not sticky/);
  });
});
