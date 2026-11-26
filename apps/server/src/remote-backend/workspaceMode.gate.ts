/**
 * Orchestration gate for workspace runtime-mode reservations.
 *
 * - SSH workspaces are laptop-runtime, reserved on the SSH host.
 * - Local workspaces of a `remote` mode backend are remote-runtime, reserved on this host.
 * - Local workspaces of desktop/web backends need no reservation (no remote backend shares them).
 *
 * Project creation and folder changes reserve first and are refused on a conflict or when the
 * reservation cannot be established. Existing projects claim lazily on their next turn: a
 * conflict refuses the turn, but an unreachable legacy store only logs, so existing users keep
 * working. A selected SSH owner must confirm admission on each check.
 *
 * @module workspaceMode.gate
 */
import os from "node:os";

import { Effect, Layer, ServiceMap } from "effect";
import { machineIdentity } from "@bigbud/shared/machineIdentity";
import {
  isLocalExecutionTargetId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { probeSelectedSshOwnerWorkspaceReadiness } from "../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import { DevSshOwnerRuntime } from "../ssh/sshOwnerDevRuntime.ts";
import { ServerConfig, type RuntimeMode } from "../startup/config.ts";
import { makeLocalWorkspaceModeStore } from "./workspaceMode.local.ts";
import {
  workspaceModeConflictMessage,
  workspaceModeOwnerId,
  type WorkspaceModeStore,
  type WorkspaceRuntimeMode,
} from "./workspaceMode.record.ts";
import { reserveWorkspaceMode } from "./workspaceMode.reserve.ts";
import { makeSshWorkspaceModeStore } from "./workspaceMode.ssh.ts";
import type { WorkspaceModeSshOwner } from "./workspaceMode.ssh.owner.ts";

export interface WorkspaceModeRequest {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly intent: "reserve" | "lazy";
}

const targetOf = (value: {
  workspaceExecutionTargetId?: string | undefined;
  executionTargetId?: string | undefined;
}) => value.workspaceExecutionTargetId ?? value.executionTargetId ?? "local";

/** Which folder a command binds or uses; undefined when the command touches no workspace. */
export function workspaceModeRequest(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): WorkspaceModeRequest | undefined {
  if (command.type === "project.create" || command.type === "project.reconfigure") {
    if (!command.workspaceRoot) return undefined; // Managed folders claim lazily once allocated.
    return {
      executionTargetId: targetOf(command),
      workspaceRoot: command.workspaceRoot,
      intent: "reserve",
    };
  }
  if (command.type === "project.meta.update" && command.workspaceRoot) {
    const project = readModel.projects.find((entry) => entry.id === command.projectId);
    const target =
      command.workspaceExecutionTargetId ??
      command.executionTargetId ??
      (project ? targetOf(project) : "local");
    return { executionTargetId: target, workspaceRoot: command.workspaceRoot, intent: "reserve" };
  }
  if (command.type !== "thread.turn.start" && command.type !== "thread.message.submit")
    return undefined;
  const thread = readModel.threads.find((entry) => entry.id === command.threadId);
  const project = readModel.projects.find((entry) => entry.id === thread?.projectId);
  if (!project?.workspaceRoot) return undefined;
  return {
    executionTargetId: targetOf(project),
    workspaceRoot: project.workspaceRoot,
    intent: "lazy",
  };
}

type SelectedSshStore = (target: string, workspaceRoot: string) => WorkspaceModeStore;

export type WorkspaceModeGateOptions = {
  readonly serverMode: RuntimeMode;
  readonly owner: string;
  readonly localStore?: WorkspaceModeStore;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
} & (
  | {
      /** Exclusive for SSH reservations in this gate. The owner admits the exact target and root. */
      readonly sshOwner: WorkspaceModeSshOwner;
      readonly selectedSshStore?: never;
      readonly sshStore?: never;
    }
  | {
      /** Fixture-local records, guarded by fresh native admission; not a conversion store. */
      readonly selectedSshStore: SelectedSshStore;
      readonly sshOwner?: never;
      readonly sshStore?: never;
    }
  | {
      readonly sshOwner?: never;
      readonly selectedSshStore?: never;
      readonly sshStore?: (executionTargetId: string) => WorkspaceModeStore;
    }
);

export interface WorkspaceModeGateShape {
  readonly check: (
    command: OrchestrationCommand,
    readModel: OrchestrationReadModel,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
  /** For conversion: the store and mode this backend uses a folder in, if any. */
  readonly resolve: (
    executionTargetId: string,
  ) => { readonly store: WorkspaceModeStore; readonly mode: WorkspaceRuntimeMode } | undefined;
  readonly forget: (executionTargetId: string) => void;
}

export class WorkspaceModeGate extends ServiceMap.Service<
  WorkspaceModeGate,
  WorkspaceModeGateShape
>()("bigbud/remote-backend/WorkspaceModeGate") {}

export function makeWorkspaceModeGate(options: WorkspaceModeGateOptions): WorkspaceModeGateShape {
  const ttl = options.cacheTtlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const confirmed = new Map<string, number>();
  const localStore = options.localStore ?? makeLocalWorkspaceModeStore();
  const sshStore = options.sshStore ?? ((target: string) => makeSshWorkspaceModeStore(target));
  const { sshOwner } = options;
  const selectedSshStore: SelectedSshStore | undefined = sshOwner
    ? (target, workspaceRoot) =>
        // Each check gets its own observation, not a mutable store shared by concurrent checks.
        makeSshWorkspaceModeStore(target, undefined, { owner: sshOwner, workspaceRoot })
    : options.selectedSshStore;

  const resolve = (executionTargetId: string) => {
    if (isLocalExecutionTargetId(executionTargetId))
      return options.serverMode === "remote"
        ? { store: localStore, mode: "remote-runtime" as const }
        : undefined;
    // The selected SSH capability is for reservation only, not mode conversion.
    return selectedSshStore === undefined && parseSshExecutionTarget(executionTargetId)
      ? { store: sshStore(executionTargetId), mode: "laptop-runtime" as const }
      : undefined;
  };

  const check = Effect.fn("WorkspaceModeGate.check")(function* (
    command: OrchestrationCommand,
    readModel: OrchestrationReadModel,
  ) {
    const request = workspaceModeRequest(command, readModel);
    if (!request) return;
    const { executionTargetId, workspaceRoot } = request;
    const selected = parseSshExecutionTarget(executionTargetId) ? selectedSshStore : undefined;
    const resolved = selected
      ? {
          openStore: () => selected(executionTargetId, workspaceRoot),
          mode: "laptop-runtime" as const,
        }
      : resolve(executionTargetId);
    if (!resolved) return;
    const { mode } = resolved;
    const cacheKey = `${executionTargetId}\0${workspaceRoot}`;
    // The legacy TTL cannot prove that an owner grant is still valid in the current generation.
    if (!selected && (confirmed.get(cacheKey) ?? 0) > now()) return;
    const host = isLocalExecutionTargetId(executionTargetId) ? "this host" : executionTargetId;
    const outcome = yield* Effect.tryPromise({
      try: async () => {
        const store = "openStore" in resolved ? resolved.openStore() : resolved.store;
        const reservation = await reserveWorkspaceMode(store, workspaceRoot, mode, options.owner);
        if (selected && reservation.kind === "unsupported") throw new Error(reservation.reason);
        return reservation;
      },
      catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
    }).pipe(Effect.result);
    if (outcome._tag === "Failure") {
      if (request.intent === "lazy" && !selected) {
        yield* Effect.logWarning("workspace mode lazy claim skipped", {
          host,
          cause: outcome.failure,
        });
        confirmed.set(cacheKey, now() + ttl);
        return;
      }
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: `Could not reserve '${request.workspaceRoot}' on ${host} for ${resolved.mode} use: ${outcome.failure} Check the connection and folder, then retry.`,
      });
    }
    if (outcome.success.kind === "conflict")
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: workspaceModeConflictMessage({
          requested: resolved.mode,
          workspaceRoot: request.workspaceRoot,
          host,
        }),
      });
    if (!selected) confirmed.set(cacheKey, now() + ttl);
  });

  return {
    check,
    resolve,
    forget: (executionTargetId) => {
      for (const key of confirmed.keys())
        if (key.startsWith(`${executionTargetId}\0`)) confirmed.delete(key);
    },
  };
}

