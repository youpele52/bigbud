import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  writeProofProviderScope,
  type ProofProviderScope,
} from "./sshOwnerPickerProof.codec.provider.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

export type ProofOpencodeServiceScope = {
  readonly threadId: string;
  readonly sessionEpoch: number;
  readonly cwd: string;
};

export type ProofOpencodeOperation =
  | ({ readonly kind: "proofOpencodeOpen"; readonly lease: Uint8Array } & ProofProviderScope)
  | {
      readonly kind: "proofOpencodeOpen";
      readonly lease: Uint8Array;
      readonly serviceScope: ProofOpencodeServiceScope;
    }
  | { readonly kind: "proofOpencodeStatus" | "proofOpencodeClose"; readonly lease: Uint8Array };

export type ProofOpencodeState = { readonly lease: Uint8Array } & (
  | { readonly phase: "starting" | "closing" | "closed" | "lost" | "unconfirmed" | "rejected" }
  | { readonly phase: "ready"; readonly localPort: number }
  | { readonly phase: "exited"; readonly exitCode: number }
);

export function writeProofOpencode(writer: WireWriter, operation: ProofOpencodeOperation) {
  if (operation.lease.length !== PROOF_TOKEN_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  const operands = new WireWriter();
  if (operation.kind === "proofOpencodeOpen") {
    if ("serviceScope" in operation) {
      const scope = new WireWriter();
      scope.fieldString(1, operation.serviceScope.threadId);
      scope.fieldUint(2, operation.serviceScope.sessionEpoch);
      scope.fieldString(3, operation.serviceScope.cwd);
      operands.fieldRepeatedMessage(3, scope.finish());
    } else {
      const scope = new WireWriter();
      writeProofProviderScope(scope, operation);
      operands.fieldRepeatedMessage(1, scope.finish());
    }
    operands.fieldBytes(2, operation.lease);
    writer.fieldRepeatedMessage(50, operands.finish());
  } else {
    operands.fieldBytes(1, operation.lease);
    writer.fieldRepeatedMessage(
      operation.kind === "proofOpencodeStatus" ? 51 : 52,
      operands.finish(),
    );
  }
}

export function readProofOpencode(bytes: Uint8Array): ProofOpencodeState {
  let lease: Uint8Array | undefined;
  let phase: number | undefined;
  let localPort: number | undefined;
  let exitCode: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && phase === undefined) phase = uintValue(wire, reader);
    else if (field === 3 && localPort === undefined) localPort = uintValue(wire, reader);
    else if (field === 4 && exitCode === undefined) exitCode = uintValue(wire, reader);
    else return invalid();
  });
  if (lease?.length !== PROOF_TOKEN_BYTES) return invalid();
  if (
    phase === 2 &&
    localPort !== undefined &&
    localPort > 0 &&
    localPort <= 65535 &&
    exitCode === undefined
  )
    return { lease, phase: "ready", localPort };
  if (phase === 7 && exitCode !== undefined && exitCode <= 254 && localPort === undefined)
    return { lease, phase: "exited", exitCode };
  if (localPort !== undefined || exitCode !== undefined) return invalid();
  switch (phase) {
    case 1:
      return { lease, phase: "starting" };
    case 3:
      return { lease, phase: "closing" };
    case 4:
      return { lease, phase: "closed" };
    case 5:
      return { lease, phase: "lost" };
    case 6:
      return { lease, phase: "unconfirmed" };
    case 8:
      return { lease, phase: "rejected" };
    default:
      return invalid();
  }
}
