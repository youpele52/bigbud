import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import type { ScopedProofStartupOptions } from "./sshOwnerPickerProof.client.scopedStartup.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

export const live =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
export const signal = () => new AbortController().signal;
type Fixture = Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>;

export async function withFixture<A>(run: (fixture: Fixture) => Promise<A>) {
  const fixture = await makeLinuxLoopbackPickerFixture();
  try {
    return await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

export async function withOwner<A>(
  fixture: Fixture,
  scope: ScopedProofStartupOptions,
  run: (owner: LaunchedPickerProofOwner, targetId: string) => Promise<A>,
  { reuseLauncher = false } = {},
) {
  const binary = reuseLauncher
    ? path.join(fixture.root, "start-picker-owner")
    : await fixture.installOwner(
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
  const targetId = `ssh:${new URLSearchParams({ host: fixture.loopback, port: String(fixture.port), user: fixture.user })}`;
  return storageScope(path.join(fixture.root, "scoped.sqlite"), (sql) =>
    Effect.promise(async () => {
      const owner = await startPickerProofOwner({
        ...scope,
        binary,
        sql,
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
      });
      try {
        return await run(owner, targetId);
      } finally {
        await owner.close();
      }
    }),
  );
}

export async function approve(owner: LaunchedPickerProofOwner) {
  const trust = await owner.inspectTrust();
  if (trust.state !== "approvalRequired") throw new Error("Expected first-use approval");
  await owner.approveTrust(trust.challenge);
}
