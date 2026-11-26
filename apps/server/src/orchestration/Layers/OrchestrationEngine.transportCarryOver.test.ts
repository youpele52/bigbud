import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { prepareProjectWorkspaceEvents } from "../ProjectWorkspace.files.ts";
import { v2RemoteLocationIdentity } from "../../provider/Layers/OpencodeV2/Application.remoteLocation.ts";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;
const direct = "ssh:host=dev-1&auth=password&transport=direct-ssh";
const agent = "ssh:host=dev-1&auth=password&transport=agent";
const root = "/root/project";
const locationOf = (target: string) =>
  `/state/opencode-v2-remote-workspaces/${v2RemoteLocationIdentity("remote-v2-thread", target, root)}`;
const directory = locationOf(direct);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

async function fixture(previous = direct) {
  const directory = locationOf(previous);
  const system = await createOrchestrationSystem();
  cleanup.push(system.dispose);
  const projectId = asProjectId("remote-project");
  const threadId = ThreadId.makeUnsafe("remote-v2-thread");
  let id = 0;
  const dispatch = (command: WithoutCommandId<OrchestrationCommand>) =>
    system.run(
      system.engine.dispatch({
        ...command,
        commandId: CommandId.makeUnsafe(`transport-${++id}`),
      } as OrchestrationCommand),
    );
  await dispatch({
    type: "project.create",
    projectId,
    title: "Remote",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: previous,
    executionTargetId: previous,
    workspaceRoot: root,
    createdAt: now(),
  });
  await dispatch({
    type: "thread.create",
    threadId,
    projectId,
    title: "Native history",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: now(),
  });
  const identity = { threadId, nativeSessionId: "ses_native", storageIdentity: "storage" };
  await system.runSql(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const material = {
        ...identity,
        directory,
        runtimeTargetId: "local",
        workspaceTargetId: previous,
        identityKind: "shared-api-v1",
        material: "digest",
      };
      yield* sql`INSERT INTO opencode_v2_shared_bindings (thread_id, material_json, state, revision)
        VALUES (${threadId}, ${JSON.stringify(material)}, 'verified', 2)`;
      const binding = {
        provider: "opencodeV2",
        ...identity,
        location: directory,
        runtimeTargetId: "local",
        workspaceTargetId: previous,
      };
      yield* sql`INSERT INTO provider_turn_admissions
        (namespace, owner_thread_id, request_message_id, binding_json, fingerprint, native_admission_id, turn_id, state, created_at, updated_at)
        VALUES ('foreground', ${threadId}, 'message', ${JSON.stringify(binding)}, 'immutable', 'native-message', 'turn', 'terminal', 'now', 'now')`;
      const cursor = { provider: "opencodeV2", ...identity, directory };
      const payload = {
        cwd: root,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: previous,
        executionTargetId: previous,
      };
      yield* sql`INSERT INTO provider_session_runtime
        (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json, runtime_payload_json,
          provider_runtime_execution_target_id, workspace_execution_target_id, execution_target_id)
        VALUES (${threadId}, 'opencodeV2', 'opencodeV2', 'stopped', 'now', ${JSON.stringify(cursor)},
          ${JSON.stringify(payload)}, 'local', ${previous}, ${previous})`;
    }),
  );
  const project = async () =>
    (await system.run(system.engine.getReadModel())).projects.find((p) => p.id === projectId)!;
  const reconfigure = async (target: string, workspaceRoot = root) => {
    const current = await project();
    return dispatch({
      type: "project.reconfigure",
      projectId,
      title: current.title,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: target,
      executionTargetId: target,
      workspaceRoot,
      expectedUpdatedAt: current.updatedAt,
      verifiedWorktreePaths: [],
    });
  };
  const rows = () =>
    system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [binding] = yield* sql<{ materialJson: string; revision: number }>`SELECT
          material_json AS "materialJson", revision FROM opencode_v2_shared_bindings WHERE thread_id = ${threadId}`;
        const [admission] = yield* sql<{ bindingJson: string }>`SELECT binding_json AS "bindingJson"
          FROM provider_turn_admissions WHERE owner_thread_id = ${threadId}`;
        const [runtime] = yield* sql<Record<string, string>>`SELECT
          workspace_execution_target_id AS "workspace", execution_target_id AS "execution",
          provider_runtime_execution_target_id AS "runtime", runtime_payload_json AS "payload",
          resume_cursor_json AS "cursor"
          FROM provider_session_runtime WHERE thread_id = ${threadId}`;
        return {
          binding: { ...JSON.parse(binding!.materialJson), revision: binding!.revision },
          admission: JSON.parse(admission!.bindingJson),
          runtime: { ...runtime!, payload: JSON.parse(runtime!.payload!) },
          cursor: JSON.parse(runtime!.cursor!),
        };
      }),
    );
  return { system, projectId, threadId, reconfigure, rows, project };
}

