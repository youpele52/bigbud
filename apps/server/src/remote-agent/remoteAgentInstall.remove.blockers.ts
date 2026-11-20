import type { ServerRemoteAgentRemovalBlocker } from "@bigbud/contracts/server/server.remoteAgentInstall";

import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import { REMOTE_AGENT_IN_FLIGHT_UPDATE_PHASES } from "./remoteAgentInstall.registry.references.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";

/**
 * Evidence that live work or a dependent service still uses `~/.bigbud/agent`. Removal never
 * interrupts anything: any blocker refuses the removal before a byte is deleted.
 */
export type RemoteAgentRemovalBlocker = ServerRemoteAgentRemovalBlocker;

const MAX_BLOCKERS = 12;
const MAX_LABEL_LENGTH = 160;
const ACTIVE_RETIREMENT_PHASES: ReadonlySet<string> = new Set([
  "reserved",
  "fenced",
  "shutdown-requested",
  "exited",
]);
const LIVE_OWNER_STATES: ReadonlySet<RemoteAgentOwner["state"]> = new Set([
  "prepared",
  "may-have-been-sent",
]);

/** Version part of a registry build ID (`version:sha256:triple[:legacy]`). */
function buildVersion(buildId: string): string {
  return buildId.split(":")[0] || "unknown";
}

/** Printable, bounded text for labels built from remote or durable data. */
export function sanitizeRemovalLabel(value: string): string {
  const printable = Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return printable.length > MAX_LABEL_LENGTH
    ? `${printable.slice(0, MAX_LABEL_LENGTH - 1)}…`
    : printable || "unknown";
}

/** Deduplicate by kind and label, keeping a bounded list with a closing summary. */
export function boundRemovalBlockers(
  blockers: ReadonlyArray<RemoteAgentRemovalBlocker>,
): RemoteAgentRemovalBlocker[] {
  const unique = new Map<string, RemoteAgentRemovalBlocker>();
  for (const blocker of blockers) {
    const label = sanitizeRemovalLabel(blocker.label);
    unique.set(`${blocker.kind}\u0000${label}`, { kind: blocker.kind, label });
  }
  const list = [...unique.values()];
  if (list.length <= MAX_BLOCKERS) return list;
  const kept = list.slice(0, MAX_BLOCKERS - 1);
  const rest = list.length - kept.length;
  return [...kept, { kind: list[MAX_BLOCKERS - 1]!.kind, label: `and ${rest} more` }];
}

/** Durable in-progress work recorded in the agent registry on the host. */
export function remoteAgentRemovalRegistryBlockers(
  state: RemoteAgentRegistry,
): RemoteAgentRemovalBlocker[] {
  const blockers: RemoteAgentRemovalBlocker[] = [];
  for (const stage of state.stages) {
    if (stage.phase === "reserved")
      blockers.push({
        kind: "stage",
        label: `Agent ${buildVersion(stage.buildId)} is being staged`,
      });
  }
  for (const update of state.updates) {
    if (REMOTE_AGENT_IN_FLIGHT_UPDATE_PHASES.has(update.phase)) {
      const version = update.identity?.version ?? buildVersion(update.buildId);
      blockers.push({ kind: "stage", label: `Update ${version} is being installed` });
    }
  }
  for (const reservation of state.retirementReservations) {
    if (ACTIVE_RETIREMENT_PHASES.has(reservation.phase))
      blockers.push({
        kind: "stage",
        label: `Cleanup of agent ${buildVersion(reservation.buildId)} is in progress`,
      });
  }
  for (const launch of state.launches) {
    if (launch.phase === "reserved" || launch.phase === "spawn-uncertain")
      blockers.push({
        kind: "admission",
        label: `Agent ${buildVersion(launch.buildId)} is starting`,
      });
  }
  for (const admission of state.admissions) {
    if (admission.phase === "prepared")
      blockers.push({
        kind: "admission",
        label: `A connection to agent ${buildVersion(admission.buildId)} is being set up`,
      });
  }
  for (const slot of state.slotReservations) {
    if (slot.phase === "reserved")
      blockers.push({ kind: "admission", label: "A connection slot is reserved" });
  }
  for (const restart of state.restartReservations) {
    if (restart.phase !== "failed" && restart.phase !== "ready")
      blockers.push({
        kind: "admission",
        label: `Agent ${buildVersion(restart.buildId)} is restarting`,
      });
  }
  for (const pin of state.pins) {
    blockers.push({
      kind: "process",
      label: `Agent ${buildVersion(pin.buildId)} is pinned by ${pin.owner}`,
    });
  }
  return blockers;
}

/** Terminals this app opened through the agent whose outcome is still live or unconfirmed. */
export function remoteAgentRemovalOwnerBlockers(
  owners: ReadonlyArray<RemoteAgentOwner>,
): RemoteAgentRemovalBlocker[] {
  return owners
    .filter((owner) => LIVE_OWNER_STATES.has(owner.state))
    .map((owner) => ({
      kind: "terminal" as const,
      label: owner.terminalCwd ? `Terminal in ${owner.terminalCwd}` : "Open terminal",
    }));
}

/**
 * Read-only probe for a remote backend runtime that depends on the agent: published service
 * configs under `~/.bigbud/backend-services` and bigbud systemd user units. Any evidence, including
 * an unreadable directory, blocks removal; the backend runtime's own files are never touched.
 */
export const REMOTE_AGENT_BACKEND_RUNTIME_PROBE = `set -eu
home=$(readlink -f -- "$HOME")
services="$home/.bigbud/backend-services"
if test -e "$services" || test -L "$services"; then
  if test -d "$services" && test ! -L "$services"; then
    for entry in "$services"/* "$services"/.[!.]*; do
      if test -e "$entry" || test -L "$entry"; then printf 'service:%s\\n' "\${entry##*/}"; fi
    done
  else
    printf 'service:unreadable\\n'
  fi
fi
units="$home/.config/systemd/user"
if test -d "$units"; then
  for entry in "$units"/bigbud-rust-* "$units"/bigbud-backend-* "$units"/.bigbud-rust-* "$units"/.bigbud-backend-*; do
    if test -e "$entry" || test -L "$entry"; then printf 'unit:%s\\n' "\${entry##*/}"; fi
  done
fi
printf 'probe:done\\n'
`;

export function parseRemoteAgentBackendRuntimeProbe(output: string): RemoteAgentRemovalBlocker[] {
  const lines = output.split("\n").map((line) => line.trim());
  if (!lines.includes("probe:done")) throw new Error("Incomplete backend runtime probe.");
  return lines.flatMap((line): RemoteAgentRemovalBlocker[] => {
    if (line.startsWith("service:"))
      return [{ kind: "backend-runtime", label: `Remote backend service ${line.slice(8)}` }];
    if (line.startsWith("unit:"))
      return [{ kind: "backend-runtime", label: `Remote backend unit ${line.slice(5)}` }];
    return [];
  });
}

export async function readRemoteAgentBackendRuntimeBlockers(
  control: Pick<RemoteAgentControl, "run">,
): Promise<RemoteAgentRemovalBlocker[]> {
  try {
    return parseRemoteAgentBackendRuntimeProbe(
      await control.run(REMOTE_AGENT_BACKEND_RUNTIME_PROBE),
    );
  } catch {
    return [
      {
        kind: "backend-runtime",
        label: "Could not check whether a remote backend service uses the agent",
      },
    ];
  }
}
