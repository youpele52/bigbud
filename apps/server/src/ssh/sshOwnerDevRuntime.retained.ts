import { createHash } from "node:crypto";
import { constants, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { DEV_SSH_OWNER_RETAIN_ENV, DEV_SSH_OWNER_RETAIN_MARKER } from "@bigbud/shared/DevLauncher";
import { attachPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import type { PickerProofSessionOptions } from "./sshOwnerPickerProof.client.session.ts";
import { readDevOwnerProfileConfig } from "./sshOwnerDevRuntime.profileConfig.ts";

export const retainedAlias = "rust-ssh-owner-dev";
export const retainedTargetId = `ssh:${new URLSearchParams({ host: retainedAlias, auth: "ssh-key", transport: "direct-ssh" })}`;
export const retainedHandoff = (profile: string) => path.join(profile, "retained-owner", "handoff");
export const retainedProfileBinding = (profile: string, root: string, port: number) =>
  createHash("sha256")
    .update(JSON.stringify(["bigbud.dev.retained-owner.v1", profile, root, port]))
    .digest();
const invalid = () =>
  new Error("The supervised disposable SSH owner is unavailable. Restart the dev launcher.");

async function statIfPresent(location: string) {
  return lstat(location).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid();
    return undefined;
  });
}

export async function retainedProfileSelected(profile: string) {
  const marker = await statIfPresent(path.join(profile, DEV_SSH_OWNER_RETAIN_MARKER));
  if (!marker) {
    if (
      process.env[DEV_SSH_OWNER_RETAIN_ENV] === "1" ||
      (await statIfPresent(path.dirname(retainedHandoff(profile))))
    )
      throw invalid();
    return false;
  }
  if (
    process.platform !== "darwin" ||
    !process.versions.bun ||
    !process.getuid?.() ||
    !marker.isFile() ||
    marker.uid !== process.getuid() ||
    (marker.mode & 0o777) !== 0o600 ||
    marker.size !== 0 ||
    (await readDevOwnerProfileConfig(profile))
  )
    throw invalid();
  return true;
}

async function assertPrivateDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw invalid();
}

async function readHandoff(profile: string) {
  const location = retainedHandoff(profile);
  await assertPrivateDirectory(path.dirname(location));
  const file = await open(
    location,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size >= 512
    )
      throw invalid();
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw invalid();
    return JSON.parse(buffer.toString("utf8", 0, bytesRead)) as {
      root?: unknown;
      port?: unknown;
      capability?: unknown;
      ownerEpoch?: unknown;
    };
  } finally {
    await file.close();
  }
}

export async function attachRetainedDevOwner(
  profile: string,
  sql: PickerProofSessionOptions["sql"],
) {
  try {
    const { root, port, capability, ownerEpoch } = await readHandoff(profile);
    if (
      typeof root !== "string" ||
      !/^\/private\/tmp\/bigbud-picker-sshd-[a-zA-Z0-9]{6}$/.test(root) ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof capability !== "string" ||
      !/^[a-f0-9]{64}$/.test(capability) ||
      typeof ownerEpoch !== "string" ||
      !/^[a-f0-9]{64}$/.test(ownerEpoch)
    )
      throw invalid();
    await assertPrivateDirectory(root);
    if ((await realpath(root)) !== root) throw invalid();
    const owner = await attachPickerProofOwner({
      socketPath: path.join(root, "owner.sock"),
      profileBinding: retainedProfileBinding(await realpath(profile), root, port),
      capability: Buffer.from(capability, "hex"),
      targetId: retainedTargetId,
      sql,
    });
    if (Buffer.from(owner.ownerEpoch).toString("hex") !== ownerEpoch) {
      await owner.close();
      throw invalid();
    }
    return {
      owner,
      fixture: {
        root,
        loopback: "127.0.0.1",
        host: `[127.0.0.1]:${port}`,
        folder: path.join(root, "home", "picker's folders; literal"),
      },
    };
  } catch {
    throw invalid();
  }
}
