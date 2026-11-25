import { posix } from "node:path";
import type { WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

export interface ProofProviderScope {
  readonly threadId: string;
  readonly sessionEpoch: number;
  readonly cwd: string;
  readonly binaryPath: string;
  /** Pi resume only. The proof binding refuses it; the configured service bounds it. */
  readonly sessionFile?: string;
}

export type ProofProviderOpenOperation =
  | (ProofProviderScope & { readonly kind: "openProofCodex" })
  | (ProofProviderScope & { readonly kind: "openProofPi" });
export type ProofProviderProbeOperation =
  | (ProofProviderScope & { readonly kind: "probeProofCodex" })
  | (ProofProviderScope & { readonly kind: "probeProofPi" });

export interface PickerProofProviderFixture extends ProofProviderScope {
  readonly sha256: string;
}

function exactPath(value: string) {
  return (
    posix.isAbsolute(value) &&
    Buffer.byteLength(value) <= 4095 &&
    !value.includes("\0") &&
    value
      .slice(1)
      .split("/")
      .every((part) => part && part !== "." && part !== "..")
  );
}

export function copyProofProviderScope({
  threadId,
  sessionEpoch,
  cwd,
  binaryPath,
  sessionFile,
}: ProofProviderScope): ProofProviderScope {
  if (
    !threadId ||
    threadId.length > 128 ||
    [...threadId].some((byte) => byte < "!" || byte > "~") ||
    !Number.isSafeInteger(sessionEpoch) ||
    sessionEpoch < 0 ||
    !exactPath(cwd) ||
    !exactPath(binaryPath) ||
    (sessionFile !== undefined && !exactPath(sessionFile))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return {
    threadId,
    sessionEpoch,
    cwd,
    binaryPath,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  };
}

export function validateProofProviderFixture(
  fixture: PickerProofProviderFixture,
): PickerProofProviderFixture {
  if (!/^[a-f0-9]{64}$/.test(fixture.sha256)) throw new PickerProofOwnerError("invalidOperands");
  return { ...copyProofProviderScope(fixture), sha256: fixture.sha256 };
}

export function writeProofProviderScope(writer: WireWriter, operation: ProofProviderScope) {
  const scope = copyProofProviderScope(operation);
  writer.fieldString(1, scope.threadId);
  writer.fieldUint(2, scope.sessionEpoch);
  writer.fieldString(3, scope.cwd);
  writer.fieldString(4, scope.binaryPath);
  if (scope.sessionFile !== undefined) writer.fieldString(5, scope.sessionFile);
}
