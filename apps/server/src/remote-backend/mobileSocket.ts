import { preparePrivateRemoteSocket, type PrivateRemoteSocketOptions } from "./privateSocket.ts";

/** Separate fixed endpoint for the Rust gateway; never reuse the client or callback listener. */
export function prepareRemoteMobileSocket(
  stateDir: string,
  assertHeld: () => Promise<void>,
  options?: PrivateRemoteSocketOptions,
) {
  return preparePrivateRemoteSocket(stateDir, assertHeld, "mobile", options);
}
