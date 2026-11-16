import { remoteClientSocketPath } from "../startup/config.remote.ts";
import { preparePrivateRemoteSocket } from "./privateSocket.ts";

/** Keep the established client path and preflight while sharing inode-safe socket ownership. */
export function prepareRemoteClientSocket(stateDir: string, assertHeld: () => Promise<void>) {
  remoteClientSocketPath(stateDir);
  return preparePrivateRemoteSocket(stateDir, assertHeld, "client");
}
