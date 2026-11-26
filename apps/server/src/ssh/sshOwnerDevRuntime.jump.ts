import {
  access,
  constants,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_SSH_OWNER_LINUX_JUMP_MARKER, isDevSshOwnerProfile } from "@bigbud/shared/DevLauncher";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";

const alias = "workspace";
const loopback = "127.0.0.1";
const port = 22223;
const targetId = `ssh:${new URLSearchParams({ host: alias, auth: "ssh-key", transport: "direct-ssh" })}`;
// A source-checkout path, resolved only when the dev jump binds. It is not a module asset: a
// `new URL(literal, import.meta.url)` here made the release backend graph require the fixture.
const fixtureScript = () =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../protocol/ssh-owner/live-jump-fixture.sh",
  );
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function linuxDevJumpMode(
  profile: string,
): Promise<"pre-pinned" | "first-use" | undefined> {
  if (process.platform !== "linux" || !isDevSshOwnerProfile(profile, "linux", "/tmp"))
    return undefined;
  const markerPath = path.join(profile, DEV_SSH_OWNER_LINUX_JUMP_MARKER);
  const marker = await lstat(markerPath).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!marker) return undefined;
  const directory = await lstat(profile);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    uid === 0 ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o777) !== 0o700 ||
    !marker.isFile() ||
    marker.uid !== uid ||
    (marker.mode & 0o777) !== 0o600 ||
    marker.size > 1
  )
    throw new Error("Expected a private disposable Linux SSH jump profile.");
  if (marker.size === 0) return "pre-pinned";
  if ((await readFile(markerPath, "utf8")) === "1") return "first-use";
  throw new Error("Invalid disposable Linux SSH jump mode.");
}

export async function bindLinuxDevJump(
  profile: string,
  binary: string,
  sql: SqlClient.SqlClient,
  firstUse = false,
) {
  const source = await realpath(binary);
  await access(source, constants.X_OK);
  const root = await mkdtemp("/tmp/bigbud-picker-linux-");
  const wrapper = path.join(profile, "ssh-owner-jump-launcher");
  const fixture = { root, loopback };
  const picker = makeSshOwnerDevPicker({
    executionTargetId: targetId,
    allowJumpFirstUse: firstUse,
    host: `[${loopback}]:${port}`,
    startOwner: (profileBinding) =>
      startPickerProofOwner({
        binary: wrapper,
        profileBinding,
        targetId,
        sql,
        lockFile: path.join(root, "owner.lock"),
        sshBinary: "/usr/bin/ssh",
        keyscanBinary: "/usr/bin/ssh-keyscan",
        host: loopback,
        port,
        user: "picker",
        identityFile: path.join(root, "d-identity"),
        knownHostsFile: path.join(root, "d-pins"),
        aliasConfig: { file: path.join(root, "ssh-config"), alias },
      }),
  });
  let ownsWrapper = false;
  const close = async () => {
    await picker.close();
    await rm(root, { recursive: true, force: true });
    if (ownsWrapper) await rm(wrapper, { force: true });
  };
  try {
    const args = [fixtureScript(), firstUse ? "--serve-first-use" : "--serve", root, source]
      .map(quote)
      .join(" ");
    await writeFile(
      wrapper,
      `#!/bin/sh\nexport BIGBUD_SSH_OWNER_LIVE_JUMP=approved-disposable\nexec /bin/sh ${args} "$@"\n`,
      { flag: "wx", mode: 0o700 },
    );
    ownsWrapper = true;
    // Finish the private namespace and owner startup before advertising the alias.
    await picker.withOwner(targetId, async () => undefined);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    kind: "linux-jump" as const,
    alias,
    targetId,
    fixture,
    picker,
    sql,
    close,
    terminal: undefined,
    firstUse,
    configuredHost: {
      alias,
      sourcePath: path.join(root, "ssh-config"),
      line: 1,
      hostName: loopback,
    },
  };
}
