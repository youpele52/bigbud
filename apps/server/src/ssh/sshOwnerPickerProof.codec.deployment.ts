import { MAX_PROOF_MANIFEST_BYTES } from "../remote-backend/deployment.ssh.owner.manifest.ts";
import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { DEPLOYMENT_REQUEST_ID } from "../remote-backend/deployment.types.ts";
import {
  bytesValue,
  invalid,
  PickerProofOwnerError,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

export interface ProofDeploymentProbeOperation {
  readonly kind: "proofDeploymentHostProbe";
  readonly deploymentRequestId: string;
}

export interface ProofDeploymentCompletionOperation {
  readonly kind: "proofDeploymentCompletion";
  readonly deploymentRequestId: string;
  readonly authorityId: string;
}

export interface ProofDeploymentStageScope {
  readonly requestId: string;
  readonly installName: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
}

export type ProofDeploymentStageOperation = ProofDeploymentStageScope & {
  readonly kind: "proofDeploymentStageBegin";
};

export function validateProofStageScope({
  requestId,
  installName,
  archiveSha256,
  manifestSha256,
}: ProofDeploymentStageScope): ProofDeploymentStageScope {
  const name =
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}-(?:aarch64|x86_64)-unknown-linux-(?:gnu|musl)-([0-9a-f]{16})$/.exec(
      installName,
    );
  if (
    !DEPLOYMENT_REQUEST_ID.test(requestId) ||
    !/^[a-f0-9]{64}$/.test(archiveSha256) ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    !name ||
    name[1] !== archiveSha256.slice(0, 16)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return { requestId, installName, archiveSha256, manifestSha256 };
}

export function writeProofStageBegin(writer: WireWriter, input: ProofDeploymentStageScope) {
  const { requestId, installName, archiveSha256, manifestSha256 } = validateProofStageScope(input);
  writer.fieldString(1, requestId);
  writer.fieldString(2, installName);
  writer.fieldString(3, archiveSha256);
  writer.fieldString(4, manifestSha256);
}

export interface ProofDeploymentManifestOperation {
  readonly kind: "proofDeploymentManifestPut";
  readonly requestId: string;
  readonly manifestSha256: string;
  readonly contents: Uint8Array;
}

export function writeProofManifestPut(
  writer: WireWriter,
  operation: ProofDeploymentManifestOperation,
) {
  if (
    !DEPLOYMENT_REQUEST_ID.test(operation.requestId) ||
    !/^[a-f0-9]{64}$/.test(operation.manifestSha256) ||
    operation.contents.byteLength < 1 ||
    operation.contents.byteLength > MAX_PROOF_MANIFEST_BYTES
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writer.fieldString(1, operation.requestId);
  writer.fieldString(2, operation.manifestSha256);
  writer.fieldBytes(3, operation.contents);
}

export interface ProofDeploymentProbeResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Operation lifecycle for typed deployment steps; absent for a plain recipe exit. */
  readonly state?: ProofDeploymentOperationState;
}

/** Mirrors `ProofDeploymentOperationState`; the numbers are part of the wire contract. */
export const PROOF_DEPLOYMENT_OPERATION_STATE = {
  started: 1,
  completed: 2,
  cancelled: 3,
  outcomeUnknown: 4,
  refused: 5,
} as const;
export type ProofDeploymentOperationState = 1 | 2 | 3 | 4 | 5;

/** Mirrors `ProofDeploymentActionKind`; the numbers are part of the wire contract. */
export const PROOF_DEPLOYMENT_ACTION_KIND = {
  archiveUpload: 1,
  reset: 2,
  fetch: 3,
  publish: 4,
  start: 5,
  cancel: 6,
  reattach: 7,
} as const;

/** Bounded proof artifact bytes; the production transfer bound is set by its own track. */
export const MAX_PROOF_ARCHIVE_BYTES = 48 * 1024;
export const MAX_PROOF_DEPLOYMENT_PINS = 16;
const MAX_FETCH_BYTES = 2 * 1024 ** 3;
const GRAPH_RELATIVE_PATH = /^[A-Za-z0-9._+-]{1,255}(?:\/[A-Za-z0-9._+-]{1,255}){0,16}$/;
const PINNED_URL = /^https:\/\/[A-Za-z0-9._~:/?#@!*+,;=%()[\]-]{1,2048}$/;
const AUTHORITY = /^[a-f0-9]{32}$/;

export interface ProofDeploymentPinnedFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ProofDeploymentActionOperation {
  readonly kind: "proofDeploymentAction";
  readonly requestId: string;
  readonly action: keyof typeof PROOF_DEPLOYMENT_ACTION_KIND;
  readonly installName?: string;
  readonly archiveSha256?: string;
  readonly manifestSha256?: string;
  readonly url?: string;
  readonly maxBytes?: number;
  readonly contents?: Uint8Array;
  readonly authorityId?: string;
  readonly enableBoot?: boolean;
  readonly nodePath?: string;
  readonly entryPath?: string;
  readonly pins?: ReadonlyArray<ProofDeploymentPinnedFile>;
}

function validateGraphPath(value: string | undefined): string {
  if (!value || !GRAPH_RELATIVE_PATH.test(value) || value.split("/").includes(".."))
    throw new PickerProofOwnerError("invalidOperands");
  return value;
}

function validateDeploymentAction(operation: ProofDeploymentActionOperation) {
  const { requestId } = operation;
  if (!DEPLOYMENT_REQUEST_ID.test(requestId)) throw new PickerProofOwnerError("invalidOperands");
  const digest = (value: string | undefined) => {
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new PickerProofOwnerError("invalidOperands");
    return value;
  };
  switch (operation.action) {
    case "archiveUpload": {
      const contents = operation.contents;
      if (
        !digest(operation.archiveSha256) ||
        !contents ||
        contents.byteLength < 1 ||
        contents.byteLength > MAX_PROOF_ARCHIVE_BYTES
      )
        throw new PickerProofOwnerError("invalidOperands");
      return;
    }
    case "reset":
      digest(operation.archiveSha256);
      digest(operation.manifestSha256);
      if (!operation.installName) throw new PickerProofOwnerError("invalidOperands");
      return;
    case "fetch": {
      const maxBytes = operation.maxBytes;
      if (
        !digest(operation.archiveSha256) ||
        !operation.url ||
        !PINNED_URL.test(operation.url) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes === undefined ||
        maxBytes < 1 ||
        maxBytes > MAX_FETCH_BYTES
      )
        throw new PickerProofOwnerError("invalidOperands");
      return;
    }
    case "publish": {
      const pins = operation.pins;
      if (
        !operation.installName ||
        !digest(operation.archiveSha256) ||
        !digest(operation.manifestSha256) ||
        !pins ||
        pins.length < 1 ||
        pins.length > MAX_PROOF_DEPLOYMENT_PINS ||
        pins.some((pin) => !/^[a-f0-9]{64}$/.test(pin.sha256))
      )
        throw new PickerProofOwnerError("invalidOperands");
      for (const pin of pins) validateGraphPath(pin.path);
      validateGraphPath(operation.nodePath);
      validateGraphPath(operation.entryPath);
      return;
    }
    case "start":
      if (
        !operation.installName ||
        !operation.authorityId ||
        !AUTHORITY.test(operation.authorityId) ||
        typeof operation.enableBoot !== "boolean"
      )
        throw new PickerProofOwnerError("invalidOperands");
      validateGraphPath(operation.nodePath);
      validateGraphPath(operation.entryPath);
      return;
    case "cancel":
    case "reattach":
      return;
    default:
      throw new PickerProofOwnerError("invalidOperands");
  }
}

export function writeProofDeploymentAction(
  writer: WireWriter,
  operation: ProofDeploymentActionOperation,
) {
  validateDeploymentAction(operation);
  writer.fieldString(1, operation.requestId);
  writer.fieldUint(2, PROOF_DEPLOYMENT_ACTION_KIND[operation.action]);
  const string = (field: number, value: string | undefined) => {
    if (value !== undefined) writer.fieldString(field, value);
  };
  string(3, operation.installName);
  string(4, operation.archiveSha256);
  string(5, operation.manifestSha256);
  string(6, operation.url);
  if (operation.maxBytes !== undefined) writer.fieldUint(7, operation.maxBytes);
  if (operation.contents !== undefined) writer.fieldBytes(8, operation.contents);
  string(9, operation.authorityId);
  if (operation.enableBoot === true) writer.fieldUint(10, 1);
  string(11, operation.nodePath);
  string(12, operation.entryPath);
  for (const pin of operation.pins ?? []) {
    const message = new WireWriter();
    message.fieldString(1, pin.path);
    message.fieldString(2, pin.sha256);
    writer.fieldRepeatedMessage(13, message.finish());
  }
}

export function readDeploymentHostProbeResult(bytes: Uint8Array): ProofDeploymentProbeResult {
  let code: number | undefined;
  let stdout: string | undefined;
  let stderr: string | undefined;
  let state: ProofDeploymentOperationState | undefined;
  decodeMessage(bytes, (number, wire, reader) => {
    if (number === 1 && code === undefined) {
      code = uintValue(wire, reader);
      if (code >= 255) return invalid();
    } else if (number === 2 && stdout === undefined) {
      stdout = decodeOutput(bytesValue(wire, reader), 256 * 1024);
    } else if (number === 3 && stderr === undefined) {
      stderr = decodeOutput(bytesValue(wire, reader), 16 * 1024);
    } else if (number === 4 && state === undefined) {
      const value = uintValue(wire, reader);
      if (value < 1 || value > 5) return invalid();
      state = value as ProofDeploymentOperationState;
    } else return invalid();
  });
  if (code === undefined) return invalid();
  return {
    code,
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    ...(state === undefined ? {} : { state }),
  };
}

export function writeDeploymentHostProbe(
  writer: WireWriter,
  operation: ProofDeploymentProbeOperation | ProofDeploymentCompletionOperation,
) {
  if (!DEPLOYMENT_REQUEST_ID.test(operation.deploymentRequestId))
    throw new PickerProofOwnerError("invalidOperands");
  writer.fieldString(1, operation.deploymentRequestId);
  if (operation.kind === "proofDeploymentCompletion") {
    if (!/^[a-f0-9]{32}$/.test(operation.authorityId))
      throw new PickerProofOwnerError("invalidOperands");
    writer.fieldString(2, operation.authorityId);
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeOutput(bytes: Uint8Array, limit: number) {
  if (bytes.length > limit) return invalid();
  try {
    return decoder.decode(bytes);
  } catch {
    return invalid();
  }
}
