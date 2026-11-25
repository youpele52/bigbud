import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const run = promisify(execFile);

it
  .skipIf(
    process.platform !== "darwin" ||
      process.env.BIGBUD_TEST_SSH_OWNER_POSIX_MASTER_RETIREMENT !== "1",
  )
  .each([
    {
      name: "allows a replacement only after checked retirement of the retained OpenSSH child",
      rustTest:
        "transport::posix_master::tests::live::stock_master_retirement_requires_checked_reap_before_replacement",
    },
    {
      name: "retires a live OpenSSH master before acknowledging the new storage binding",
      rustTest:
        "owner::rebind_tests::live::live_picker_master_retires_before_storage_rebind_acknowledgement",
      connections: 2,
    },
  ])(
  "$name",
  async ({ rustTest, connections }) => {
    const fixture = await makeLoopbackPickerFixture({ boundIdleMasterLifetime: true });
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      const result = await run(
        "cargo",
        [
          "test",
          "--offline",
          "--locked",
          "-p",
          "bigbud-ssh-owner",
          "--bin",
          "bigbud-ssh-owner",
          rustTest,
          "--",
          "--exact",
          "--ignored",
          "--nocapture",
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          env: {
            ...process.env,
            BIGBUD_POSIX_MASTER_FIXTURE: "approved-disposable",
            BIGBUD_POSIX_MASTER_FIXTURE_ROOT: fixture.root,
            BIGBUD_POSIX_MASTER_FIXTURE_PORT: String(fixture.port),
            BIGBUD_POSIX_MASTER_FIXTURE_USER: fixture.user,
          },
          timeout: 90_000,
          killSignal: "SIGKILL",
        },
      );
      expect(result.stdout).toContain("1 passed; 0 failed");
      if (connections !== undefined) {
        await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(connections));
        expect(fixture.connectionStarts()).toBe(connections);
      }
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
