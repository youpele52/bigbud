import { copyPickerProofSessionOptions } from "./sshOwnerPickerProof.client.options.ts";
import {
  openPickerProofSession,
  type PickerProofOwner,
  type PickerProofSessionOptions,
} from "./sshOwnerPickerProof.client.session.ts";
import { encodeHello, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";
import { spawnWindowsPickerProofPipe } from "./sshOwnerPickerProof.pipe.windows.ts";

export interface WindowsPickerProofOwnerOptions extends PickerProofSessionOptions {
  /** Trusted startup-resolved owner executable, never supplied by an operation. */
  readonly binary: string;
  /** Stable path under the launcher's private, disposable profile directory. */
  readonly lockFile: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
}

export type WindowsPickerProofOwner = Pick<
  PickerProofOwner,
  | "ownerEpoch"
  | "inspectTrust"
  | "approveTrust"
  | "listRemoteFolders"
  | "listAliases"
  | "connect"
  | "disconnect"
  | "close"
>;

const isDriveAbsolute = (path: string) => /^[A-Za-z]:[\\/].+/.test(path) && !path.includes("\0");

/** Private proof only: fixed loopback, no attachment, and no alternative launch path. */
export async function startWindowsPickerProofOwner(
  options: WindowsPickerProofOwnerOptions,
): Promise<WindowsPickerProofOwner> {
  const { binary, lockFile, port, user, identityFile, knownHostsFile } = options;
  const session = copyPickerProofSessionOptions(options);
  const targetId = session.targetId;
  if (
    targetId === undefined ||
    ![binary, lockFile, identityFile, knownHostsFile].every(isDriveAbsolute) ||
    targetId.includes("\0") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    user.length > 64 ||
    !/^[A-Za-z0-9]/.test(user) ||
    /[^A-Za-z0-9_.-]/.test(user)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }

  const pipe = spawnWindowsPickerProofPipe(binary, [
    session.profileBinding.toString("hex"),
    targetId,
    lockFile,
    String(port),
    user,
    identityFile,
    knownHostsFile,
  ]);
  const { owner } = await openPickerProofSession(pipe, session, () =>
    pipe.exchange(encodeHello(session.profileBinding, session.major)),
  );
  return {
    get ownerEpoch() {
      return owner.ownerEpoch;
    },
    inspectTrust: owner.inspectTrust,
    approveTrust: owner.approveTrust,
    listRemoteFolders: owner.listRemoteFolders,
    listAliases: owner.listAliases,
    connect: owner.connect,
    disconnect: owner.disconnect,
    close: owner.close,
  };
}
