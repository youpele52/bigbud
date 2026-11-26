import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { isExactRemotePath } from "./sshOwnerPickerProof.codec.gitUpload.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  PROOF_TOKEN_BYTES,
  stringValue,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W2 T-prov production Pi/Codex provider leases (Request 80–83, Reply 51–52). The owner
 * discovers the executable on the exact target and compiles the argv; the request names the
 * provider kind and the authorized session only.
 */
export type ProviderLeaseKind = "pi" | "codex";

export interface ProviderLeaseScope {
  readonly provider: ProviderLeaseKind;
  readonly threadId: string;
  readonly sessionEpoch: number;
  /** Absolute, normalized remote working directory; the target guard re-checks it. */
  readonly cwd: string;
  /** Codex start only: the owner-compiled default-mode question feature. */
  readonly defaultModeUserInput?: boolean;
  /** Pi only: resume file; the target admits it only beneath `~/.pi/agent/sessions`. */
  readonly sessionFile?: string;
  /** Codex only: `CODEX_HOME`; the target admits only a directory beneath the home. */
  readonly codexHome?: string;
}

export type ProviderLeaseOperation =
  | { readonly kind: "providerProbe"; readonly scope: ProviderLeaseScope }
  | {
      readonly kind: "providerLeaseOpen";
      readonly lease: Uint8Array;
      readonly scope: ProviderLeaseScope;
    }
  | { readonly kind: "providerLeaseStatus" | "providerLeaseClose"; readonly lease: Uint8Array };

export interface ProviderVersion {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProviderLeaseState = { readonly lease: Uint8Array } & (
  | {
      readonly phase: "listening";
      readonly stdioSocketPath: string;
      readonly stderrSocketPath: string;
    }
  | { readonly phase: "exited"; readonly exitCode: number }
  | { readonly phase: "running" | "closed" | "lost" | "rejected" | "unconfirmed" }
);

const KIND = { pi: 1, codex: 2 } as const;
const MAX_THREAD_BYTES = 128;

/** Mirrors the owner's operand check so a refusal never needs a round trip. */
export function providerLeaseScopeAdmits(scope: ProviderLeaseScope, probe: boolean): boolean {
  return (
    (scope.provider === "pi" || scope.provider === "codex") &&
    isExactRemotePath(scope.cwd) &&
    scope.cwd !== "/" &&
    scope.threadId.length > 0 &&
    scope.threadId.length <= MAX_THREAD_BYTES &&
    [...scope.threadId].every((char) => char >= "!" && char <= "~") &&
    Number.isSafeInteger(scope.sessionEpoch) &&
    scope.sessionEpoch >= 0 &&
    !(scope.defaultModeUserInput && (probe || scope.provider === "pi")) &&
    !(scope.sessionFile !== undefined && scope.provider !== "pi") &&
    !(scope.codexHome !== undefined && scope.provider !== "codex") &&
    [scope.sessionFile, scope.codexHome].every(
      (path) => path === undefined || (isExactRemotePath(path) && path !== "/"),
    )
  );
}

function writeScope(scope: ProviderLeaseScope, probe: boolean): Uint8Array {
  if (!providerLeaseScopeAdmits(scope, probe)) throw new PickerProofOwnerError("invalidOperands");
  const writer = new WireWriter();
  writer.fieldUint(1, KIND[scope.provider]);
  writer.fieldString(2, scope.threadId);
  writer.fieldUint(3, scope.sessionEpoch);
  writer.fieldString(4, scope.cwd);
  writer.fieldBool(5, scope.defaultModeUserInput === true);
  if (scope.sessionFile !== undefined) writer.fieldString(6, scope.sessionFile);
  if (scope.codexHome !== undefined) writer.fieldString(7, scope.codexHome);
  return writer.finish();
}

export function writeProviderLease(writer: WireWriter, operation: ProviderLeaseOperation) {
  const operands = new WireWriter();
  if (operation.kind === "providerProbe") {
    operands.fieldMessage(1, writeScope(operation.scope, true));
    writer.fieldRepeatedMessage(80, operands.finish());
    return;
  }
  if (operation.lease.length !== PROOF_TOKEN_BYTES)
    throw new PickerProofOwnerError("invalidOperands");
  operands.fieldBytes(1, operation.lease);
  if (operation.kind === "providerLeaseOpen") {
    operands.fieldMessage(2, writeScope(operation.scope, false));
    writer.fieldRepeatedMessage(81, operands.finish());
  } else {
    writer.fieldRepeatedMessage(
      operation.kind === "providerLeaseStatus" ? 82 : 83,
      operands.finish(),
    );
  }
}

export function readProviderVersion(bytes: Uint8Array): ProviderVersion {
  let code: number | undefined;
  let stdout: string | undefined;
  let stderr: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && code === undefined) code = uintValue(wire, reader);
    else if (field === 2 && stdout === undefined) stdout = stringValue(wire, reader);
    else if (field === 3 && stderr === undefined) stderr = stringValue(wire, reader);
    else return invalid();
  });
  const value = code ?? 0;
  if (value > 254) return invalid();
  return { code: value, stdout: stdout ?? "", stderr: stderr ?? "" };
}

const PHASES = {
  2: "running",
  4: "closed",
  5: "lost",
  6: "rejected",
  7: "unconfirmed",
} as const;

export function readProviderLeaseState(bytes: Uint8Array): ProviderLeaseState {
  let lease: Uint8Array | undefined;
  let phase: number | undefined;
  let stdioSocketPath: string | undefined;
  let stderrSocketPath: string | undefined;
  let exitCode: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1 && lease === undefined) lease = bytesValue(wire, reader);
    else if (field === 2 && phase === undefined) phase = uintValue(wire, reader);
    else if (field === 3 && stdioSocketPath === undefined)
      stdioSocketPath = stringValue(wire, reader);
    else if (field === 4 && stderrSocketPath === undefined)
      stderrSocketPath = stringValue(wire, reader);
    else if (field === 5 && exitCode === undefined) exitCode = uintValue(wire, reader);
    else return invalid();
  });
  if (lease?.length !== PROOF_TOKEN_BYTES) return invalid();
  const sockets = stdioSocketPath !== undefined || stderrSocketPath !== undefined;
  if (phase === 1 && stdioSocketPath !== undefined && stderrSocketPath !== undefined) {
    return exitCode === undefined &&
      stdioSocketPath !== stderrSocketPath &&
      isExactRemotePath(stdioSocketPath) &&
      isExactRemotePath(stderrSocketPath)
      ? { lease, phase: "listening", stdioSocketPath, stderrSocketPath }
      : invalid();
  }
  if (phase === 3 && exitCode !== undefined && exitCode <= 254 && !sockets)
    return { lease, phase: "exited", exitCode };
  if (sockets || exitCode !== undefined) return invalid();
  const named = phase === undefined ? undefined : PHASES[phase as keyof typeof PHASES];
  return named ? { lease, phase: named } : invalid();
}

export type ProviderLeaseOutcome =
  | { readonly kind: "providerVersion"; readonly value: ProviderVersion }
  | { readonly kind: "providerLease"; readonly value: ProviderLeaseState };

/** Reply 51 (probe) and 52 (lease state). */
export function readProviderLeaseOutcome(field: 51 | 52, bytes: Uint8Array): ProviderLeaseOutcome {
  return field === 51
    ? { kind: "providerVersion", value: readProviderVersion(bytes) }
    : { kind: "providerLease", value: readProviderLeaseState(bytes) };
}
