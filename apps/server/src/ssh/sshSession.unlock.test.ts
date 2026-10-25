import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { SSH_UNLOCK_DEADLINE_MS } from "./sshLocalCommand.ts";
import { unlockSshExecutionTargetPassword } from "./sshSession.ts";

// Host identity is tested separately; this fixture exercises the authentication deadline.
vi.mock("./sshHostTrust.ts", () => ({ inspectSshHostTrust: vi.fn().mockResolvedValue(undefined) }));

// A fake `ssh` that refuses control checks and hangs on connect, like a black-holed host.
const binDirectory = mkdtempSync(join(tmpdir(), "bigbud-fake-ssh-"));
const argsFile = join(binDirectory, "args.txt");
writeFileSync(
  join(binDirectory, "ssh"),
  `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "-O" ] && exit 255; done\necho "$@" > "${argsFile}"\nexec sleep 120\n`,
);
chmodSync(join(binDirectory, "ssh"), 0o755);
afterAll(() => rmSync(binDirectory, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("unlockSshExecutionTargetPassword", () => {
  it(
    "fails within its deadline against an unreachable host while the event loop stays free",
    async () => {
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;
      let last = performance.now();
      let maxGapMs = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
      }, 10);
      const startedAt = performance.now();
      try {
        await expect(
          unlockSshExecutionTargetPassword({
            executionTargetId: "ssh:host=192.0.2.1&user=root&port=22&auth=password",
            password: "secret",
          }),
        ).rejects.toThrow(/Timed out after 20 s connecting to root@192\.0\.2\.1:22/);
      } finally {
        clearInterval(timer);
        process.env.PATH = originalPath;
      }
      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeLessThan(SSH_UNLOCK_DEADLINE_MS + 2_000);
      expect(maxGapMs).toBeLessThan(250);
      const argv = readFileSync(argsFile, "utf8");
      expect(argv).toMatch(/ConnectTimeout=10/);
      // The password reaches ssh only through the askpass environment, never argv.
      expect(argv).not.toContain("secret");
    },
    SSH_UNLOCK_DEADLINE_MS + 10_000,
  );
});