function makeDevSelectedSshStore(
  dev: NonNullable<(typeof DevSshOwnerRuntime.Service)["session"]>,
): SelectedSshStore {
  if (dev.kind !== "unix") {
    const profile = dev.kind === "windows" ? "Windows" : "Linux jump";
    return () => {
      throw new Error(`The ${profile} Rust SSH owner fixture cannot reserve a workspace.`);
    };
  }

  // The disposable sshd serves the same workspace directory. Keep reservation records outside
  // the remote shell's view; the native owner admits the cwd but never publishes the record.
  const store = makeLocalWorkspaceModeStore({ home: dev.fixture.root });
  return (target, workspaceRoot) => {
    if (target !== dev.targetId || workspaceRoot !== dev.fixture.folder) {
      throw new Error("Only the disposable Rust SSH owner workspace can be reserved.");
    }
    const withAdmission = <A>(use: () => Promise<A>) =>
      dev.picker.withOwner(target, async (owner) => {
        await probeSelectedSshOwnerWorkspaceReadiness(owner, {
          executionTargetId: target,
          workspaceRoot,
        });
        // Keep the picker queue through the local store operation so a connection transition
        // cannot overtake an admitted read or write.
        return use();
      });
    return {
      inspect: () => withAdmission(() => store.inspect(workspaceRoot)),
      publish: (record) =>
        withAdmission(async () => {
          const current = await store.inspect(workspaceRoot);
          if (
            current.kind !== "ready" ||
            current.identity.realpathSha256 !== record.realpathSha256 ||
            current.identity.accountUid !== record.accountUid ||
            current.identity.hostIdentity !== record.hostIdentity
          ) {
            throw new Error("The reservation does not match the disposable workspace identity.");
          }
          return store.publish(record);
        }),
    };
  };
}

export const WorkspaceModeGateLive = Layer.effect(
  WorkspaceModeGate,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const devOwner = yield* Effect.serviceOption(DevSshOwnerRuntime);
    const dev = devOwner._tag === "Some" ? devOwner.value.session : undefined;
    return makeWorkspaceModeGate({
      serverMode: config.mode,
      owner: workspaceModeOwnerId(machineIdentity() ?? os.hostname(), config.stateDir),
      ...(dev ? { selectedSshStore: makeDevSelectedSshStore(dev) } : {}),
    });
  }),
);
