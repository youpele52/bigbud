import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";

import { assertPrivateDirectory } from "../terminal-host/localTerminalHost.fs.ts";
import {
  encodeAttachHello,
  encodeAttachProbe,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.ts";
import { connectPickerProofPipe, type PickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";

export interface PickerProofAttachment {
  readonly socketPath: string;
  readonly capability: Uint8Array;
}

const MAX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;

export function copyPickerProofAttachment({ socketPath, capability }: PickerProofAttachment) {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath.endsWith("/") ||
    socketPath.includes("\0") ||
    Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES ||
    capability.length !== PROOF_TOKEN_BYTES
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return { socketPath, capability: Buffer.from(capability) };
}

export async function assertPrivatePickerProofSocketDirectory(socketPath: string) {
  try {
    const parent = dirname(socketPath);
    await assertPrivateDirectory(parent);
    const canonicalParent = await realpath(parent);
    const uid = process.geteuid?.();
    // Match the native fixture: system aliases are allowed; insecure ancestors are not.
    let directory = canonicalParent;
    for (;;) {
      const stat = await lstat(directory);
      if (
        !stat.isDirectory() ||
        (stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) ||
        (directory === canonicalParent && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))
      )
        throw new PickerProofOwnerError("invalidOperands");
      const next = dirname(directory);
      if (next === directory) break;
      directory = next;
    }
    const canonicalPath = join(canonicalParent, basename(socketPath));
    if (Buffer.byteLength(canonicalPath) > MAX_SOCKET_PATH_BYTES)
      throw new PickerProofOwnerError("invalidOperands");
    return canonicalPath;
  } catch {
    throw new PickerProofOwnerError("invalidOperands");
  }
}

export async function connectPickerProofAttachment(socketPath: string): Promise<PickerProofPipe> {
  const canonicalPath = await assertPrivatePickerProofSocketDirectory(socketPath);
  const stat = await lstat(canonicalPath).catch(() => {
    throw new PickerProofOwnerError("ownerUnavailable");
  });
  if (!stat.isSocket() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  try {
    return connectPickerProofPipe(canonicalPath);
  } catch {
    throw new PickerProofOwnerError("ownerUnavailable");
  }
}

export async function exchangePickerProofAttachmentHello(
  pipe: PickerProofPipe,
  capability: Uint8Array,
  profileBinding: Uint8Array,
  major: number,
) {
  const clientNonce = randomBytes(PROOF_TOKEN_BYTES);
  const challenge = await pipe.exchange(encodeAttachProbe(clientNonce));
  if (challenge.kind !== "attachChallenge") throw new PickerProofOwnerError("protocolError");
  const { serverNonce, proof } = challenge;
  const computeProof = (role: "server" | "client") =>
    createHmac("sha256", capability)
      .update(`bigbud.ssh-owner.proof-${role}.v1\0`, "ascii")
      .update(profileBinding)
      .update(clientNonce)
      .update(serverNonce)
      .digest();
  if (!timingSafeEqual(proof, computeProof("server"))) {
    throw new PickerProofOwnerError("operationDenied");
  }
  return pipe.exchange(encodeAttachHello(profileBinding, major, computeProof("client")));
}
