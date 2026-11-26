import { decodeMessage, type WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  bytesValue,
  invalid,
  stringValue,
  uintValue,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
} from "./sshOwnerPickerProof.codec.wire.ts";

export interface ProofWorkspaceModeInspectOperation {
  readonly kind: "proofWorkspaceModeInspect";
  readonly root: string;
}

export interface ProofWorkspaceModePublishOperation {
  readonly kind: "proofWorkspaceModePublish";
  readonly root: string;
  readonly publicationToken: Uint8Array;
  readonly nextRecord: string;
}

const refusals = new Map<number, "notLinux" | "noMachineId" | "missingFolder" | "unsafeStorage">([
  [1, "notLinux"],
  [2, "noMachineId"],
  [3, "missingFolder"],
  [4, "unsafeStorage"],
] as const);

type Ready = {
  readonly state: "ready";
  readonly physicalRoot: string;
  readonly hostIdentity: string;
  readonly accountUid: number;
  readonly realpathSha256: string;
  readonly generation: number;
  readonly currentRecord?: string;
  readonly publicationToken: Uint8Array;
};

export type ProofWorkspaceModeInspection =
  | Ready
  | {
      readonly state: "refused";
      readonly reason: "notLinux" | "noMachineId" | "missingFolder" | "unsafeStorage";
    };

const validRoot = (root: string) =>
  root.startsWith("/") &&
  Buffer.byteLength(root) <= 4096 &&
  ![...root].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export function writeWorkspaceModeInspect(
  writer: WireWriter,
  operation: ProofWorkspaceModeInspectOperation,
) {
  if (!validRoot(operation.root)) throw new PickerProofOwnerError("invalidOperands");
  writer.fieldString(1, operation.root);
}

export function writeWorkspaceModePublish(
  writer: WireWriter,
  operation: ProofWorkspaceModePublishOperation,
) {
  if (
    !validRoot(operation.root) ||
    operation.publicationToken.byteLength !== PROOF_TOKEN_BYTES ||
    !operation.nextRecord ||
    Buffer.byteLength(operation.nextRecord) > 1024
  )
    throw new PickerProofOwnerError("invalidOperands");
  writer.fieldString(1, operation.root);
  writer.fieldBytes(2, operation.publicationToken);
  writer.fieldString(3, operation.nextRecord);
}

function readReady(bytes: Uint8Array): Ready {
  let physicalRoot = "",
    hostIdentity = "",
    realpathSha256 = "",
    currentRecord: string | undefined;
  let accountUid = 0,
    generation = 0;
  let publicationToken: Uint8Array | undefined;
  const seen = new Set<number>();
  decodeMessage(bytes, (number, wire, reader) => {
    if (seen.has(number)) return invalid();
    seen.add(number);
    switch (number) {
      case 1:
        physicalRoot = stringValue(wire, reader);
        break;
      case 2:
        hostIdentity = stringValue(wire, reader);
        break;
      case 3:
        accountUid = uintValue(wire, reader);
        break;
      case 4:
        realpathSha256 = stringValue(wire, reader);
        break;
      case 5:
        generation = uintValue(wire, reader);
        break;
      case 6:
        currentRecord = stringValue(wire, reader);
        break;
      case 7:
        publicationToken = Uint8Array.from(bytesValue(wire, reader));
        break;
      default:
        return invalid();
    }
  });
  if (
    !validRoot(physicalRoot) ||
    !/^machine-v1:[a-f0-9]{64}$/.test(hostIdentity) ||
    !/^[a-f0-9]{64}$/.test(realpathSha256) ||
    accountUid > 0xffffffff ||
    !Number.isSafeInteger(generation) ||
    publicationToken?.byteLength !== PROOF_TOKEN_BYTES ||
    (generation === 0
      ? currentRecord !== undefined
      : !currentRecord || Buffer.byteLength(currentRecord) > 1024)
  )
    return invalid();
  return {
    state: "ready",
    physicalRoot,
    hostIdentity,
    accountUid,
    realpathSha256,
    generation,
    publicationToken,
    ...(currentRecord === undefined ? {} : { currentRecord }),
  };
}

export function readWorkspaceModeInspection(bytes: Uint8Array): ProofWorkspaceModeInspection {
  let result: ProofWorkspaceModeInspection | undefined;
  decodeMessage(bytes, (number, wire, reader) => {
    if (result) return invalid();
    if (number === 1) result = readReady(bytesValue(wire, reader));
    else if (number === 2) {
      const reason = refusals.get(uintValue(wire, reader));
      if (!reason) return invalid();
      result = { state: "refused", reason };
    } else return invalid();
  });
  return result ?? invalid();
}

export function readWorkspaceModePublication(bytes: Uint8Array) {
  let status: number | undefined;
  decodeMessage(bytes, (number, wire, reader) => {
    if (number !== 1 || status !== undefined) return invalid();
    status = uintValue(wire, reader);
  });
  switch (status) {
    case 1:
      return { kind: "committed" } as const;
    case 2:
      return { kind: "conflict" } as const;
    case 3:
      return { kind: "uncertain" } as const;
    case 4:
      return { kind: "failed", reason: "missing-folder" } as const;
    case 5:
      return { kind: "failed", reason: "unsafe-storage" } as const;
    case 6:
      return { kind: "failed", reason: "refused" } as const;
    default:
      return invalid();
  }
}
