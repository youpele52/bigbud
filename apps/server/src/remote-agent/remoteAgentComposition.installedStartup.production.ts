import { detectInstalledProxyBinding } from "./remoteAgentComposition.installedAdmission.ts";
import { observeOwnedInstalledSupervisor } from "./remoteAgentComposition.installedObservation.ts";
import {
  composeInstalledRemoteAgentStartup,
  type InstalledStartupComposition,
} from "./remoteAgentComposition.installedStartup.ts";
import { makeProductionRemoteAgentProxyOwner } from "./remoteAgentConnection.owner.production.ts";
import type { RemoteAgentOwnerControlDependencies } from "./remoteAgentControl.owner.ts";
import { isRemoteAgentExecutionTarget } from "./remoteAgentDefault.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import { readRemoteAgentRegistryReadOnly } from "./remoteAgentReadOnlyStatus.ts";

/** Boot waits this long for the production owner to register before it composes anything. */
const OWNER_WAIT_MS = 60_000;
const OWNER_POLL_MS = 250;
const MAX_TARGETS = 64;

/**
 * One poll interval. The timer is unref'd and cleared on abort, so waiting for an owner that
 * never registers can never keep a shutting-down (or drained) backend process alive.
 */
function pollDelay(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, OWNER_POLL_MS);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * U25 normal startup under production activation (decision (a)): the trusted installed binding
 * for each known target is the local owner store's bound runtime and expected epoch, never a
 * registry snapshot or project metadata. Each one is observed through one owner proxy lease
 * (pinned hello, identity and epoch), and only when the read-only registry already admits the
 * build; an observation failure for an admitted build is a sticky typed refusal, as designed.
 * A target without a stored binding is left to the ordinary pool path; nothing is installed,
 * prepared or launched here.
 */
export async function composeProductionInstalledStartups(input: {
  readonly selection: RemoteAgentOwnerControlDependencies;
  readonly owners: RemoteAgentOwnerStore;
  readonly readRegistry?: typeof readRemoteAgentRegistryReadOnly;
  readonly ownerWaitMs?: number;
  /** Tests only: the observation and target filter; production uses the owner proxy. */
  readonly observe?: typeof observeOwnedInstalledSupervisor;
  readonly isRemoteTarget?: (target: string) => boolean;
  /** Aborted when the boot scope closes (shutdown or drain): the wait and composition stop. */
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, InstalledStartupComposition>> {
  const results = new Map<string, InstalledStartupComposition>();
  const deadline = Date.now() + (input.ownerWaitMs ?? OWNER_WAIT_MS);
  // An unregistered owner is not an observation failure: never record a sticky refusal for it.
  while (!input.selection.owner()) {
    if (Date.now() > deadline || input.signal?.aborted) return results;
    await pollDelay(input.signal);
  }
  const readRegistry = input.readRegistry ?? readRemoteAgentRegistryReadOnly;
  const proxyOwner = makeProductionRemoteAgentProxyOwner(input.selection);
  const targets = ((await input.owners.knownTargets?.()) ?? []).slice(0, MAX_TARGETS);
  for (const target of targets) {
    if (input.signal?.aborted) return results;
    if (!(input.isRemoteTarget ?? isRemoteAgentExecutionTarget)(target)) continue;
    const binding = await input.owners.getBinding(target).catch(() => undefined);
    if (!binding) continue;
    // An unreadable host or an unadmitted registry composes nothing and records no refusal;
    // the ordinary pool path (also owner-only) still serves the target.
    const registry = await readRegistry(target).catch(() => null);
    const admitted = detectInstalledProxyBinding(target, registry);
    if (admitted.kind !== "denied" || admitted.reason !== "observation-required") continue;
    results.set(
      target,
      await composeInstalledRemoteAgentStartup({
        executionTargetId: target,
        runtime: binding.runtime,
        expectedEpoch: binding.expectedEpoch,
        owner: proxyOwner,
        registry,
        observe: (observed) =>
          (input.observe ?? observeOwnedInstalledSupervisor)({ ...observed, owner: proxyOwner }),
      }),
    );
  }
  return results;
}
