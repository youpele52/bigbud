import { mkdtemp, writeFile, symlink, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readOwnershipLock,
  parseStateDirLockRecord,
  hasOwnershipControl,
} from "./backendOwnership.record";
import { ownershipStateDir, resolveOwnershipBaseDir } from "./backendOwnership.paths";

const record = {
  format: "bigbud.backend-lock.v1",
  pid: 42,
  startedAt: null,
  port: 0,
  hostname: "host",
  nonce: "old",
  acquiredAt: "now",
};
describe("ownership records", () => {
  it("preserves legacy parsing without granting permission to stop", () => {
    const parsed = parseStateDirLockRecord(JSON.stringify(record));
    expect(parsed).toEqual(record);
    expect(hasOwnershipControl(parsed!)).toBe(false);
    expect(parseStateDirLockRecord("null")).toBeUndefined();
  });
  it.skipIf(process.platform === "win32")(
    "only reads bounded private regular files without following symlinks",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "bigbud-lock-read-"));
      const lock = path.join(directory, "backend.lock");
      try {
        expect(await readOwnershipLock(lock)).toBeUndefined();
        await writeFile(lock, JSON.stringify(record), { mode: 0o600 });
        expect(await readOwnershipLock(lock)).toEqual(record);
        await symlink(lock, path.join(directory, "link"));
        await expect(readOwnershipLock(path.join(directory, "link"))).rejects.toThrow(
          "owner_unverified",
        );
        await chmod(lock, 0o644);
        await expect(readOwnershipLock(lock)).rejects.toThrow("owner_unverified");
        await chmod(lock, 0o600);
        await writeFile(lock, "x".repeat(8193));
        await expect(readOwnershipLock(lock)).rejects.toThrow("owner_unverified");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("uses the same home expansion and state suffix as server startup", () => {
    expect(resolveOwnershipBaseDir(" ~/bigbud ")).toBe(path.join(os.homedir(), "bigbud"));
    expect(resolveOwnershipBaseDir("relative", "/working")).toBe(
      path.resolve("/working", "relative"),
    );
    expect(ownershipStateDir("/home", true)).toBe(path.join("/home", "dev"));
    expect(ownershipStateDir("/home", false)).toBe(path.join("/home", "userdata"));
  });
});
