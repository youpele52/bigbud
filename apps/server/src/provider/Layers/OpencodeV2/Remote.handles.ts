import type { RemoteAgentWorkspaceClient } from "../../../remote-agent/remoteAgentWorkspaceClient.ts";

const handles = new WeakMap<object, Map<string, Promise<void>>>();

/** Agent v1 has no handle-close RPC: reuse exact-owner roots on the SAME connection, never reopen/rebind captured roots. */
export async function acquireV2RemoteHandle(
  client: RemoteAgentWorkspaceClient,
  handle: string,
  root: string,
) {
  let owned = handles.get(client.connection);
  if (!owned) {
    owned = new Map();
    handles.set(client.connection, owned);
  }
  const retained = owned.get(handle);
  if (retained) return retained;
  if (owned.size >= 64)
    throw new Error(
      "V2 remote workspace handle capacity reached; agent v1 has no workspace-close capability. No automatic connection restart or captured-root eviction.",
    );
  const open = client.openWorkspace(handle, root).then(() => {});
  owned.set(handle, open);
  // Failed/uncertain opens stay reserved: no automatic rebind after an unacknowledged remote open.
  return open;
}
