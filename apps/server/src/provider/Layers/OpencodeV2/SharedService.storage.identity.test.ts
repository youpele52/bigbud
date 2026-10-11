import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { v2UnixStorageIdentity } from "./SharedService.storage.identity.ts";
import { validateV2LinuxInventory } from "./SharedService.storage.linux.ts";

it("serializes adjacent 64-bit Linux inode/device identities without rounding", () => {
  const id = (dev: bigint, ino: bigint) =>
    v2UnixStorageIdentity("linux", "/native/db", { dev, ino });
  expect(id(1n, 9007199254740992n)).not.toBe(id(1n, 9007199254740993n));
  expect(id(9007199254740992n, 1n)).not.toBe(id(9007199254740993n, 1n));
  expect(() =>
    v2UnixStorageIdentity("linux", "/native/db", { dev: 1, ino: 9007199254740992 }),
  ).toThrow("precision");
});

it("preserves the exact historical macOS digest", () => {
  const expected = createHash("sha256")
    .update(JSON.stringify(["opencodeV2-shared-local", "/native/db", 100, 200]))
    .digest("hex");
  expect(v2UnixStorageIdentity("darwin", "/native/db", { dev: 100, ino: 200 })).toBe(expected);
});

it.each(["deleted", "replaced", "unavailable"] as const)(
  "does not hide %s evidence to select a surviving plugin WAL pair",
  (issue) => {
    expect(() =>
      validateV2LinuxInventory([
        { name: "/plugin/db", identity: { dev: 1n, ino: 2n } },
        { name: "/plugin/db-wal", identity: { dev: 1n, ino: 3n } },
        { name: "/native/db", issue },
      ]),
    ).toThrow("invalidated");
    expect(() => validateV2LinuxInventory([{ issue: "unavailable" }])).toThrow("invalidated");
  },
);
