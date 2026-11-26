/**
 * Host-wide lifecycle controls of a remote-agent host, reached through one PTY's current
 * connection (plan §7.2, §8.7, §14). Remote hosts have no generation registry like the local
 * host, so the server drives each remote host over the connection its terminals already use:
 * the policy push, quit close-all and host-wide notices. Every request is feature-detected, so an
 * agent before protocol 1.9 never sees an unknown frame.
 *
 * @module remoteAgentPtyClient.hostWide
 */
import type { PtyHostWideControl } from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  makeRemoteAgentHostControls,
  subscribeRemoteAgentLifecycleEvents,
} from "./remoteAgentPtyClient.lifecycle.ts";

type Connection = Pick<RemoteAgentConnection, "supportsCapability" | "request" | "onFrame">;

const connectionIds = new WeakMap<object, number>();
let nextConnectionId = 0;

/** A process-unique id per connection object; a reconnect yields a new connection and key. */
export function remoteAgentConnectionKey(connection: object): string {
  let id = connectionIds.get(connection);
  if (id === undefined) {
    id = ++nextConnectionId;
    connectionIds.set(connection, id);
  }
  return `remote-connection-${id}`;
}

export function remoteAgentPtyHostWide(connection: () => Connection): PtyHostWideControl {
  const controls = makeRemoteAgentHostControls(async () => connection());
  return {
    connectionKey: () => remoteAgentConnectionKey(connection()),
    updatePolicy: controls.updatePolicy,
    closeAll: controls.closeAll,
    subscribe: async (listener) => subscribeRemoteAgentLifecycleEvents(connection(), listener),
  };
}
