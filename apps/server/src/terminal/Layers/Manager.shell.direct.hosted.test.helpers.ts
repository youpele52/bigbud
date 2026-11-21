import { Effect } from "effect";

import type { OwnedPtyLocalSshClient, OwnedPtyRuntime } from "../Services/OwnedPtyRuntime.ts";
import type { PtySpawnInput } from "../Services/PTY.ts";
import { FakeHostAdapter, type FakeHostProcess } from "./Manager.host.test.helpers.ts";
import { openInput } from "./Manager.test.helpers.ts";

export const SSH_TARGET = "ssh:host=devbox&user=me&auth=ssh-key&transport=direct-ssh";
export const OTHER_SSH_TARGET = "ssh:host=otherbox&user=me&auth=ssh-key&transport=direct-ssh";

export const sshPane = (overrides: Parameters<typeof openInput>[0] = {}) =>
  openInput({ terminalId: "ssh", executionTargetId: SSH_TARGET, cwd: "/srv/app", ...overrides });

/**
 * A fake local terminal host that also runs Direct SSH panes (M7): the runtime for SSH targets is
 * the host's, marked with a local ssh client whose liveness follows the fake PTY and whose close
 * terminates it. `unreachable` makes every verdict `unknown`.
 */
export class DirectSshHostAdapter extends FakeHostAdapter {
  unreachable = false;
  readonly clientCloses: string[] = [];

  private processFor(resourceId: string): FakeHostProcess | undefined {
    return [...this.hostProcesses.values()].find(
      (process) => process.remoteResourceId === resourceId,
    );
  }

  readonly sshClient: OwnedPtyLocalSshClient = {
    status: async (owner) => {
      if (this.unreachable) return "unknown";
      const process = this.processFor(owner.resourceId);
      return process && !process.killed ? "live" : "gone";
    },
    close: async (owner) => {
      if (this.unreachable) throw new Error("The terminal host is unreachable.");
      this.clientCloses.push(owner.resourceId);
      this.processFor(owner.resourceId)?.kill("SIGTERM");
      this.ownership.rows.set(owner.ownerKey, { ...owner, state: "terminal" });
    },
  };

  get directRuntime(): OwnedPtyRuntime {
    return { ...this.runtime, localSshClient: this.sshClient };
  }

  override readonly ownedRuntimeForTarget = (target: string) =>
    target === "local"
      ? this.runtime
      : target === SSH_TARGET || target === OTHER_SSH_TARGET
        ? this.directRuntime
        : undefined;

  /** Host spawns only; a refused spawn records nothing. */
  hostSpawns(): PtySpawnInput[] {
    return this.spawnInputs.filter((input) => input.executionTargetId !== "local");
  }

  processAt(index: number) {
    return Effect.sync(() => this.processes[index] as FakeHostProcess);
  }
}