describe("transport-only project reconfiguration", () => {
  it("rebinds retained OpenCode V2 history to the new transport without changing its session", async () => {
    const f = await fixture();
    const before = await f.rows();
    await f.reconfigure(agent);
    const after = await f.rows();
    expect((await f.project()).workspaceExecutionTargetId).toBe(agent);
    expect(after.binding).toMatchObject({
      nativeSessionId: "ses_native",
      storageIdentity: "storage",
      directory,
      runtimeTargetId: "local",
      workspaceTargetId: agent,
      revision: before.binding.revision + 1,
    });
    expect(after.admission).toEqual({ ...before.admission, workspaceTargetId: agent });
    expect(after.runtime).toMatchObject({
      workspace: agent,
      execution: agent,
      runtime: "local",
      payload: { cwd: root, workspaceExecutionTargetId: agent, executionTargetId: agent },
    });
    expect(after.cursor).toEqual(before.cursor);
    // Switching back is also transport-only and restores the original target IDs.
    await f.reconfigure(direct);
    expect((await f.rows()).binding).toMatchObject({ workspaceTargetId: direct, directory });
  });

  it.each([
    ["host", "ssh:host=dev-2&auth=password&transport=agent", root],
    ["user", "ssh:host=dev-1&user=other&auth=password&transport=agent", root],
    ["path", agent, "/root/other"],
  ])("still refuses a %s change with retained native history", async (_label, target, path) => {
    const f = await fixture();
    const before = await f.rows();
    await expect(f.reconfigure(target, path)).rejects.toThrow("provider-native history");
    expect(await f.rows()).toEqual(before);
  });

  it("refuses a transport switch while the thread holds an activity lease or live session", async () => {
    const f = await fixture();
    const before = await f.rows();
    await f.system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
          VALUES ('lease', ${f.threadId}, 'computer-use', 'now')`;
      }),
    );
    await expect(f.reconfigure(agent)).rejects.toThrow("Stop execution");
    await f.system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM thread_activity_leases`;
        yield* sql`UPDATE provider_session_runtime SET status = 'running' WHERE thread_id = ${f.threadId}`;
      }),
    );
    await expect(f.reconfigure(agent)).rejects.toThrow("Stop the OpenCode session");
    expect((await f.rows()).binding).toEqual(before.binding);
  });

  it("refuses a transport switch while a thread terminal is active", async () => {
    const f = await fixture();
    const project = await f.project();
    const readModel = await f.system.run(f.system.engine.getReadModel());
    const terminal = {
      hasActiveThread: (threadId: string) => Effect.succeed(threadId === f.threadId),
    } as unknown as TerminalManagerShape;
    const command = {
      type: "project.reconfigure",
      commandId: CommandId.makeUnsafe("terminal-check"),
      projectId: f.projectId,
      title: project.title,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: agent,
      executionTargetId: agent,
      workspaceRoot: root,
      expectedUpdatedAt: project.updatedAt,
      verifiedWorktreePaths: [],
    } as OrchestrationCommand;
    const exit = await f.system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* Effect.exit(
          prepareProjectWorkspaceEvents(command, readModel, [], {
            stateDir: "/unused",
            sql,
            terminal,
          }),
        );
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("close terminals");
  });

  it("carries the legacy bare-host form and rejects forms the resolver cannot find", async () => {
    const bare = await fixture("ssh:dev-1");
    await bare.reconfigure("ssh:host=dev-1&transport=agent");
    expect((await bare.rows()).binding).toMatchObject({
      workspaceTargetId: "ssh:host=dev-1&transport=agent",
      directory: locationOf("ssh:dev-1"),
    });
    for (const [previous, next] of [
      ["ssh:auth=password&host=dev-1&transport=direct-ssh", agent],
      [
        "ssh:host=dev-1&auth=ssh-key&keyPath=/k/id&transport=direct-ssh",
        "ssh:host=dev-1&auth=ssh-key&keyPath=%2Fk%2Fid&transport=agent",
      ],
    ] as const) {
      const f = await fixture(previous);
      const before = await f.rows();
      await expect(f.reconfigure(next)).rejects.toThrow("Nothing was changed");
      expect(await f.rows()).toEqual(before);
      expect((await f.project()).workspaceExecutionTargetId).toBe(previous);
    }
  });
});
