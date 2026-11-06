import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import {
  BUILT_IN_CHATS_PROJECT_ID,
  isLocalExecutionTargetId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { recordedWorktreePathsOverlap } from "../deletion/Layers/ThreadDeletion.worktreePaths.ts";
import {
  authorizeNativeWorkspaceCommit,
  nativeWorkspaceCommitEvents,
} from "./ProjectWorkspace.engineTransition.ts";

export function projectWorkspacePersistenceError(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
) {
  return <E>(error: E): E | OrchestrationCommandInvariantError => {
    if (command.type !== "project.reconfigure" || command.workspaceAction !== "transfer")
      return error;
    const source = readModel.projects.find(
      (project) => project.id === command.projectId,
    )?.workspaceRoot;
    return new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail: `Could not confirm the folder change. Originals remain at '${source}'; copied files may exist at '${command.workspaceRoot}'. Check the project and command outcome before retrying. Neither folder was deleted or cleared. Persistence error: ${String(error)}`,
    });
  };
}

/** IDs, not names, are the durable allocation key; encoding also prevents traversal. */
export async function allocateManagedWorkspace(stateDir: string, projectId: string) {
  const root = path.join(
    stateDir,
    "project-workspaces",
    Buffer.from(projectId).toString("base64url"),
  );
  await fs.mkdir(root, { recursive: true });
  if (!(await fs.lstat(root)).isDirectory())
    throw new Error("Managed workspace is not a directory.");
  return fs.realpath(root);
}

async function copyExclusive(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
  } else if (stat.isDirectory()) {
    await fs.mkdir(destination, { mode: stat.mode });
    for (const entry of await fs.readdir(source)) {
      await copyExclusive(path.join(source, entry), path.join(destination, entry));
    }
  } else if (stat.isFile()) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  } else {
    throw new Error(`Unsupported workspace entry '${source}'.`);
  }
}

/** Never merge or overwrite. Originals remain available if copying or persistence fails. */
export async function copyWorkspaceFiles(source: string, destination: string): Promise<void> {
  const from = await fs.realpath(source);
  const to = await fs.realpath(destination);
  if (recordedWorktreePathsOverlap(from, to)) {
    throw new Error(
      "Choose a destination outside the current workspace, not an ancestor or child.",
    );
  }
  if ((await fs.readdir(to)).length > 0) {
    throw new Error("The destination must be empty. Files will never be merged or overwritten.");
  }
  try {
    for (const entry of await fs.readdir(from)) {
      await copyExclusive(path.join(from, entry), path.join(to, entry));
    }
  } catch (cause) {
    throw new Error(
      `Transfer failed. Originals remain at '${from}'; inspect partial files at '${to}' before retrying.`,
      { cause },
    );
  }
}

export async function stageLocalProjectWorkspace(
  command: Extract<OrchestrationCommand, { type: "project.reconfigure" }>,
  project: OrchestrationReadModel["projects"][number],
  filesAlreadyStaged = false,
) {
  if (
    project.workspaceRoot === command.workspaceRoot ||
    !isLocalExecutionTargetId(command.workspaceExecutionTargetId)
  )
    return;
  if (!command.workspaceRoot) throw new Error("Select a directory for folder reassignment.");
  if (!(await fs.stat(command.workspaceRoot)).isDirectory())
    throw new Error("Select an existing directory for folder reassignment.");
  await fs.access(command.workspaceRoot, constants.R_OK | constants.X_OK);
  if (filesAlreadyStaged) return;
  if (project.workspaceKind === "managed" && project.workspaceRoot) {
    const entries = await fs.readdir(project.workspaceRoot);
    if (entries.length && !command.workspaceAction)
      throw new Error(
        "This managed workspace contains files. Choose Transfer files or Switch without moving files.",
      );
    if (command.workspaceAction === "transfer")
      await copyWorkspaceFiles(project.workspaceRoot, command.workspaceRoot);
  } else if (command.workspaceAction === "transfer")
    throw new Error(
      "Only managed workspace files can be transferred automatically. Switch folders without moving files instead.",
    );
}

