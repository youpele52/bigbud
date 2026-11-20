import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBigbudLockOwnerDetector } from "./tailscaleRemoteAccess.takeover";

const roots: string[] = [];

function makeRoot(): string {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-takeover-"));
  roots.push(root);
  return root;
}

function writeLock(stateDir: string, record: Record<string, unknown>) {
  FS.mkdirSync(stateDir, { recursive: true });
  FS.writeFileSync(
    Path.join(stateDir, "backend.lock"),
    JSON.stringify({
      format: "bigbud.backend-lock.v1",
      pid: 4242,
      startedAt: null,
      hostname: "desk.local",
      acquiredAt: "2026-11-20T00:00:00.000Z",
      nonce: "n",
      ...record,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

describe("createBigbudLockOwnerDetector", () => {
  it("names the channel whose live backend lock records the forwarded port", async () => {
    const root = makeRoot();
    writeLock(Path.join(root, "userdata"), { port: 3773 });
    writeLock(Path.join(root, "channels", "beta", "userdata"), { port: 3774 });
    writeLock(Path.join(root, "dev"), { port: 3775 });
    const detect = createBigbudLockOwnerDetector([root], {
      isAlive: () => true,
      isListening: async () => true,
    });

    await expect(detect(3773)).resolves.toEqual({ label: "bigbud" });
    await expect(detect(3774)).resolves.toEqual({ label: "bigbud beta" });
    await expect(detect(3775)).resolves.toEqual({ label: "bigbud (development)" });
    await expect(detect(3000)).resolves.toBeNull();
  });

  it("accepts a stopped bigbud only when nothing else now listens on its port", async () => {
    const root = makeRoot();
    writeLock(Path.join(root, "userdata"), { port: 3773 });
    const isListening = vi.fn(async () => true);
    const detect = createBigbudLockOwnerDetector([root], { isAlive: () => false, isListening });

    // Dead pid, but another process took the port: that is not provably bigbud.
    await expect(detect(3773)).resolves.toBeNull();
    isListening.mockResolvedValue(false);
    await expect(detect(3773)).resolves.toEqual({ label: "bigbud" });
  });

  it("ignores missing roots and malformed or foreign lock files", async () => {
    const root = makeRoot();
    FS.mkdirSync(Path.join(root, "userdata"), { recursive: true });
    FS.writeFileSync(Path.join(root, "userdata", "backend.lock"), '{"port":3773}');
    const detect = createBigbudLockOwnerDetector([root, Path.join(root, "missing")], {
      isAlive: () => true,
      isListening: async () => true,
    });

    await expect(detect(3773)).resolves.toBeNull();
  });
});
