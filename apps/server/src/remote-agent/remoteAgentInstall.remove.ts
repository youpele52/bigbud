import { runRemoteAgentControlOp } from "./remoteAgentControl.ops.ts";
import { randomUUID } from "node:crypto";

import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import {
  dropExpiredRemoteAgentRemovalFence,
  RemoteAgentRemovalInProgressError,
  renewRemoteAgentRemovalFence,
  withoutRemoteAgentRemovalFence,
  withRemoteAgentRemovalFence,
} from "./remoteAgentInstall.registry.removalFence.ts";
import {
  boundRemovalBlockers,
  readRemoteAgentBackendRuntimeBlockers,
  remoteAgentRemovalOwnerBlockers,
  remoteAgentRemovalRegistryBlockers,
  type RemoteAgentRemovalBlocker,
} from "./remoteAgentInstall.remove.blockers.ts";
import {
  isRemovableRemoteAgentRoot,
  parseRemoteAgentRemovalCommandResult,
} from "./remoteAgentInstall.remove.deletion.ts";
import { stopIdleRemoteAgentSupervisors } from "./remoteAgentInstall.remove.supervisors.ts";
import { remoteAgentOwners, type RemoteAgentOwner } from "./remoteAgentOwners.ts";

export type RemoteAgentRemovalResult =
  | { readonly outcome: "removed" }
  | { readonly outcome: "blocked"; readonly blockers: ReadonlyArray<RemoteAgentRemovalBlocker> };

export class RemoteAgentRemovalError extends Error {
  readonly _tag = "RemoteAgentRemovalError";

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "RemoteAgentRemovalError";
  }
}

export interface RemoteAgentTerminalOwnerList {
  readonly owners: ReadonlyArray<RemoteAgentOwner>;
  /** More owners exist than were read; removal must not assume none of them is live. */
  readonly truncated: boolean;
}

const MAX_TERMINAL_OWNER_PAGES = 10;
/** The deletion holds bounded locks, then renames and deletes the tree: allow a slow host. */
export const REMOTE_AGENT_REMOVAL_TIMEOUT_MS = 10 * 60 * 1000;

/** Terminal owners for the target from the local durable store; empty when unavailable. */
export async function listRemoteAgentTerminalOwners(
  target: string,
): Promise<RemoteAgentTerminalOwnerList> {
  let store;
  try {
    store = remoteAgentOwners();
  } catch {
    return { owners: [], truncated: false }; // The agent's own idle check still guards removal.
  }
  if (!store.listTerminalOwners) return { owners: [], truncated: false };
  const owners: RemoteAgentOwner[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_TERMINAL_OWNER_PAGES; page += 1) {
    const result = await store.listTerminalOwners(target, cursor, 100);
    owners.push(...result.owners);
    if (!result.nextCursor) return { owners, truncated: false };
    cursor = result.nextCursor;
  }
  return { owners, truncated: true };
}

function ownerBlockers(list: RemoteAgentTerminalOwnerList): RemoteAgentRemovalBlocker[] {
  return [
    ...remoteAgentRemovalOwnerBlockers(list.owners),
    ...(list.truncated
      ? [
          {
            kind: "terminal" as const,
            label: "More terminals than bigbud can check at once; close some and retry",
          },
        ]
      : []),
  ];
}

/** The host's clock in milliseconds; falls back to this controller's when it cannot be read. */
export async function readRemoteAgentHostClock(control: RemoteAgentControl): Promise<number> {
  const output = await runRemoteAgentControlOp(control, { kind: "hostClock" }).catch(() => "");
  const seconds = /^\d{1,12}$/.test(output.trim()) ? Number(output.trim()) : Number.NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : Date.now();
}

class RegistryBlocked extends Error {
  constructor(readonly blockers: RemoteAgentRemovalBlocker[]) {
    super("Registry work blocks removal.");
  }
}

/** CAS the removal fence in, re-checking registry work in the same transition. */
async function placeFence(
  control: RemoteAgentControl,
  id: string,
): Promise<RemoteAgentRemovalBlocker[]> {
  try {
    // Timed by the host's clock, like the store's own fence checks, never this controller's.
    const now = await readRemoteAgentHostClock(control);
    await control.registry.update((state) => {
      const blockers = remoteAgentRemovalRegistryBlockers(state);
      if (blockers.length > 0) throw new RegistryBlocked(blockers);
      return withRemoteAgentRemovalFence(
        state,
        { id, controllerId: currentRemoteAgentController().id, startedAt: now },
        now,
      );
    });
    return [];
  } catch (cause) {
    if (cause instanceof RegistryBlocked) return cause.blockers;
    if (cause instanceof RemoteAgentRemovalInProgressError)
      return [{ kind: "admission", label: "Another bigbud is removing the agent from this host" }];
    throw cause;
  }
}

async function clearFence(control: RemoteAgentControl, id: string): Promise<void> {
  // Best effort: an uncleared fence expires on its own and never blocks installs for long.
  await control.registry
    .update((state) => withoutRemoteAgentRemovalFence(state, id))
    .catch(() => {});
}

function busyBlocker(lock: "inbox" | "registry" | "socket"): RemoteAgentRemovalBlocker {
  switch (lock) {
    case "inbox":
      return {
        kind: "stage",
        label: "The install script or bigbud is staging a build in ~/.bigbud/agent/inbox",
      };
    case "registry":
      return { kind: "admission", label: "Another bigbud is changing the agent on this host" };
    case "socket":
      return {
        kind: "process",
        label: "An agent process is still listening under ~/.bigbud/agent",
      };
  }
}

