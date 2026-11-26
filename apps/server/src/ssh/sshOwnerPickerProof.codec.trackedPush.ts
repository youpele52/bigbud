import type { BoundedTrackedReceiveRequest } from "../git/Layers/GitCore.initiatingPush.composition.ts";
import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { invalid, PickerProofOwnerError, uintValue } from "./sshOwnerPickerProof.codec.wire.ts";

export type TrackedPushDestination = BoundedTrackedReceiveRequest["destinations"][number];
export type TrackedPushBinding = Omit<
  BoundedTrackedReceiveRequest,
  "destinations" | "timeoutMs"
> & {
  readonly destination: TrackedPushDestination;
};
export type TrackedPushStartup = Omit<TrackedPushBinding, "destination"> & {
  readonly fixtureRoot: string;
  readonly destination: Omit<TrackedPushDestination, "targetGeneration">;
};
export type ProofTrackedPushOperation = TrackedPushBinding & {
  readonly kind: "proofGitTrackedPush";
  readonly timeoutMs: number;
};
export type ProofTrackedPushStatus =
  | "deniedBeforeDispatch"
  | "accepted"
  | "unchanged"
  | "rejected"
  | "unconfirmed";

function token(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new PickerProofOwnerError("invalidOperands");
  return Buffer.from(value, "hex");
}

export function trackedPushStartupArgs(input: TrackedPushStartup): string[] {
  const { fixtureRoot, repository, destination, refs } = input;
  const client = `${fixtureRoot}/client`;
  if (
    !/^\/tmp\/bigbud-picker-linux-[A-Za-z0-9]{1,64}$/.test(fixtureRoot) ||
    input.direction !== "push" ||
    repository.worktree !== client ||
    repository.gitDir !== `${client}/.git` ||
    repository.commonDir !== repository.gitDir ||
    input.remoteName !== "origin" ||
    refs.source !== "refs/heads/main" ||
    refs.destination !== refs.source ||
    destination.host !== "127.0.0.1" ||
    destination.user !== "picker" ||
    destination.port !== 22222 ||
    destination.repositoryPath !== "/receive.git" ||
    destination.effectiveUrl !== "ssh://picker@127.0.0.1:22222/receive.git" ||
    !destination.executionTargetId.startsWith("ssh:") ||
    Buffer.byteLength(destination.executionTargetId) > 1024 ||
    !/^[a-f0-9]{40}$/.test(input.sourceOid) ||
    !/^[a-f0-9]{40}$/.test(destination.expectedOldOid)
  )
    throw new PickerProofOwnerError("invalidOperands");
  return [
    "--git-tracked-push-fixture",
    fixtureRoot,
    destination.executionTargetId,
    input.sourceOid,
    destination.expectedOldOid,
  ];
}

export function writeProofTrackedPush(writer: WireWriter, input: ProofTrackedPushOperation) {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000)
    throw new PickerProofOwnerError("invalidOperands");
  const { repository, destination } = input;
  const paths = new WireWriter();
  paths.fieldString(1, repository.worktree);
  paths.fieldString(2, repository.gitDir);
  paths.fieldString(3, repository.commonDir);
  const target = new WireWriter();
  target.fieldString(1, destination.effectiveUrl);
  target.fieldString(2, destination.executionTargetId);
  target.fieldBytes(3, token(destination.targetGeneration));
  target.fieldString(4, destination.host);
  target.fieldString(5, destination.user);
  target.fieldUint(6, destination.port);
  target.fieldString(7, destination.repositoryPath);
  target.fieldString(8, destination.expectedOldOid);
  writer.fieldRepeatedMessage(1, paths.finish());
  writer.fieldString(2, input.remoteName);
  writer.fieldString(3, input.refs.source);
  writer.fieldString(4, input.refs.destination);
  writer.fieldString(5, input.sourceOid);
  writer.fieldRepeatedMessage(6, target.finish());
  writer.fieldUint(7, input.timeoutMs);
}

const outcomes: readonly ProofTrackedPushStatus[] = [
  "deniedBeforeDispatch",
  "accepted",
  "unchanged",
  "rejected",
  "unconfirmed",
];
export function readProofTrackedPushStatus(bytes: Uint8Array): ProofTrackedPushStatus {
  let status: number | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field !== 1 || status !== undefined) return invalid();
    status = uintValue(wire, reader);
  });
  return (status === undefined ? undefined : outcomes[status - 1]) ?? invalid();
}
