import type {
  RemoteAgentConnectionPool,
  RemoteAgentRuntimeBinding,
} from "../remote-agent/remoteAgentConnectionPool.ts";
import type { TerminalHostPane } from "../remote-agent/remoteAgentProtocol.terminalHost.ts";
import {
  inventoryLocalTerminalHost,
  retireLocalTerminalHostSshSpawn,
  TerminalHostRetirementError,
} from "./localTerminalHost.retirement.ts";

/**
 * The B-side view of every attached X2 terminal-host generation, for the W3.6
 * explicit drain (cutover §c step 3). The adapter registers its controller and
 * pool here; the drain lists managed SSH panes through the `inventory` verb and
 * retires them through `retireSshSpawn`. A host without the
 * `terminal.host-retirement` capability throws
 * `TerminalHostRetirementUnsupportedError`: B then requires that host to exit,
 * and the drain never writes the marker past it.
 *
 * @module localTerminalHost.retirementSource
 */

export interface LocalTerminalHostRetirementSource {
  readonly attachedBindings: () => Promise<
    ReadonlyArray<{ readonly binding: RemoteAgentRuntimeBinding }>
  >;
  readonly pool: Pick<RemoteAgentConnectionPool, "getBound">;
}

export interface LegacyHostSshPane {
  /** `connectionId:leaseId`, stable across a list and the retire that follows it. */
  readonly identity: string;
  readonly leaseId: string;
  readonly threadId: string;
  readonly paneId: string;
  readonly binding: RemoteAgentRuntimeBinding;
}

let source: LocalTerminalHostRetirementSource | undefined;

/** Registered by the local host adapter; the returned function unregisters it. */
export function registerLocalTerminalHostRetirementSource(
  next: LocalTerminalHostRetirementSource,
): () => void {
  source = next;
  return () => {
    if (source === next) source = undefined;
  };
}

const keyOf = (binding: RemoteAgentRuntimeBinding) =>
  binding.connectionId ?? binding.runtime.generation;

const isSshPane = (pane: TerminalHostPane) => pane.kind === "managed-ssh";

/** Lists managed SSH panes on every attached generation. No host attached means none. */
export async function listLegacyHostSshPanes(
  current: LocalTerminalHostRetirementSource | undefined = source,
): Promise<ReadonlyArray<LegacyHostSshPane>> {
  if (!current) return [];
  const panes: LegacyHostSshPane[] = [];
  for (const { binding } of await current.attachedBindings()) {
    const inventory = await inventoryLocalTerminalHost({ pool: current.pool, binding });
    if (inventory.truncated)
      throw new TerminalHostRetirementError(
        "terminalHostInventoryInvalid",
        "The terminal host has more panes than one inventory page; drain cannot see them all.",
      );
    for (const pane of inventory.panes.filter(isSshPane))
      panes.push({
        identity: `${keyOf(binding)}:${pane.leaseId}`,
        leaseId: pane.leaseId,
        threadId: pane.threadId,
        paneId: pane.paneId,
        binding,
      });
  }
  return panes;
}

/** Retires SSH spawn for the listed leases, one acknowledged request per generation. */
export async function retireLegacyHostSshPanes(
  panes: ReadonlyArray<LegacyHostSshPane>,
  current: LocalTerminalHostRetirementSource | undefined = source,
): Promise<void> {
  if (panes.length === 0) return;
  if (!current)
    throw new TerminalHostRetirementError(
      "terminalHostVerbRefused",
      "The terminal host that owned these panes is no longer attached.",
    );
  const byGeneration = new Map<string, LegacyHostSshPane[]>();
  for (const pane of panes) {
    const key = keyOf(pane.binding);
    byGeneration.set(key, [...(byGeneration.get(key) ?? []), pane]);
  }
  for (const group of byGeneration.values())
    await retireLocalTerminalHostSshSpawn({
      pool: current.pool,
      binding: group[0]!.binding,
      leaseIds: group.map((pane) => pane.leaseId),
    });
}

/** Test-only reset. */
export function resetLocalTerminalHostRetirementSourceForTest(): void {
  source = undefined;
}
