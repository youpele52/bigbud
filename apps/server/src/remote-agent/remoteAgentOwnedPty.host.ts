/**
 * Host features of one owned PTY (plan §8.7, §9.1). A protocol 1.9 connection advertises screen
 * and lifecycle support for the whole host, but only a PTY created with lifecycle fields has a
 * screen model and lifecycle state; any other PTY on that host (created with the terminal host
 * off, or by an older client) has neither, and its screen copy is refused (`SCREEN_UNAVAILABLE`).
 * So a PTY reports host capabilities only for what its create asked for, recorded durably in the
 * owner row, and the manager treats every other PTY exactly as before: no host state, never
 * restorable, no screen fetch, plain live output.
 *
 * @module remoteAgentOwnedPty.host
 */
import type { PtyHostCapabilities, PtyProcess } from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";
import type { RemoteAgentPtyCreateLifecycleFields } from "./remoteAgentProtocol.ptyLifecycle.ts";
import type { RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import { remoteAgentPtyHostWide } from "./remoteAgentPtyClient.hostWide.ts";
import {
  remoteAgentPtyCreateLifecycleFields,
  type RemoteAgentPtyCreateDefaults,
} from "./remoteAgentPtyClient.lifecycle.ts";

export type RemoteAgentPtyHostFeatures = NonNullable<RemoteAgentOwner["hostFeatures"]>;

const NO_FEATURES: RemoteAgentPtyHostFeatures = { screen: false, lifecycle: false };

/** Any lifecycle field makes the host build per-PTY lifecycle state with a screen model. */
export function remoteAgentPtyHostFeatures(
  sent: RemoteAgentPtyCreateLifecycleFields,
): RemoteAgentPtyHostFeatures {
  const any = Object.values(sent).some((value) => value !== undefined && value !== false);
  return any ? { screen: true, lifecycle: true } : NO_FEATURES;
}

/**
 * A recovered PTY's features: from its owner row, or, for a row written before the field existed,
 * what this creator would have sent over the connection (local host PTYs always asked for them).
 */
export function recoveredRemoteAgentPtyHostFeatures(
  owner: RemoteAgentOwner,
  connection: Pick<RemoteAgentConnection, "supportsCapability">,
  defaults: RemoteAgentPtyCreateDefaults | undefined,
): RemoteAgentPtyHostFeatures {
  return (
    owner.hostFeatures ??
    remoteAgentPtyHostFeatures(remoteAgentPtyCreateLifecycleFields(connection, defaults ?? {}))
  );
}

/** The connection's capabilities, limited to what this PTY has. */
function maskedCapabilities(
  capabilities: PtyHostCapabilities,
  features: RemoteAgentPtyHostFeatures,
): PtyHostCapabilities {
  return {
    ...capabilities,
    screen: capabilities.screen && features.screen,
    // The query responder lives in the PTY's lifecycle state.
    queryResponder: capabilities.queryResponder && features.lifecycle,
    lifecycle: capabilities.lifecycle && features.lifecycle,
    spool: capabilities.spool && features.lifecycle,
  };
}

/** Sequenced output, screen copies and lifecycle controls of one owned PTY. */
export function remoteAgentOwnedPtyHostControls(
  process: RemoteAgentPtyProcess,
  features: RemoteAgentPtyHostFeatures,
  remoteHostControls: boolean | undefined,
): Pick<PtyProcess, "onSequencedData" | "screen" | "lifecycle"> {
  const capabilities = () => maskedCapabilities(process.lifecycle.capabilities(), features);
  const hostWide =
    remoteHostControls && features.lifecycle
      ? remoteAgentPtyHostWide(() => process.lifecycle.currentConnection())
      : undefined;
  return {
    onSequencedData: (callback) => process.onSequencedData(callback),
    screen: {
      capabilities,
      snapshot: (snapshotInput) => process.screenSnapshot(snapshotInput),
    },
    lifecycle: {
      capabilities,
      get evictedPtyId() {
        return process.lifecycle.evictedPtyId;
      },
      setViewState: (state, signal) => process.lifecycle.setViewState(state, signal),
      keepOpen: (signal) => process.lifecycle.keepOpen(signal),
      onActivity: (callback) => process.lifecycle.onActivity(callback),
      onNotice: (callback) => process.lifecycle.onNotice(callback),
      ...(hostWide ? { hostWide } : {}),
    },
  };
}
