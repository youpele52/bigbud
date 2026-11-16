import { RemoteAgentAdmissionError } from "./remoteAgentAdmission.types.ts";
import { randomUUID } from "node:crypto";

import type { ServerRemoteAgentRuntimeSummary } from "@bigbud/contracts/server/server.ts";

import { findRemoteAgentRemoteCommandError } from "./remoteAgentDiagnostics.ts";
import { classifyRemoteAgentFailure } from "./remoteAgentFailure.classify.ts";
import { remoteAgentFailureDetail } from "./remoteAgentFailure.ts";

/**
 * One install/replace transaction shared by the app, the local CLI socket and agent tools.
 * `active`: the requested build serves new connections. `staged`: verified bytes are ready but
 * activation was not requested. `deferred`: activation could not complete safely (live work or
 * capacity); the working build is unchanged. `uncertain`: a transport failure hid the outcome;
 * poll status before retrying. `cleanupDeferred` is separate: the new build can be active
 * while live work still pins a predecessor.
 */
export type RemoteAgentOperationOutcome = "staged" | "active" | "deferred" | "failed" | "uncertain";

export interface RemoteAgentOperationSnapshot {
  readonly operationId: string;
  readonly executionTargetId: string;
  /** `stage` places verified bytes only; the app activates them with its own Finish step (D6). */
  readonly kind: "install" | "replace" | "stage";
  readonly state: "running" | "completed";
  readonly outcome: RemoteAgentOperationOutcome | null;
  readonly version: string | null;
  readonly activeVersion: string | null;
  readonly cleanupDeferred: boolean;
  readonly message: string;
  readonly failureKind: string | null;
  readonly startedAt: number;
  readonly completedAt: number | null;
}

/** Staging result; placement details are kept for the caller that asked for staging only. */
export interface RemoteAgentStagedBuild {
  readonly version: string;
  readonly buildId?: string;
  readonly placement?: "upload" | "managed" | "inbox";
  readonly inboxConflict?: boolean;
  readonly runtimeSummary?: ServerRemoteAgentRuntimeSummary;
}

export interface RemoteAgentOperationDependencies {
  readonly stage: (target: string, signal: AbortSignal) => Promise<RemoteAgentStagedBuild>;
  /** Fresh admission of the staged build; returns the build actually serving. */
  readonly activate: (
    target: string,
    requestId: string,
  ) => Promise<{
    readonly currentVersion: string;
    readonly currentBuildId?: string;
    readonly warning?: string | null;
  }>;
  /** Retire non-current builds; `deferred` counts builds still pinned by live work. */
  readonly retire: (target: string) => Promise<{ readonly deferred: number }>;
  readonly now?: () => number;
}

const MAX_RETAINED_OPERATIONS = 64;
const RETAINED_OPERATION_MS = 60 * 60 * 1000;

function failureOutcome(cause: unknown): RemoteAgentOperationOutcome {
  let current = cause;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if ("_tag" in current && current._tag === "RemoteAgentUpdateUncertainError") return "uncertain";
    if (current instanceof RemoteAgentAdmissionError && current.committedRequestId)
      return "uncertain";
    current = current.cause;
  }
  const remote = findRemoteAgentRemoteCommandError(cause);
  if (remote && (remote.timedOut || remote.exitCode === 255 || remote.exitCode === null))
    return "uncertain";
  const kind = classifyRemoteAgentFailure(cause)?.kind;
  return kind === "capacity-deferred" || kind === "install-in-progress" ? "deferred" : "failed";
}

