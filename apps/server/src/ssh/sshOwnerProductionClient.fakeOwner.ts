import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SCRIPT } from "./sshOwnerProductionClient.fakeOwner.script.ts";

/**
 * Test support: a disposable owner binary that speaks just enough of the v1
 * frame protocol to exercise the production client's spawn handshake. It is
 * never imported by product code.
 *
 * @module sshOwnerProductionClient.fakeOwner
 */

export type FakeOwnerMode =
  | "success"
  | "version-mismatch"
  | "oversized"
  | "silent"
  | "die"
  /** Refuses every request with the typed target-mismatch code (35). */
  | "wrong-target"
  /** Refuses every request with unsupported policy (5) before any request frame. */
  | "policy-refusal"
  /** Simulates an older owner that pinned one target at startup. */
  | "single-target"
  /** Acknowledges reconciliation but refuses an unresolved retirement row (31). */
  | "reconcile-retirement"
  /** Acknowledges reconciliation but refuses a malformed pane binding (36). */
  | "reconcile-pane"
  /** Echoes a previous round's reconciliation id, so the fresh ack is refused. */
  | "reconcile-stale"
  /** Acknowledges with zero counts even though rows were sent (partial ack). */
  | "reconcile-partial"
  /** Answers the first operation with a truncated reply frame (protocol error). */
  | "malformed-reply";

export interface FakeOwnerOptions {
  readonly mode: FakeOwnerMode;
  readonly observationFile: string;
  /** Per-target grant/request activity, to prove a refused target dials nothing. */
  readonly activityFile?: string;
  readonly aliasDescriptor?: Buffer;
  /** Target the refusal modes reject; every other target still succeeds. */
  readonly rejectTarget?: string;
  /** Simulates an owner that echoes a different startup profile binding. */
  readonly echoBindingHex?: string;
}

export async function writeFakeSshOwnerBinary(
  directory: string,
  options: FakeOwnerOptions,
): Promise<string> {
  const path = join(directory, `fake-owner-${options.mode}`);
  const config = {
    mode: options.mode,
    observationFile: options.observationFile,
    ...(options.activityFile === undefined ? {} : { activityFile: options.activityFile }),
    ...(options.aliasDescriptor === undefined
      ? {}
      : { aliasDescriptor: options.aliasDescriptor.toString("hex") }),
    ...(options.rejectTarget === undefined ? {} : { rejectTarget: options.rejectTarget }),
    ...(options.echoBindingHex === undefined ? {} : { echoBindingHex: options.echoBindingHex }),
  };
  await writeFile(
    path,
    SCRIPT.replace("__EXEC__", process.execPath).replace("__CONFIG__", JSON.stringify(config)),
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

export interface FakeOwnerObservation {
  readonly env: Record<string, string>;
  readonly argv: ReadonlyArray<string>;
  readonly pid: number;
}

export const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};