const REFUSALS = {
  "foreign-owner": "~/.bigbud/agent contains files owned by another user. Nothing was removed.",
  mount: "~/.bigbud/agent contains another mounted file system. Nothing was removed.",
  layout: "~/.bigbud/agent has an unexpected layout (symbolic links). Nothing was removed.",
  fence: "The removal was interrupted by another bigbud on this host. Nothing was removed.",
} as const;

class FenceLost extends Error {}

/** Re-stamps the fence right before deleting, so the locked deletion sees it fresh. */
async function renewFence(control: RemoteAgentControl, id: string): Promise<boolean> {
  try {
    const now = await readRemoteAgentHostClock(control);
    await control.registry.update((state) => {
      const renewed = renewRemoteAgentRemovalFence(state, id, now);
      if (!renewed) throw new FenceLost();
      return renewed;
    });
    return true;
  } catch (cause) {
    if (cause instanceof FenceLost) return false;
    throw cause;
  }
}

/** Runs the deletion; a lost reply is resolved by checking whether the tree is already gone. */
async function deleteAgentTree(
  control: RemoteAgentControl,
  fenceId: string,
): Promise<RemoteAgentRemovalResult> {
  let output: string;
  try {
    output = await runRemoteAgentControlOp(control, { kind: "removal", fenceId });
  } catch (cause) {
    const probe = await runRemoteAgentControlOp(control, { kind: "removalOutcome" }).catch(
      () => "",
    );
    // Renamed away: the removal completed; install and cleanup delete any leftover bytes.
    if (probe.trim() === "gone") return { outcome: "removed" };
    await clearFence(control, fenceId);
    throw cause;
  }
  const result = parseRemoteAgentRemovalCommandResult(output);
  if (result.kind === "removed" || result.kind === "none") return { outcome: "removed" };
  await clearFence(control, fenceId);
  if (result.kind === "busy") return { outcome: "blocked", blockers: [busyBlocker(result.lock)] };
  throw new RemoteAgentRemovalError(REFUSALS[result.reason]);
}

/**
 * Remove `~/.bigbud/agent` from one host:
 * 1. Blockers: registry work, live terminal owners and a dependent remote backend runtime.
 * 2. A removal fence is written by CAS, so no controller starts new work meanwhile.
 * 3. Idle supervisors of every registry runtime are asked to stop. Only if this app's own
 *    connections keep one busy are they closed and the stop retried.
 * 4. This app's connections are closed, then the tree is renamed away and deleted under locks.
 * Any refusal clears the fence. Callers hold the per-target install lock.
 */
export async function removeRemoteAgentInstallation(input: {
  readonly control: RemoteAgentControl;
  readonly terminalOwners?: () => Promise<RemoteAgentTerminalOwnerList>;
  readonly closeLocalConnections?: () => void;
  /** Stops this app's pool from dialing the target until the removal ends. */
  readonly markRemoving?: () => () => void;
}): Promise<RemoteAgentRemovalResult> {
  const { control } = input;
  if (!isRemovableRemoteAgentRoot(control.root))
    throw new RemoteAgentRemovalError(
      "The agent's home path contains spaces or control characters, so bigbud cannot remove it safely. Delete ~/.bigbud/agent on the host by hand.",
    );
  const state = await control.registry.read();
  const blockers = boundRemovalBlockers([
    ...remoteAgentRemovalRegistryBlockers(state),
    ...ownerBlockers((await input.terminalOwners?.()) ?? { owners: [], truncated: false }),
    ...(await readRemoteAgentBackendRuntimeBlockers(control)),
  ]);
  if (blockers.length > 0) return { outcome: "blocked", blockers };
  const fenceId = randomUUID();
  const fenceBlockers = await placeFence(control, fenceId);
  if (fenceBlockers.length > 0)
    return { outcome: "blocked", blockers: boundRemovalBlockers(fenceBlockers) };
  const release = input.markRemoving?.();
  try {
    let stopBlockers = await stopIdleRemoteAgentSupervisors(control, state);
    if (stopBlockers.length > 0 && input.closeLocalConnections) {
      // The agent counts this app's own watchers as activity: retry once without them.
      input.closeLocalConnections();
      stopBlockers = await stopIdleRemoteAgentSupervisors(control, state);
    }
    if (stopBlockers.length > 0) {
      await clearFence(control, fenceId);
      return { outcome: "blocked", blockers: boundRemovalBlockers(stopBlockers) };
    }
    if (!(await renewFence(control, fenceId))) throw new RemoteAgentRemovalError(REFUSALS.fence);
    input.closeLocalConnections?.();
    return await deleteAgentTree(control, fenceId);
  } catch (cause) {
    await clearFence(control, fenceId);
    throw cause;
  } finally {
    release?.();
  }
}

/**
 * Delete leftovers of an interrupted removal (`~/.bigbud/.agent-removing.*`). Returns true when
 * it deleted any, so the caller reopens the control root before staging anything.
 */
export async function resumeRemoteAgentRemoval(control: RemoteAgentControl): Promise<boolean> {
  // A removal is never started for such a root, so it cannot have left anything behind.
  if (!isRemovableRemoteAgentRoot(control.root)) return false;
  const result = parseRemoteAgentRemovalCommandResult(
    await runRemoteAgentControlOp(control, { kind: "removalResume" }),
  );
  if (result.kind === "refused")
    throw new RemoteAgentRemovalError(
      "An interrupted agent removal could not finish: its leftover directory has unexpected owners, links or mounts.",
    );
  // A crashed removal's fence would otherwise linger until some later write.
  const now = await readRemoteAgentHostClock(control);
  await control.registry.update((state) => dropExpiredRemoteAgentRemovalFence(state, now));
  return result.kind === "removed";
}
