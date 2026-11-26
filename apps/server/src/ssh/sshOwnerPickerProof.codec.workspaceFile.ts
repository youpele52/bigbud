import { decodeMessage } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  boolValue,
  bytesValue,
  EMPTY,
  invalid,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";
import type {
  PickerProofWorkspaceFile,
  ProofWorkspaceReadOperation,
} from "./sshOwnerPickerProof.codec.workspace.ts";

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export function readWorkspaceFile(bytes: Uint8Array): PickerProofWorkspaceFile {
  let data: Uint8Array | undefined;
  let sizeBytes: number | undefined;
  let truncated: boolean | undefined;
  let sha256: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (data !== undefined) return invalid();
      const payload = bytesValue(wire, reader);
      if (payload.byteLength > MAX_PREVIEW_BYTES) return invalid();
      // Expose a plain Uint8Array without copying the captured file.
      data = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    } else if (field === 2) {
      if (sizeBytes !== undefined) return invalid();
      sizeBytes = uintValue(wire, reader);
    } else if (field === 3) {
      if (truncated !== undefined) return invalid();
      truncated = boolValue(wire, reader);
    } else if (field === 4) {
      const digest = bytesValue(wire, reader);
      if (sha256 !== undefined || digest.byteLength !== 32) return invalid();
      sha256 = Buffer.from(digest).toString("hex");
    } else reader.skip(wire);
  });
  const result = {
    data: data ?? EMPTY,
    sizeBytes: sizeBytes ?? 0,
    truncated: truncated ?? false,
    ...(sha256 === undefined ? {} : { sha256 }),
  };
  if (result.data.length > result.sizeBytes) return invalid();
  return result;
}

export function verifyWorkspaceFile(
  read: ProofWorkspaceReadOperation["read"],
  file: PickerProofWorkspaceFile,
): void {
  const { data, sizeBytes, truncated } = file;
  if (read.kind === "preview") {
    if (truncated || sizeBytes > MAX_PREVIEW_BYTES || data.length !== sizeBytes) return invalid();
  } else {
    const remaining = Math.max(0, sizeBytes - read.offset);
    const expectedLength = Math.min(remaining, read.maxBytes);
    const expectedTruncated = expectedLength < remaining;
    if (
      file.sha256 !== undefined ||
      data.length !== expectedLength ||
      truncated !== expectedTruncated
    )
      return invalid();
  }
}
