import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildRemoteAgentInstallScript } from "./remoteAgentInstall.ts";
import { buildRemoteAgentStageFenceRevokeCommand } from "./remoteAgentInstall.stageFence.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const targetTriple = "x86_64-unknown-linux-gnu" as const;
const bytes = Buffer.from("stage-race-binary");
const artifact = {
  version: "0.2.207",
  buildDigest: "stage-race",
  protocolMajor: 1,
  protocolMinor: 2,
  targetTriple,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  signature: { algorithm: "ed25519" as const, keyId: "test", value: "test" },
  bundledPath: "fixture",
};

/*
 * This is intentionally an async poll rather than a local filesystem check:
 * the same test runs against a network-disabled Linux container on macOS.
 */
async function waitForFenceLock(
  fixture: ReturnType<typeof createLinuxControlFixture>,
  path: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await fixture.run(
      `if test -e '${path}' && exec 8<> '${path}'; then if flock -n -x 8; then printf free; else printf locked; fi; else printf missing; fi`,
    );
    if (result.trim() === "locked") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path} to be held`);
}

/* Keep the test's process lifetime under the fixture's command timeout. */
function pausedInstall(script: string): string {
  return script.replace(
    'test "$(cat "$reservation_fence")" = active',
    'test "$(cat "$reservation_fence")" = active\nsleep 0.5',
  );
}

describe.runIf(linuxControlAvailable)("remote agent stage fencing", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  it("does not revoke a paused upload, then fences it after its command exits", async () => {
    fixture = createLinuxControlFixture();
    const home = `${fixture.root}/home`;
    await fixture.run(`mkdir -p -m 700 '${home}'`);
    const reservationId = "delayed-controller";
    try {
      const install = buildRemoteAgentInstallScript({
        artifact,
        targetTriple,
        stagedBase64: bytes.toString("base64"),
        reservationId,
      });
      const upload = fixture.runInput(
        `export HOME='${home}'; ${pausedInstall(install.command)}`,
        install.stdin,
      );
      const lock = `${home}/.bigbud/agent/staging/${reservationId}.lock`;
      await waitForFenceLock(fixture, lock);
      const revoke = (command: string) => fixture.run(command).then((result) => result.trim());
      expect(
        await revoke(
          buildRemoteAgentStageFenceRevokeCommand(`${home}/.bigbud/agent`, reservationId),
        ),
      ).toBe("live");
      await upload;
      expect(
        await revoke(
          buildRemoteAgentStageFenceRevokeCommand(`${home}/.bigbud/agent`, reservationId),
        ),
      ).toBe("revoked");
    } finally {
      await fixture.run(`rm -rf '${home}'`);
    }
  });
});
