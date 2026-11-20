import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentRemovalBlocker } from "./remoteAgentInstall.remove.blockers.ts";
import {
  awaitSupervisorExit,
  probeRemoteAgentSupervisorState,
} from "./remoteAgentInstall.retirement.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { quoteShellArgument as quote } from "./remoteAgentShellQuote.ts";
import { buildRemoteAgentSupervisorShutdownCommand } from "./remoteAgentSupervisor.ts";

/**
 * Shell test: is a process still bound to this socket? Reads `/proc/net/unix`, so a stale socket
 * file left by a crashed supervisor is not mistaken for a live one.
 */
export function buildRemoteAgentSocketLivenessCheck(socketPath: string): string {
  return `awk -v p=${quote(socketPath)} 'NR > 1 && $NF == p { found = 1 } END { exit found ? 0 : 1 }' /proc/net/unix`;
}

/** True when a live process is bound to the socket; unknown answers count as live. */
async function socketIsLive(control: RemoteAgentControl, socketPath: string): Promise<boolean> {
  // Whitespace defeats the textual match below; never treat such a socket as gone.
  if (/\s/.test(socketPath)) return true;
  const result = await control
    .run(
      `if test ! -r /proc/net/unix; then printf socket; elif ${buildRemoteAgentSocketLivenessCheck(socketPath)}; then printf socket; else printf none; fi`,
    )
    .catch(() => "socket");
  return result.trim() !== "none";
}

/** Waits for a supervisor without a recorded launch until nothing is bound to its socket. */
async function awaitSocketGone(control: RemoteAgentControl, socketPath: string): Promise<boolean> {
  if (/\s/.test(socketPath)) return false;
  const result = await control.run(`set -eu
for n in $(seq 1 100); do
  if ! ${buildRemoteAgentSocketLivenessCheck(socketPath)}; then printf exited; exit 0; fi
  sleep .1
done
printf uncertain
`);
  return result.trim() === "exited";
}

/**
 * One pass over every registry runtime, whatever its binary state. A live supervisor is asked to
 * stop through its own `--shutdown-supervisor`, which the agent accepts only when idle; nothing
 * is ever killed. A live socket whose program is already gone cannot be stopped cleanly and
 * blocks. Runtimes the registry does not know are caught by the deletion script's socket scan.
 */
export async function stopIdleRemoteAgentSupervisors(
  control: RemoteAgentControl,
  state: RemoteAgentRegistry,
): Promise<RemoteAgentRemovalBlocker[]> {
  const blockers: RemoteAgentRemovalBlocker[] = [];
  const seenSockets = new Set<string>();
  for (const build of state.builds) {
    const runtime = validateRemoteAgentRuntime(build.runtime);
    if (seenSockets.has(runtime.socketPath)) continue;
    seenSockets.add(runtime.socketPath);
    const observed = await probeRemoteAgentSupervisorState(control, runtime).catch(
      () => "uncertain" as const,
    );
    if (observed === "dead" || observed === "absent") continue;
    if (observed === "uncertain" && !(await socketIsLive(control, runtime.socketPath))) continue;
    if (build.binary !== "present") {
      blockers.push({
        kind: "process",
        label: `Agent ${runtime.version} is still running, but its program is gone, so it cannot be stopped cleanly`,
      });
      continue;
    }
    try {
      const accepted = await control.run(buildRemoteAgentSupervisorShutdownCommand(runtime));
      if (accepted.trim() !== "shutdown-accepted") throw new Error("Shutdown was refused.");
    } catch {
      blockers.push({
        kind: "process",
        label: `Agent ${runtime.version} is still running terminals, processes or file watchers`,
      });
      continue;
    }
    const exited =
      observed === "live"
        ? await awaitSupervisorExit(control, runtime).catch(() => false)
        : await awaitSocketGone(control, runtime.socketPath).catch(() => false);
    if (!exited)
      blockers.push({ kind: "process", label: `Agent ${runtime.version} is still shutting down` });
  }
  return blockers;
}
