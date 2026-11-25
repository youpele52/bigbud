import {
  validateProofStageScope,
  type ProofDeploymentStageScope,
} from "./sshOwnerPickerProof.codec.deployment.ts";
import {
  validateProofGitAdvertisement,
  validateProofGitUpload,
  type PickerProofGitUploadFixture,
  validateProofPeerFixture,
  type PickerProofGitAdvertisementFixture,
  type PickerProofPeerFixture,
} from "./sshOwnerPickerProof.codec.scopedDuplex.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import {
  trackedPushStartupArgs,
  type TrackedPushStartup,
} from "./sshOwnerPickerProof.codec.trackedPush.ts";

export interface ScopedProofStartupOptions {
  readonly peerRelayFixture?: PickerProofPeerFixture;
  readonly gitAdvertisementFixture?: PickerProofGitAdvertisementFixture;
  readonly gitUploadFixture?: PickerProofGitUploadFixture;
  readonly trackedPushFixture?: TrackedPushStartup;
  readonly posixPickerMaster?: true;
  readonly posixPickerCancellation?: true;
  readonly posixWorkspaceSnapshotCancellation?: true;
  readonly posixMuxPickerCancellation?: true;
  readonly posixSyntheticPasswordFixture?: true;
  readonly deploymentStageFixture?: ProofDeploymentStageScope & { readonly root: string };
}

export function scopedProofStartup(options: ScopedProofStartupOptions) {
  const peer = options.peerRelayFixture && validateProofPeerFixture(options.peerRelayFixture);
  const git =
    options.gitAdvertisementFixture &&
    validateProofGitAdvertisement(options.gitAdvertisementFixture);
  const stage =
    options.deploymentStageFixture && validateProofStageScope(options.deploymentStageFixture);
  const gitUpload = options.gitUploadFixture && validateProofGitUpload(options.gitUploadFixture);
  const pickerCancellation =
    options.posixPickerCancellation === true ||
    options.posixMuxPickerCancellation === true ||
    options.posixWorkspaceSnapshotCancellation === true;
  const count =
    Number(Boolean(peer)) +
    Number(Boolean(git)) +
    Number(Boolean(gitUpload)) +
    Number(Boolean(stage)) +
    Number(options.trackedPushFixture !== undefined) +
    Number(options.posixPickerMaster === true) +
    Number(options.posixPickerCancellation === true) +
    Number(options.posixWorkspaceSnapshotCancellation === true) +
    Number(options.posixMuxPickerCancellation === true) +
    Number(options.posixSyntheticPasswordFixture === true);
  if (
    count > 1 ||
    ((git || gitUpload || stage || options.trackedPushFixture) && process.platform !== "linux") ||
    ((options.posixPickerMaster === true || options.posixPickerCancellation === true) &&
      process.platform !== "darwin") ||
    (options.posixWorkspaceSnapshotCancellation === true &&
      process.platform !== "darwin" &&
      !(process.platform === "linux" && process.arch === "arm64")) ||
    // The owned mux lane is also ported to the private Linux fixture.
    (options.posixMuxPickerCancellation === true &&
      process.platform !== "darwin" &&
      process.platform !== "linux") ||
    (options.posixSyntheticPasswordFixture === true && process.platform !== "linux") ||
    (peer && process.platform !== "linux" && process.platform !== "darwin")
  )
    throw new PickerProofOwnerError("invalidOperands");
  const args: string[] = options.trackedPushFixture
    ? trackedPushStartupArgs(options.trackedPushFixture)
    : [];
  if (options.posixPickerMaster) args.push("--posix-picker-master");
  if (options.posixPickerCancellation) args.push("--posix-cancellable-picker");
  if (options.posixWorkspaceSnapshotCancellation)
    args.push("--posix-cancellable-workspace-snapshot");
  if (options.posixMuxPickerCancellation) args.push("--posix-cancellable-mux-picker");
  if (options.posixSyntheticPasswordFixture) args.push("--posix-synthetic-password-picker");
  if (peer)
    args.push(
      "--paired-peer-fixture",
      peer.pairingId,
      peer.grantId,
      peer.workerAuthorityId,
      peer.hostKeyFingerprint,
      peer.coordinatorKeyFingerprint,
    );
  if (git)
    args.push(
      "--git-advertisement-fixture",
      git.repositoryPath,
      git.sourceRef,
      git.destinationRef,
      git.sourceOid,
    );
  if (gitUpload) args.push("--git-upload-fixture", gitUpload.repositoryPath);
  if (stage && options.deploymentStageFixture) {
    const { root } = options.deploymentStageFixture;
    if (!/^\/tmp\/bigbud-picker-linux-[A-Za-z0-9]{1,64}\/deployment-graphs$/.test(root))
      throw new PickerProofOwnerError("invalidOperands");
    args.push(
      "--deployment-stage-fixture",
      root,
      stage.requestId,
      stage.installName,
      stage.archiveSha256,
      stage.manifestSha256,
    );
  }
  return { peer, git, gitUpload, stage, pickerCancellation, args };
}
