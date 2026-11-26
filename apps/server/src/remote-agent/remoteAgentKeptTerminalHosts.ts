/**
 * Remote hosts that still run this backend's managed terminals although no session holds one
 * (plan §14 "Quit"): terminals kept across a backend restart that no view reopened. Their durable
 * owners name the target. Each control resolves the pool's live connection when it is used, so
 * it follows reconnects and a quit or policy push never builds a composition or dials SSH; with
 * no live connection the control has no key and is skipped (the host's orphan timer applies).
 * Only with the terminal host enabled, like all remote lifecycle.
 *
 * @module remoteAgentKeptTerminalHosts
 */
import type { PtyHostWideControl } from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  isRemoteAgentExecutionTarget,
  liveConfiguredRemoteAgentConnection,
} from "./remoteAgentDefault.ts";
import {
  remoteAgentOwners,
  type RemoteAgentOwner,
  type RemoteAgentOwnerStore,
} from "./remoteAgentOwners.ts";
import { remoteAgentPtyHostWide } from "./remoteAgentPtyClient.hostWide.ts";
import { REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY } from "./remoteAgentProtocol.ptyLifecycle.ts";
import { remoteAgentTerminalLifecycleOptions } from "./remoteAgentTerminalLifecycle.ts";

const OWNER_PAGE = 100;
/** Bounds the owner scan per target (terminal rows are pruned to 256 per target). */
const MAX_OWNER_PAGES = 8;

export interface RemoteAgentKeptTerminalHostsDeps {
  readonly environment?: NodeJS.ProcessEnv;
  readonly owners?: () => RemoteAgentOwnerStore;
  readonly liveConnection?: (target: string) => RemoteAgentConnection | null;
  readonly isRemoteTarget?: (target: string) => boolean;
}

/** A live PTY this backend created with lifecycle fields: what `PtyCloseAll(managed_only)` closes. */
function isKeptManagedOwner(owner: RemoteAgentOwner): boolean {
  return owner.state !== "terminal" && owner.hostFeatures?.lifecycle !== false;
}

async function hasKeptManagedOwner(store: RemoteAgentOwnerStore, target: string) {
  if (!store.listTerminalOwners) return false;
  let cursor = "";
  for (let page = 0; page < MAX_OWNER_PAGES; page++) {
    const result = await store.listTerminalOwners(target, cursor, OWNER_PAGE);
    if (result.owners.some(isKeptManagedOwner)) return true;
    if (!result.nextCursor) return false;
    cursor = result.nextCursor;
  }
  return false;
}

/** One host-wide control per known remote target whose owners hold a live managed terminal. */
export async function remoteAgentKeptTerminalHosts(
  deps: RemoteAgentKeptTerminalHostsDeps = {},
): Promise<ReadonlyArray<PtyHostWideControl>> {
  if (!remoteAgentTerminalLifecycleOptions(deps.environment).remoteHostControls) return [];
  const liveConnection = deps.liveConnection ?? liveConfiguredRemoteAgentConnection;
  const isRemoteTarget = deps.isRemoteTarget ?? ((target) => isRemoteAgentExecutionTarget(target));
  try {
    const store = (deps.owners ?? remoteAgentOwners)();
    const controls: PtyHostWideControl[] = [];
    for (const target of (await store.knownTargets?.()) ?? []) {
      if (!isRemoteTarget(target) || !(await hasKeptManagedOwner(store, target))) continue;
      controls.push(
        remoteAgentPtyHostWide(() => {
          const connection = liveConnection(target);
          if (!connection?.supportsCapability(REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY))
            throw new Error(`No live lifecycle connection to ${target}.`);
          return connection;
        }),
      );
    }
    return controls;
  } catch {
    // An unreadable owner table proves nothing; each host's orphan timer still applies.
    return [];
  }
}