export function makeRemoteAgentInstallOperations(dependencies: RemoteAgentOperationDependencies) {
  const now = dependencies.now ?? Date.now;
  const operations = new Map<string, RemoteAgentOperationSnapshot>();
  const running = new Map<string, { id: string; done: Promise<RemoteAgentOperationSnapshot> }>();
  const stagedBuilds = new Map<string, RemoteAgentStagedBuild>();

  const prune = () => {
    const cutoff = now() - RETAINED_OPERATION_MS;
    const completed = [...operations.values()].filter((entry) => entry.state === "completed");
    const excess = completed.length - MAX_RETAINED_OPERATIONS;
    completed
      .toSorted((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0))
      .forEach((entry, index) => {
        if (index < excess || (entry.completedAt ?? 0) < cutoff) {
          operations.delete(entry.operationId);
          stagedBuilds.delete(entry.operationId);
        }
      });
  };

  const run = async (
    snapshot: RemoteAgentOperationSnapshot,
    replace: boolean,
    stageOnly: boolean,
  ) => {
    const target = snapshot.executionTargetId;
    const finish = (patch: Partial<RemoteAgentOperationSnapshot>) => {
      const completed = {
        ...snapshot,
        ...patch,
        ...(patch.outcome === "uncertain"
          ? {
              message: `${patch.message ?? snapshot.message} Remote changes may already have completed. Check agent status before retrying.`,
            }
          : {}),
        state: "completed" as const,
        completedAt: now(),
      };
      operations.set(snapshot.operationId, completed);
      return completed;
    };
    let version: string | null = null;
    let stagedBuildId: string | undefined;
    try {
      const controller = new AbortController();
      const staged = await dependencies.stage(target, controller.signal);
      version = staged.version;
      stagedBuildId = staged.buildId;
      stagedBuilds.set(snapshot.operationId, staged);
    } catch (cause) {
      return finish({
        outcome: failureOutcome(cause),
        message: remoteAgentFailureDetail(cause),
        failureKind: classifyRemoteAgentFailure(cause)?.kind ?? null,
      });
    }
    if (stageOnly) {
      return finish({ version, outcome: "staged", message: `Agent ${version} is staged.` });
    }
    let activeVersion: string;
    let activeBuildId: string | undefined;
    let warning: string | null = null;
    try {
      const activated = await dependencies.activate(target, snapshot.operationId);
      activeVersion = activated.currentVersion;
      activeBuildId = activated.currentBuildId;
      warning = activated.warning ?? null;
    } catch (cause) {
      return finish({
        version,
        outcome: failureOutcome(cause),
        message: `Agent ${version} is staged, but activation did not complete: ${remoteAgentFailureDetail(cause)}`,
        failureKind: classifyRemoteAgentFailure(cause)?.kind ?? null,
      });
    }
    // Same version is not the same build: a musl candidate can fall back to the glibc build
    // of that version during the D4 transition. Compare exact build IDs whenever both are known.
    const activatedStagedBuild =
      stagedBuildId !== undefined && activeBuildId !== undefined
        ? activeBuildId === stagedBuildId
        : activeVersion === version;
    if (!activatedStagedBuild) {
      return finish({
        version,
        activeVersion,
        outcome: "deferred",
        message: `${
          activeVersion === version
            ? `The staged build of agent ${version} was not activated; another ${version} build remains active.`
            : `Agent ${version} is staged; ${activeVersion} remains active.`
        }${warning ? ` ${warning}` : ""}`,
      });
    }
    let cleanupDeferred = false;
    let cleanupFailure: string | null = null;
    if (replace) {
      try {
        cleanupDeferred = (await dependencies.retire(target)).deferred > 0;
      } catch (cause) {
        // Retirement is maintenance; a failure keeps old builds and never affects activation.
        cleanupDeferred = true;
        cleanupFailure = remoteAgentFailureDetail(cause);
      }
    }
    return finish({
      version,
      activeVersion,
      outcome: "active",
      cleanupDeferred,
      message:
        (cleanupFailure
          ? `Agent ${version} is active. Cleanup of older builds could not run and is deferred: ${cleanupFailure}`
          : cleanupDeferred
            ? `Agent ${version} is active. Cleanup of older builds is deferred while live work still uses them.`
            : `Agent ${version} is active.`) + (warning ? ` ${warning}` : ""),
    });
  };

  return {
    /**
     * Start or join the target's running operation; repeated requests reconcile, never fork.
     * `stageOnly` (the app's Install) shares the same per-target serialization and staging.
     */
    start: (input: {
      readonly executionTargetId: string;
      readonly replace: boolean;
      readonly stageOnly?: boolean;
      readonly operationId?: string;
    }) => {
      prune();
      if (input.operationId) {
        const accepted = operations.get(input.operationId);
        if (accepted) {
          const kind = input.stageOnly ? "stage" : input.replace ? "replace" : "install";
          if (accepted.executionTargetId !== input.executionTargetId || accepted.kind !== kind)
            throw new Error("Operation ID is already bound to another request.");
          return accepted;
        }
      }
      const existing = running.get(input.executionTargetId);
      if (existing && input.operationId && existing.id !== input.operationId)
        throw new Error("Another operation is running for this target. Follow its existing ID.");
      if (existing) return operations.get(existing.id)!;
      const snapshot: RemoteAgentOperationSnapshot = {
        operationId: input.operationId ?? randomUUID(),
        executionTargetId: input.executionTargetId,
        kind: input.stageOnly ? "stage" : input.replace ? "replace" : "install",
        state: "running",
        outcome: null,
        version: null,
        activeVersion: null,
        cleanupDeferred: false,
        message: input.stageOnly
          ? "Staging the remote agent."
          : input.replace
            ? "Replacing the remote agent."
            : "Installing the remote agent.",
        failureKind: null,
        startedAt: now(),
        completedAt: null,
      };
      operations.set(snapshot.operationId, snapshot);
      const done = run(snapshot, input.replace, input.stageOnly === true).finally(() => {
        if (running.get(input.executionTargetId)?.id === snapshot.operationId) {
          running.delete(input.executionTargetId);
        }
      });
      running.set(input.executionTargetId, { id: snapshot.operationId, done });
      return snapshot;
    },
    get: (operationId: string): RemoteAgentOperationSnapshot | null =>
      operations.get(operationId) ?? null,
    /** Staging details (placement, inbox conflict, runtime summary) of an operation. */
    stagedBuild: (operationId: string): RemoteAgentStagedBuild | null =>
      stagedBuilds.get(operationId) ?? null,
    /** Resolve when the operation completes or the deadline passes (returns the latest state). */
    wait: async (operationId: string, timeoutMs: number) => {
      const current = operations.get(operationId);
      if (!current || current.state === "completed") return current ?? null;
      const entry = [...running.values()].find((candidate) => candidate.id === operationId);
      if (!entry) return current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        entry.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      return operations.get(operationId) ?? null;
    },
  };
}

export type RemoteAgentInstallOperations = ReturnType<typeof makeRemoteAgentInstallOperations>;
