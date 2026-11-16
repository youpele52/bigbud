import type { PtyProcess } from "../Services/PTY.ts";
import type { OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";

/** Pure inspection policy; classifying a PID must not initialize SSH or native probes. */
export function terminalPidIsOnBackendHost(
  adapter:
    | {
        readonly ownedRuntimeForTarget?: (
          target: string,
        ) => Pick<OwnedPtyRuntime, "pidNamespace"> | undefined;
      }
    | undefined,
  target: string,
  process?: Pick<PtyProcess, "pidDomain"> | null,
): boolean {
  const runtime = adapter?.ownedRuntimeForTarget?.(target);
  if (runtime) return runtime.pidNamespace === "backend-host";
  return process?.pidDomain !== "remote" && isLocalExecutionTarget(target);
}
