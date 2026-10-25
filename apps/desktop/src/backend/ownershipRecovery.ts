import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { machineIdentity } from "@bigbud/shared/machineIdentity";
import { processStartToken, compareProcessStartToken } from "@bigbud/shared/processStartToken";
import {
  readOwnershipLock,
  hasOwnershipControl,
  type StateDirLockRecord,
} from "@bigbud/shared/backendOwnership.record";
import {
  ownershipIdentity,
  requestOwnershipControl,
} from "@bigbud/shared/backendOwnership.control";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import type {
  OwnershipRecoveryError,
  OwnershipRecoveryState,
} from "@bigbud/contracts/server/ipc.ownershipRecovery.ts";
import type { OwnershipLaunch } from "./ownershipRecovery.launch";
import { verifyBackendExecutable } from "./ownershipRecovery.identity";

export interface OwnershipRecoveryDeps {
  readonly state: () => DesktopBackendStartupState;
  readonly launch: () => OwnershipLaunch | undefined;
  readonly blocked: () => boolean;
  readonly childPresent: () => boolean;
  readonly start: () => Promise<void>;
  readonly publish: (generation: number, state: OwnershipRecoveryState) => void;
  readonly platform?: string;
  readonly machine?: () => string | null;
  readonly token?: typeof processStartToken;
  readonly alive?: (pid: number) => boolean;
  readonly verify?: typeof verifyBackendExecutable;
  readonly read?: typeof readOwnershipLock;
  readonly request?: typeof requestOwnershipControl;
  readonly canonical?: typeof realpath;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}
const errors = new Set<OwnershipRecoveryError>([
  "owner_unverified",
  "owner_changed",
  "unsupported_platform",
  "supervisor_unavailable",
  "shutdown_timed_out",
  "stale_generation",
  "application_quitting",
  "retry_start_failed",
]);

