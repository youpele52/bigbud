import type { ThreadShellRunnerShape } from "../shell/Services/ThreadShellRunner.ts";
import { makeProductionShellRunner } from "./sshShellRunner.production.ts";

/**
 * Server-dispatched shell commands for a direct SSH target (W2 T-shell). They
 * always run as a Rust owner exec lease; there is no TypeScript SSH launch.
 */
export function makeSshShellRunner(executionTargetId: string): ThreadShellRunnerShape {
  return makeProductionShellRunner(executionTargetId);
}
