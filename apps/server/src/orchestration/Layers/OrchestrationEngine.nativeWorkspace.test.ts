import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  CommandId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import { reserveProjectWorkspaceTransition } from "../ProjectWorkspace.nativeReservation.ts";
import { copyWorkspaceFiles } from "../ProjectWorkspace.files.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

it.each(["success", "rollback", "missing-consent"] as const)(
  "real engine native finalization (%s) preserves mixed provider/model choices and history",
  async (mode) => {
    const system = await createOrchestrationSystem();
    cleanup.push(system.dispose);
    const destination = await fs.mkdtemp(path.join(tmpdir(), "bigbud-native-engine-"));
    cleanup.push(() => fs.rm(destination, { recursive: true, force: true }));
    const projectId = asProjectId("native-project");
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("create"),
        projectId,
        title: "Native project",
        workspaceRoot: null,
        createdAt: now(),
      }),
    );
    const project = (await system.run(system.engine.getReadModel())).projects.find(
      (p) => p.id === projectId,
    )!;
    cleanup.push(() => fs.rm(project.workspaceRoot!, { recursive: true, force: true }));
    for (const [name, provider, model] of [
      ["codex", "codex", "gpt-5-codex"],
      ["v2", "opencodeV2", "chosen-v2"],
    ] as const) {
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create-${name}`),
          projectId,
          threadId: ThreadId.makeUnsafe(name),
          title: name,
          modelSelection: { provider, model },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
    }
    const original = await system.run(system.engine.getReadModel());
    const command: OrchestrationCommand = {
      type: "project.reconfigure",
      commandId: CommandId.makeUnsafe("native-transfer"),
      projectId,
      title: project.title,
      executionTargetId: "local",
      workspaceExecutionTargetId: "local",
      providerRuntimeExecutionTargetId: "local",
      workspaceRoot: destination,
      expectedUpdatedAt: project.updatedAt,
      verifiedWorktreePaths: [],
      workspaceAction: "transfer",
      ...(mode !== "missing-consent"
        ? { nativeContextReset: "archive-and-reset-muse" as const }
        : {}),
    };
    const material = {
      threadId: "v2",
      nativeSessionId: "native-v2",
      storageIdentity: "storage",
      directory: project.workspaceRoot!,
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      identityKind: "shared-api-v1",
      material: "unchanged-model-material",
    };
    await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO muse_session_bindings
      (thread_id, native_session_id, creation_command_id, workspace, storage_identity, selection_fingerprint, created_at, phase, revision)
      VALUES ('codex', 'dormant-muse', 'historic-create', ${project.workspaceRoot}, 'muse-storage', 'historic-muse-model', 'now', 'bound', 1)`;
        yield* sql`INSERT INTO opencode_v2_shared_bindings (thread_id, material_json, state, revision)
      VALUES ('v2', ${JSON.stringify(material)}, 'verified', 2)`;
        yield* reserveProjectWorkspaceTransition(sql, {
          operationId: "operation",
          commandId: command.commandId,
          projectId,
          requestDigest: calculateCommandPayloadDigest(command).digest,
          requestJson: JSON.stringify(command),
          sourcePath: project.workspaceRoot!,
          destinationPath: destination,
        });
      }),
    );
    await fs.writeFile(path.join(project.workspaceRoot!, "keep"), "retained recovery");
    await copyWorkspaceFiles(project.workspaceRoot!, destination);
    await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Mocked native verification evidence: no real native service is started or mutated.
        const steps = [
          {
            provider: "muse",
            threadId: "codex",
            nativeSessionId: "dormant-muse",
            phase: "archive-ready",
          },
          {
            provider: "opencodeV2",
            threadId: "v2",
            nativeSessionId: "native-v2",
            storageIdentity: "storage",
            sourceDirectory: project.workspaceRoot,
            destinationDirectory: destination,
            phase: "verified",
            expectedIdentity: { created: 123, model: null, metadata: null },
          },
        ];
        yield* sql`UPDATE project_workspace_native_operations SET phase = 'native-verified', steps_json = ${JSON.stringify(steps)} WHERE operation_id = 'operation'`;
        if (mode === "rollback")
          yield* sql`CREATE TRIGGER reject_workspace_commit BEFORE UPDATE OF workspace_root ON projection_projects
      BEGIN SELECT RAISE(ABORT, 'injected native commit failure'); END`;
      }),
    );
    const dispatch = system.run(
      system.engine.dispatch(command, { nativeWorkspaceOperationId: "operation" }),
    );
    if (mode === "success") await dispatch;
    else
      await expect(dispatch).rejects.toThrow(
        mode === "missing-consent" ? "Explicit Muse" : "Could not confirm the folder change",
      );
    const current = await system.run(system.engine.getReadModel());
    expect(current.projects.find((p) => p.id === projectId)?.workspaceRoot).toBe(
      mode === "success" ? destination : project.workspaceRoot,
    );
    for (const before of original.threads.filter((t) => t.projectId === projectId)) {
      const after = current.threads.find((t) => t.id === before.id)!;
      expect(after.modelSelection).toEqual(before.modelSelection);
      expect(after.messages).toEqual(before.messages);
      expect(after.projectId).toBe(before.projectId);
    }
    const state = await system.runSql(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          operation:
            yield* sql`SELECT phase, result_sequence FROM project_workspace_native_operations`,
          archives:
            yield* sql`SELECT provider FROM provider_workspace_binding_archives ORDER BY provider`,
          muse: yield* sql`SELECT * FROM muse_session_bindings`,
          v2: yield* sql<{
            material: string;
          }>`SELECT material_json AS material FROM opencode_v2_shared_bindings`,
          receipt:
            yield* sql`SELECT status, result_sequence FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`,
        };
      }),
    );
    if (mode === "success") {
      expect(state.archives).toEqual([{ provider: "muse" }, { provider: "opencodeV2" }]);
      expect(state.muse).toEqual([]);
      expect(JSON.parse(state.v2[0]!.material)).toEqual({ ...material, directory: destination });
      expect(state.receipt[0]).toMatchObject({
        status: "accepted",
        result_sequence: state.operation[0]!.result_sequence,
      });
      expect(state.operation[0]!.phase).toBe("committed");
      // Accepted retry observes the receipt; it never copies or archives a second time.
      await system.run(
        system.engine.dispatch(command, { nativeWorkspaceOperationId: "operation" }),
      );
    } else {
      expect(state.archives).toEqual([]);
      expect(state.muse).toHaveLength(1);
      expect(JSON.parse(state.v2[0]!.material)).toEqual(material);
      expect(state.operation[0]!.phase).toBe("native-verified");
      if (mode === "rollback") {
        await system.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER reject_workspace_commit`;
          }),
        );
        await system.run(
          system.engine.dispatch(command, { nativeWorkspaceOperationId: "operation" }),
        );
        expect(
          (await system.run(system.engine.getReadModel())).projects.find((p) => p.id === projectId)
            ?.workspaceRoot,
        ).toBe(destination);
        const recovered = await system.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT status FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`;
          }),
        );
        expect(recovered).toEqual([{ status: "accepted" }]);
      }
    }
    for (const root of [project.workspaceRoot!, destination])
      expect(await fs.readFile(path.join(root, "keep"), "utf8")).toBe("retained recovery");
  },
);
