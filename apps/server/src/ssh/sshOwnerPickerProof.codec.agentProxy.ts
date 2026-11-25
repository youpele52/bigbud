import {
  writeScopedDuplex,
  type ScopedDuplexOpen,
} from "./sshOwnerPickerProof.codec.scopedDuplex.ts";
import {
  writeProofProviderScope,
  type ProofProviderOpenOperation,
} from "./sshOwnerPickerProof.codec.provider.ts";
import { isAbsolute } from "node:path";

import type { ClientRelayDeployment } from "../remote-backend/clientRelay.ssh.owner.ts";
import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

export interface PickerProofAgentFixture {
  readonly binaryPath: string;
  readonly sha256: string;
}

export type ProofAgentProxyOperation =
  | ScopedDuplexOpen
  | ProofProviderOpenOperation
  | ({ readonly kind: "openProofAgentProxy" } & PickerProofAgentFixture)
  | ({ readonly kind: "openProofClientRelay" } & ClientRelayDeployment)
  | { readonly kind: "proofAgentProxyStatus"; readonly lease: Uint8Array; readonly pid: number }
  | {
      readonly kind: "closeProofAgentProxy";
      readonly lease: Uint8Array;
      readonly pid: number;
      readonly terminate: boolean;
      readonly timeoutMs: number;
    };

export interface ProofAgentProxyStatus {
  readonly lease: Uint8Array;
  readonly pid: number;
  readonly closed: boolean;
  readonly code: number | undefined;
  readonly signal: number | undefined;
}

export function validateProofAgentFixture({ binaryPath, sha256 }: PickerProofAgentFixture) {
  if (
    !isAbsolute(binaryPath) ||
    binaryPath.includes("\0") ||
    Buffer.byteLength(binaryPath) > 4096 ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return { binaryPath, sha256 };
}

export function validateProofRelayFixture({
  nodeBinary,
  nodeSha256,
  helperEntry,
  helperSha256,
  authorityId,
}: ClientRelayDeployment): ClientRelayDeployment {
  validateProofAgentFixture({ binaryPath: nodeBinary, sha256: nodeSha256 });
  validateProofAgentFixture({ binaryPath: helperEntry, sha256: helperSha256 });
  if (!/^[a-f0-9]{32}$/.test(authorityId)) throw new PickerProofOwnerError("invalidOperands");
  return { nodeBinary, nodeSha256, helperEntry, helperSha256, authorityId };
}

export function validateProofAgentCloseTimeout(timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new PickerProofOwnerError("invalidOperands");
}

export function writeProofAgentProxy(
  writer: WireWriter,
  operands: WireWriter,
  operation: ProofAgentProxyOperation,
) {
  if (
    operation.kind === "openProofPeerRelay" ||
    operation.kind === "openProofGitAdvertisement" ||
    operation.kind === "openProofGitUpload"
  ) {
    const tag = writeScopedDuplex(operands, operation);
    writer.fieldRepeatedMessage(tag, operands.finish());
    return;
  }
  if (operation.kind === "openProofCodex" || operation.kind === "openProofPi") {
    writeProofProviderScope(operands, operation);
    writer.fieldRepeatedMessage(operation.kind === "openProofCodex" ? 39 : 41, operands.finish());
    return;
  }
  if (operation.kind === "openProofClientRelay") {
    const { nodeBinary, nodeSha256, helperEntry, helperSha256, authorityId } =
      validateProofRelayFixture(operation);
    operands.fieldString(1, nodeBinary);
    operands.fieldString(2, nodeSha256);
    operands.fieldString(3, helperEntry);
    operands.fieldString(4, helperSha256);
    operands.fieldString(5, authorityId);
    writer.fieldRepeatedMessage(37, operands.finish());
    return;
  }
  if (operation.kind === "openProofAgentProxy") {
    const { binaryPath, sha256 } = validateProofAgentFixture(operation);
    operands.fieldString(1, binaryPath);
    operands.fieldString(2, sha256);
    writer.fieldRepeatedMessage(29, operands.finish());
    return;
  }
  if (operation.lease.length !== PROOF_TOKEN_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  operands.fieldBytes(1, operation.lease);
  if (operation.kind === "proofAgentProxyStatus") {
    writer.fieldRepeatedMessage(30, operands.finish());
    return;
  }
  validateProofAgentCloseTimeout(operation.timeoutMs);
  operands.fieldBool(2, operation.terminate);
  operands.fieldUint(3, operation.timeoutMs);
  writer.fieldRepeatedMessage(31, operands.finish());
}

export function readProofAgentProxyStatus(bytes: Uint8Array): ProofAgentProxyStatus {
  // This fixed-shape message uses int32, whose negative values are sign-extended
  // to ten-byte varints. The shared unsigned reader intentionally rejects those.
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) return invalid();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    return invalid();
  };
  const int32 = () => {
    const value = varint();
    const signed = BigInt.asIntN(32, value);
    if (value !== BigInt.asUintN(64, signed)) return invalid();
    return Number(signed);
  };
  let lease: Uint8Array | undefined;
  let pid: number | undefined;
  let closed: boolean | undefined;
  let code: number | undefined;
  let signal: number | undefined;
  while (offset < bytes.length) {
    switch (varint()) {
      case 10n:
        if (lease !== undefined || varint() !== BigInt(PROOF_TOKEN_BYTES)) return invalid();
        lease = bytes.slice(offset, offset + PROOF_TOKEN_BYTES);
        if (lease.length !== PROOF_TOKEN_BYTES) return invalid();
        offset += PROOF_TOKEN_BYTES;
        break;
      case 16n: {
        const raw = varint();
        if (pid !== undefined || raw === 0n || raw > 0xffff_ffffn) return invalid();
        pid = Number(raw);
        break;
      }
      case 24n: {
        const raw = varint();
        if (closed !== undefined || raw > 1n) return invalid();
        closed = raw === 1n;
        break;
      }
      case 32n:
        if (code !== undefined) return invalid();
        code = int32();
        break;
      case 40n:
        if (signal !== undefined) return invalid();
        signal = int32();
        break;
      default:
        return invalid();
    }
  }
  if (!lease || pid === undefined) return invalid();
  if (code !== undefined && signal !== undefined) return invalid();
  if (!closed && (code !== undefined || signal !== undefined)) return invalid();
  return { lease, pid, closed: closed ?? false, code, signal };
}
