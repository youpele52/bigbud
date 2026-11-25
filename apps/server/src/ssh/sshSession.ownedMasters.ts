import fs from "node:fs";

import { buildSshControlArgs } from "./sshSession.control.ts";
import { parseSshExecutionTarget } from "./sshExecutionTarget.ts";
import { runSshLocalCommand, SSH_LOCAL_PROBE_TIMEOUT_MS } from "./sshLocalCommand.ts";

/** One password ControlMaster recorded by this backend process. */
export interface OwnedSshMaster {
  readonly executionTargetId: string;
  readonly controlPath: string;
  readonly destination: string;
}

export interface OwnedSshMasterDrain {
  readonly closed: number;
  readonly failed: number;
}

export interface OwnedSshMasterDrainOptions {
  readonly run?: (args: ReadonlyArray<string>) => Promise<{ readonly status: number | null }>;
  readonly exists?: (controlPath: string) => boolean;
  readonly forget?: (master: OwnedSshMaster) => void;
}

/**
 * `ssh -O exit` for exactly the masters this backend started. The caller's list
 * is the authority: sockets found on disk or in a user's configuration are never
 * inspected or closed here. A missing socket is already closed.
 */
export async function drainOwnedSshMastersWith(
  masters: ReadonlyArray<OwnedSshMaster>,
  options: OwnedSshMasterDrainOptions = {},
): Promise<OwnedSshMasterDrain> {
  const run =
    options.run ??
    ((args) =>
      runSshLocalCommand("ssh", args as string[], { timeoutMs: SSH_LOCAL_PROBE_TIMEOUT_MS }));
  const exists = options.exists ?? ((controlPath) => fs.existsSync(controlPath));
  let closed = 0;
  let failed = 0;
  for (const master of masters) {
    const target = parseSshExecutionTarget(master.executionTargetId);
    if (!target) {
      failed += 1;
      continue;
    }
    if (exists(master.controlPath)) {
      const result = await run(buildSshControlArgs("exit", target, master)).catch(() => ({
        status: null,
      }));
      if (result.status !== 0) {
        failed += 1;
        continue;
      }
      closed += 1;
    }
    fs.rmSync(master.controlPath, { force: true });
    options.forget?.(master);
  }
  return { closed, failed };
}
