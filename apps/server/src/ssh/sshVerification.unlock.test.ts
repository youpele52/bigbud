import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { isPassphraseProtectedKeyLoadedAsync } from "./sshAgent.ts";
import { createSshDeadline, SSH_UNLOCK_DEADLINE_MS } from "./sshLocalCommand.ts";
import { unlockSshExecutionTargetKey } from "./sshVerification.ts";

// Fake ssh-agent tools: `ssh-add` hangs like an agent waiting on a biometric prompt.
const directory = mkdtempSync(join(tmpdir(), "bigbud-fake-ssh-agent-"));
const keyPath = join(directory, "id_test");
writeFileSync(keyPath, "not a real key\n");
writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAA test\n");
writeFileSync(join(directory, "ssh-add"), "#!/bin/sh\nexec sleep 120\n");
writeFileSync(
  join(directory, "ssh-agent"),
  `#!/bin/sh\necho "SSH_AUTH_SOCK=${directory}/agent.sock; export SSH_AUTH_SOCK;"\necho "SSH_AGENT_PID=1; export SSH_AGENT_PID;"\n`,
);
chmodSync(join(directory, "ssh-add"), 0o755);
chmodSync(join(directory, "ssh-agent"), 0o755);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("SSH key unlock deadlines", () => {
  it(
    "fails within its deadline when ssh-agent hangs, without blocking the event loop",
    async () => {
      const saved = {
        PATH: process.env.PATH,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        SSH_AGENT_PID: process.env.SSH_AGENT_PID,
      };
      process.env.PATH = `${directory}:${saved.PATH ?? ""}`;
      process.env.SSH_AUTH_SOCK = join(directory, "stale.sock");
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
          unlockSshExecutionTargetKey({
            executionTargetId: `ssh:host=192.0.2.1&user=root&auth=ssh-key&keyPath=${encodeURIComponent(keyPath)}`,
            passphrase: "hunter2",
          }),
        ).rejects.toThrow(/Timed out after 20 s unlocking SSH key/);
      } finally {
        clearInterval(timer);
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect(performance.now() - startedAt).toBeLessThan(SSH_UNLOCK_DEADLINE_MS + 2_000);
      expect(maxGapMs).toBeLessThan(250);
    },
    SSH_UNLOCK_DEADLINE_MS + 10_000,
  );

  it("reports a spent deadline as a timeout rather than a missing key", async () => {
    await expect(
      isPassphraseProtectedKeyLoadedAsync(keyPath, createSshDeadline(0)),
    ).rejects.toThrow(/Timed out waiting for ssh-agent/);
  });
});
