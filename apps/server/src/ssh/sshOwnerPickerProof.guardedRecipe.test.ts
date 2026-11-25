import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const run = promisify(execFile);

it.skipIf(
  process.platform !== "darwin" || process.env.BIGBUD_TEST_SSH_OWNER_GUARDED_RECIPE !== "1",
)(
  "executes the private guarded recipe on the standard workspace root over stock OpenSSH",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
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
          "transport::guarded_recipe::tests::live_private_openssh_guarded_recipe",
          "--",
          "--exact",
          "--ignored",
          "--nocapture",
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          env: {
            ...process.env,
            BIGBUD_GUARDED_RECIPE_FIXTURE: "approved-disposable",
            BIGBUD_GUARDED_RECIPE_ROOT: fixture.root,
            BIGBUD_GUARDED_RECIPE_PORT: String(fixture.port),
            BIGBUD_GUARDED_RECIPE_USER: fixture.user,
          },
          timeout: 75_000,
          killSignal: "SIGTERM",
        },
      );
      expect(result.stdout).toContain("1 passed; 0 failed");
      expect(await fixture.launchNames()).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  },
  90_000,
);
