import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

export async function prepareProofOwner(
  fixture: Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>,
  {
    keyboardInteractiveProof = false,
    sessionBudgetProof,
  }: {
    readonly keyboardInteractiveProof?: boolean;
    readonly sessionBudgetProof?: number;
  } = {},
) {
  await fixture.start();
  const binary = await fixture.installOwner(
    process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
      fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
    { keyboardInteractiveProof, sessionBudgetProof },
  );
  const targetId = `ssh:${new URLSearchParams({ host: fixture.loopback, port: String(fixture.port), user: fixture.user })}`;
  const options = {
    binary,
    profileBinding: randomBytes(32),
    targetId,
    lockFile: path.join(fixture.root, "owner.lock"),
    sshBinary: fixture.ssh,
    keyscanBinary: fixture.keyscan,
    host: fixture.loopback,
    port: fixture.port,
    user: fixture.user,
    identityFile: fixture.identity,
    knownHostsFile: fixture.knownHosts,
    posixSyntheticPasswordFixture: true,
  } as const;
  return { options, targetId };
}