export const prepareProjectWorkspaceEvents = Effect.fn("prepareProjectWorkspaceEvents")(function* (
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  deps: {
    stateDir: string;
    sql: SqlClient.SqlClient;
    terminal?: TerminalManagerShape;
    nativeWorkspaceOperationId?: string;
  },
) {
  if (command.type !== "project.create" && command.type !== "project.reconfigure") return events;
  const { sql, terminal } = deps;
  const nativeAuthorization = yield* authorizeNativeWorkspaceCommit(
    sql,
    command,
    deps.nativeWorkspaceOperationId,
  );
  if (command.type === "project.reconfigure") {
    const project = readModel.projects.find((entry) => entry.id === command.projectId);
    if (
      project?.workspaceRoot !== command.workspaceRoot ||
      command.workspaceExecutionTargetId !==
        (project?.workspaceExecutionTargetId ?? project?.executionTargetId) ||
      command.providerRuntimeExecutionTargetId !==
        (project?.providerRuntimeExecutionTargetId ?? project?.executionTargetId)
    ) {
      const rows = yield* sql<{ threadId: string; worktreePath: string | null }>`SELECT
        thread_id AS "threadId", worktree_path AS "worktreePath"
        FROM projection_threads WHERE project_id = ${command.projectId}`;
      const localFolderChange =
        isLocalExecutionTargetId(
          project?.workspaceExecutionTargetId ?? project?.executionTargetId,
        ) && isLocalExecutionTargetId(command.workspaceExecutionTargetId);
      const retained = localFolderChange
        ? rows.find((row) => row.worktreePath !== null)
        : undefined;
      if (retained)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${retained.threadId}' retains worktree '${retained.worktreePath}'. Remove or detach this historical worktree before changing folders.`,
        });
      for (const row of rows) {
        const nativeBindings =
          yield* sql`SELECT 1 FROM opencode_v2_shared_bindings WHERE thread_id = ${row.threadId}
          UNION ALL SELECT 1 FROM muse_session_bindings WHERE thread_id = ${row.threadId}
          UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id = ${row.threadId} AND provider_name IN ('opencodeV2','muse')
          UNION ALL SELECT 1 FROM provider_turn_admissions WHERE owner_thread_id = ${row.threadId}
            AND json_extract(binding_json, '$.provider') IN ('opencodeV2','muse') LIMIT 1`;
        if (nativeBindings.length && !nativeAuthorization)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${row.threadId}' retains provider-native history bound to the current folder. This provider cannot create a replacement session at another location without changing native ownership. Keep this project folder and create a new project for the new location; existing history is unchanged.`,
          });
        const leases =
          yield* sql`SELECT 1 FROM worktree_runtime_leases WHERE thread_id = ${row.threadId}
          UNION ALL SELECT 1 FROM thread_activity_leases WHERE thread_id = ${row.threadId}
          UNION ALL SELECT 1 FROM provider_turn_admissions WHERE owner_thread_id = ${row.threadId} AND state <> 'terminal' LIMIT 1`;
        const terminalActive = terminal?.hasActiveThread
          ? yield* terminal.hasActiveThread(row.threadId)
          : false;
        if (leases.length || terminalActive)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Stop execution and close terminals in thread '${row.threadId}' before changing its project folder.`,
          });
      }
    }
  }
  return yield* Effect.tryPromise({
    try: async () => {
      if (command.type === "project.create") {
        if (command.workspaceRoot !== null || command.projectId === BUILT_IN_CHATS_PROJECT_ID)
          return events;
        const target = command.workspaceExecutionTargetId ?? command.executionTargetId;
        if (!isLocalExecutionTargetId(target))
          throw new Error("Remote projects require a directory on the remote host.");
        const workspaceRoot = await allocateManagedWorkspace(deps.stateDir, command.projectId);
        return events.map((event) =>
          event.type === "project.created"
            ? {
                ...event,
                payload: { ...event.payload, workspaceRoot, workspaceKind: "managed" as const },
              }
            : event,
        );
      }
      const project = readModel.projects.find((entry) => entry.id === command.projectId);
      if (!project) return events;
      await stageLocalProjectWorkspace(command, project, !!nativeAuthorization);
      return nativeAuthorization ? nativeWorkspaceCommitEvents(events, readModel) : events;
    },
    catch: (cause) =>
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
