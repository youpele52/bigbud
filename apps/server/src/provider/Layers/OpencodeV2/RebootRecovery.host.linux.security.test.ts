import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ scenario: "valid" }));
vi.mock("node:fs/promises", () => {
  const contents: Record<string, string> = {
    "/etc/machine-id": "ab".repeat(16),
    "/proc/sys/kernel/random/boot_id": "12345678-1234-1234-1234-123456789abc",
    "/proc/stat": "btime 100\n",
  };
  const facts = () => ({
    uid: fixture.scenario === "foreign-owner" ? 501 : 0,
    mode: fixture.scenario === "writable" ? 0o100666 : 0o100444,
    dev: 1,
    ino: 5,
    mtimeMs: 1,
    size: 0,
    isFile: () => true,
    isDirectory: () => true,
    isSymbolicLink: () => fixture.scenario === "symlink",
  });
  return {
    lstat: vi.fn(async (filename: string) => ({
      ...facts(),
      ino: fixture.scenario === "replaced" && filename.endsWith("boot_id") ? 6 : 5,
    })),
    statfs: vi.fn(async () => ({ type: fixture.scenario === "fake-procfs" ? 0xef53 : 0x9fa0 })),
    open: vi.fn(async (filename: string) => {
      if (fixture.scenario === "missing")
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const data = fixture.scenario === "oversized" ? "x".repeat(129) : contents[filename]!;
      return {
        stat: async () => facts(),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const part = data.slice(position, position + length);
          return { bytesRead: buffer.write(part, offset) };
        },
        close: async () => {},
      };
    }),
  };
});

import { readV2LinuxRecoveryHost } from "./RebootRecovery.host.linux.ts";

afterEach(() => {
  fixture.scenario = "valid";
});

it("accepts bounded root-owned same-file kernel facts in a synthetic filesystem", async () => {
  expect(await readV2LinuxRecoveryHost()).toMatchObject({ bootSeconds: 100, bootMicroseconds: 0 });
});

it.each([
  "foreign-owner",
  "writable",
  "symlink",
  "replaced",
  "fake-procfs",
  "missing",
  "oversized",
])(
  "rejects %s evidence rather than substituting uptime or environment values",
  async (scenario) => {
    fixture.scenario = scenario;
    await expect(readV2LinuxRecoveryHost()).rejects.toThrow();
  },
);
