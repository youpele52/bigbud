import type { PtyProcess } from "../Services/PTY.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";

type RuntimeResolver =
  | {
      readonly ownedRuntimeForTarget?: (
        target: string,
      ) => Pick<OwnedPtyRuntime, "pidNamespace" | "localSshClient"> | undefined;
    }
  | undefined;

/** Direct SSH through the local terminal host (M7): a local `ssh` client for this target. */
export function terminalRunsLocalSshClient(adapter: RuntimeResolver, target: string): boolean {
  return adapter?.ownedRuntimeForTarget?.(target)?.localSshClient !== undefined;
}

/** Pure inspection policy; classifying a PID must not initialize SSH or native probes. */
export function terminalPidIsOnBackendHost(
  adapter: RuntimeResolver,
  target: string,
  process?: Pick<PtyProcess, "pidDomain"> | null,
): boolean {
  const runtime = adapter?.ownedRuntimeForTarget?.(target);
  // A local ssh client's children are not the target's processes; the remote shell is inspected.
  if (runtime) return runtime.pidNamespace === "backend-host" && !runtime.localSshClient;
  return process?.pidDomain !== "remote" && isLocalExecutionTarget(target);
}

/**
 * Whether the remote shell PID arrives in-band (the generation-scoped marker): an SSH pane whose
 * PTY is a local `ssh` client, in-process or in the local terminal host.
 */
export function terminalShellPidIsInBand(
  adapter: RuntimeResolver,
  target: string,
  process: Pick<PtyProcess, "pidDomain">,
): boolean {
  if (isLocalExecutionTarget(target) || isWslTerminalTargetId(target)) return false;
  return process.pidDomain !== "remote" || terminalRunsLocalSshClient(adapter, target);
}
