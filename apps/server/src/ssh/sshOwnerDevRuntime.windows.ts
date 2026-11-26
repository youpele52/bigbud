import { open } from "node:fs/promises";
import path from "node:path";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER } from "@bigbud/shared/DevLauncher";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startWindowsPickerProofOwner } from "./sshOwnerPickerProof.client.windows.ts";
import { loadWindowsLoopbackPickerFixture } from "./sshPicker.loopback.fixture.windows.ts";

/** Called only with the startup-validated source dev profile. */
export async function bindWindowsDevPicker(
  profile: string,
  binary: string,
  alias: string,
  targetId: string,
  sql: SqlClient.SqlClient,
) {
  const file = await open(path.join(profile, DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER), "r");
  const marker = Buffer.alloc(4_097);
  let manifest: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size >= marker.length) {
      throw new Error("Invalid Windows SSH owner fixture marker.");
    }
    const count = (await file.read(marker, 0, stat.size)).bytesRead;
    if (count !== stat.size) throw new Error("Incomplete Windows SSH owner fixture marker.");
    manifest = new TextDecoder("utf-8", { fatal: true }).decode(marker.subarray(0, count));
  } finally {
    await file.close();
  }
  const fixture = await loadWindowsLoopbackPickerFixture(manifest);
  const picker = makeSshOwnerDevPicker({
    executionTargetId: targetId,
    host: fixture.host,
    expectedFingerprint: fixture.expectedFingerprint,
    startOwner: (profileBinding) =>
      startWindowsPickerProofOwner({
        binary,
        lockFile: path.join(fixture.root, "owner.lock"),
        targetId,
        profileBinding,
        port: fixture.port,
        user: fixture.user,
        identityFile: fixture.identity,
        knownHostsFile: fixture.knownHosts,
        sql,
      }),
  });
  return { kind: "windows" as const, alias, targetId, fixture, picker, sql, terminal: undefined };
}
