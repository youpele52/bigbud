import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { PROOF_TOKEN_BYTES } from "./sshOwnerPickerProof.codec.ts";
import { SshOwnerClientError } from "./sshOwnerProductionClient.errors.ts";

/**
 * Private profile files that make attach-or-spawn single-owner: the attach
 * descriptor, the launch gate and the socket path limit.
 *
 * @module sshOwnerProductionClient.attachment
 */

const MAX_ATTACH_BYTES = 8 * 1024;
export const MAX_SOCKET_BYTES = process.platform === "linux" ? 107 : 103;
const GATE_FILE = "client.gate";

export interface SshOwnerAttachmentDescriptor {
  readonly version: 1;
  readonly socketPath: string;
  readonly capability: Buffer;
}

const invalid = (message: string, cause?: unknown) =>
  new SshOwnerClientError("invalid-profile", message, cause);

export const absolutePath = (value: string) =>
  isAbsolute(value) && normalize(value) === value && !value.includes("\0");

/** Creates `ssh-owner/` as a private directory owned by this user. */
export async function ensurePrivateSshOwnerDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !info.isDirectory() ||
    info.uid !== uid ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw invalid("The SSH owner state directory is not private to this user.");
  }
}

const isMissing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** Reads the profile's attach descriptor, refusing any unsafe file. */
export async function readSshOwnerAttachmentDescriptor(
  attachFile: string,
): Promise<SshOwnerAttachmentDescriptor | undefined> {
  const file = await open(
    attachFile,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;
    throw new SshOwnerClientError(
      "attachment-invalid",
      "The SSH owner attach descriptor is unreadable.",
      cause,
    );
  });
  if (!file) return undefined;
  try {
    const info = await file.stat();
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !info.isFile() ||
      info.uid !== uid ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size < 1 ||
      info.size > MAX_ATTACH_BYTES
    ) {
      throw new SshOwnerClientError(
        "attachment-invalid",
        "The SSH owner attach descriptor is not a private regular file.",
      );
    }
    const parsed: unknown = JSON.parse(await file.readFile("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { socketPath?: unknown }).socketPath !== "string" ||
      typeof (parsed as { capability?: unknown }).capability !== "string" ||
      !/^[0-9a-f]{64}$/.test((parsed as { capability: string }).capability)
    ) {
      throw new SshOwnerClientError(
        "attachment-invalid",
        "The SSH owner attach descriptor has an unexpected shape.",
      );
    }
    const socketPath = (parsed as { socketPath: string }).socketPath;
    if (!absolutePath(socketPath) || Buffer.byteLength(socketPath) > MAX_SOCKET_BYTES) {
      throw new SshOwnerClientError(
        "attachment-invalid",
        "The SSH owner attach descriptor names an unsafe socket.",
      );
    }
    return {
      version: 1,
      socketPath,
      capability: Buffer.from((parsed as { capability: string }).capability, "hex"),
    };
  } catch (cause) {
    if (cause instanceof SshOwnerClientError) throw cause;
    throw new SshOwnerClientError(
      "attachment-invalid",
      "The SSH owner attach descriptor is not valid JSON.",
      cause,
    );
  } finally {
    await file.close();
  }
}

/** Atomically publishes the descriptor after a successful handshake. */
export async function writeSshOwnerAttachmentDescriptor(
  attachFile: string,
  descriptor: SshOwnerAttachmentDescriptor,
): Promise<void> {
  const pending = `${attachFile}.${process.pid}.${randomBytes(4).toString("hex")}.pending`;
  await writeFile(
    pending,
    JSON.stringify({
      version: 1,
      socketPath: descriptor.socketPath,
      capability: descriptor.capability.toString("hex"),
    }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    await rename(pending, attachFile);
  } catch (cause) {
    await rm(pending, { force: true });
    throw new SshOwnerClientError(
      "attachment-invalid",
      "The SSH owner attach descriptor could not be published.",
      cause,
    );
  }
}

/** Removes a descriptor only when it still names the same endpoint. */
export async function clearSshOwnerAttachmentDescriptor(
  attachFile: string,
  socketPath: string,
): Promise<void> {
  const current = await readSshOwnerAttachmentDescriptor(attachFile);
  if (current?.socketPath === socketPath) await unlink(attachFile).catch(() => undefined);
}

/** A fresh 32-byte attachment capability for one owner profile. */
export const newSshOwnerAttachCapability = () => randomBytes(PROOF_TOKEN_BYTES);

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Serializes spawn decisions across backend restarts. Attach happens before this
 * gate, so a live owner is never blocked; a stale gate from a crashed backend is
 * reclaimed only when its recorded PID is gone.
 */
export async function acquireSshOwnerLaunchGate(
  directory: string,
  lockFile: string,
): Promise<() => Promise<void>> {
  await ensurePrivateSshOwnerDirectory(directory);
  const gateFile = join(directory, GATE_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(
        gateFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await file.writeFile(JSON.stringify({ pid: process.pid, lockFile, startedAt: Date.now() }));
      await file.close();
      return async () => {
        await rm(gateFile, { force: true });
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new SshOwnerClientError(
          "owner-start-failed",
          "The SSH owner launch gate could not be acquired.",
          cause,
        );
      }
      const current = await readFile(gateFile, "utf8").catch(() => undefined);
      let pid: number | undefined;
      try {
        const parsed = JSON.parse(current ?? "{}") as { pid?: unknown };
        pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
      } catch {
        pid = undefined;
      }
      if (pid !== undefined && pidAlive(pid)) {
        throw new SshOwnerClientError(
          "second-owner-refused",
          "Another backend already owns this profile's SSH owner launch gate.",
        );
      }
      await rm(gateFile, { force: true });
    }
  }
  throw new SshOwnerClientError(
    "second-owner-refused",
    "The SSH owner launch gate could not be reclaimed.",
  );
}