/** Main-owned single flight. No renderer target data and no external process signals. */
export function createOwnershipRecovery(deps: OwnershipRecoveryDeps) {
  let active: { generation: number; promise: Promise<void>; inspect: boolean } | undefined;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = deps.read ?? readOwnershipLock;
  const token = deps.token ?? processStartToken;
  const alive =
    deps.alive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
  const perform = async (generation: number, inspect: boolean) => {
    const deadline = now() + 45000;
    const valid = () => {
      if (deps.state().generation !== generation) throw new Error("stale_generation");
      if (deps.blocked()) throw new Error("application_quitting");
      if (now() >= deadline) throw new Error("shutdown_timed_out");
    };
    const retry = async () => {
      valid();
      deps.publish(generation, { phase: "retrying" });
      await deps.start();
      if (deps.state().generation === generation) throw new Error("retry_start_failed");
    };
    try {
      valid();
      const state = deps.state();
      if (
        state.status !== "failed" ||
        !["state_directory_in_use", "state_directory_owner_unverified"].includes(
          state.failureReason ?? "",
        ) ||
        state.ownershipRecovery?.phase === "yielded"
      )
        throw new Error("stale_generation");
      if (!["darwin", "linux"].includes(deps.platform ?? process.platform))
        throw new Error("unsupported_platform");
      const launch = deps.launch();
      if (!launch || launch.generation !== generation) throw new Error("stale_generation");
      deps.publish(generation, { phase: "checking" });
      const closeDeadline = now() + 5000;
      while (deps.childPresent()) {
        valid();
        if (now() >= closeDeadline) throw new Error("retry_start_failed");
        await sleep(50);
      }
      const stateDir = await (deps.canonical ?? realpath)(launch.stateDir);
      const filename = path.join(stateDir, "backend.lock");
      const owner = await read(filename);
      if (!owner) {
        if (inspect) {
          deps.publish(generation, { phase: "available" });
          return;
        }
        return await retry();
      }
      const machine = (deps.machine ?? machineIdentity)();
      if (!machine || machine !== owner.machineId) throw new Error("owner_unverified");
      const gone = (record: StateDirLockRecord) =>
        !alive(record.pid) ||
        compareProcessStartToken(record.startedAt, token(record.pid)) === "different";
      if (gone(owner)) {
        if (inspect) {
          deps.publish(generation, { phase: "available" });
          return;
        }
        return await retry();
      }
      if (!hasOwnershipControl(owner) || !launch.inspector) throw new Error("owner_unverified");
      const identity = ownershipIdentity(owner, stateDir);
      const revalidate = async () => {
        valid();
        const current = await read(filename);
        if (
          !current ||
          ownershipIdentity(current, stateDir) !== identity ||
          JSON.stringify(current.control) !== JSON.stringify(owner.control)
        )
          throw new Error("owner_changed");
        if (compareProcessStartToken(owner.startedAt, token(owner.pid)) !== "same")
          throw new Error("owner_unverified");
        await (deps.verify ?? verifyBackendExecutable)({
          binary: launch.inspector!,
          pid: owner.pid,
          launcher: launch.launcher,
          entry: launch.entry,
        });
        valid();
        if (compareProcessStartToken(owner.startedAt, token(owner.pid)) !== "same")
          throw new Error("owner_changed");
      };
      const operation = randomBytes(16).toString("hex");
      const request = (action: "inspect" | "prepare" | "commit" | "status") => {
        valid();
        return (deps.request ?? requestOwnershipControl)(
          owner.control,
          {
            version: 1,
            action,
            operation,
            identity,
          },
          Math.min(7000, deadline - now()),
        );
      };
      await revalidate();
      if ((await request("inspect")) !== "available") throw new Error("owner_unverified");
      if (inspect) {
        valid();
        deps.publish(generation, { phase: "available" });
        return;
      }
      await revalidate();
      deps.publish(generation, { phase: "stopping" });
      let preparation: string | undefined;
      try {
        preparation = await request("prepare");
      } catch {
        /* A lost reply does not undo an acknowledged supervisor gate. */
      }
      if (preparation !== "prepared") {
        try {
          preparation = await request("status");
        } catch {
          /* Retry preparation once; the instance's supervisor handshake is idempotent. */
        }
        if (preparation !== "prepared") {
          try {
            preparation = await request("prepare");
          } catch {
            /* Observation remains inconclusive; fail closed below. */
          }
        }
      }
      if (preparation !== "prepared") throw new Error("supervisor_unavailable");
      await revalidate();
      let committed: string | undefined;
      try {
        committed = await request("commit");
      } catch {
        /* Shutdown can close the acceptance socket; never replay the commit. */
      }
      if (!committed && !gone(owner)) {
        valid();
        try {
          committed = await request("status");
        } catch {
          /* Only observed process-instance exit can establish success now. */
        }
      }
      if (committed !== undefined && committed !== "committed")
        throw new Error("supervisor_unavailable");
      const stopDeadline = Math.min(deadline, now() + 30000);
      while (now() < stopDeadline) {
        valid();
        const current = await read(filename);
        if (current && ownershipIdentity(current, stateDir) !== identity)
          throw new Error("owner_changed");
        if (gone(owner)) return await retry();
        await sleep(100);
      }
      throw new Error("shutdown_timed_out");
    } catch (error) {
      const code =
        error instanceof Error && errors.has(error.message as OwnershipRecoveryError)
          ? (error.message as OwnershipRecoveryError)
          : "owner_unverified";
      deps.publish(generation, { phase: "failed", error: code });
    }
  };
  const run = (generation: number, inspect: boolean): Promise<void> => {
    if (active)
      return active.generation !== generation
        ? Promise.reject(new Error("stale_generation"))
        : active.inspect && !inspect
          ? active.promise.then(() => run(generation, false))
          : active.promise;
    const promise = perform(generation, inspect).finally(() => {
      active = undefined;
    });
    active = { generation, promise, inspect };
    return promise;
  };
  return Object.assign((generation: number) => run(generation, false), {
    check: (generation: number) => run(generation, true),
  });
}
