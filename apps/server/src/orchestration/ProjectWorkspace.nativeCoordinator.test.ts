import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  CommandId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  asProjectId,
  createOrchestrationSystem,
  now,
} from "./Layers/OrchestrationEngine.test.helpers.ts";
import { makeProjectWorkspaceNativeCoordinator } from "./ProjectWorkspace.nativeCoordinator.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";

it.each([
  "muse",
  "ready-handle",
  "missing-consent",
  "unqualified-v2",
  "qualified-v2",
  "uncertain-v2",
  "rollback-retry",
] as const)(
  "production native coordinator uses actual staging and engine commit (%s)",
  async (mode) => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "bigbud-native-coordinator-"));
    const destination = path.join(root, "destination");
    await fs.mkdir(destination);
    const system = await createOrchestrationSystem();
    let source: string | undefined;
    try {
      const projectId = asProjectId("coordinator-project");
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("create"),
          projectId,
          title: "Coordinator",
          workspaceRoot: null,
          createdAt: now(),
        }),
      );
      const project = (await system.run(system.engine.getReadModel())).projects.find(
        (entry) => entry.id === projectId,
      )!;
      source = project.workspaceRoot!;
      await fs.writeFile(path.join(source, "keep"), "original recovery copy");
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("thread"),
          projectId,
          threadId: ThreadId.makeUnsafe("cold"),
          title: "Dormant native owner",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        }),
      );
      if (mode === "ready-handle") {
        await system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("ready"),
            threadId: ThreadId.makeUnsafe("cold"),
            createdAt: now(),
            session: {
              threadId: ThreadId.makeUnsafe("cold"),
              providerName: "muse",
              status: "ready",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: now(),
            },
          }),
        );
      }
      const before = await system.run(system.engine.getReadModel());
      const command: OrchestrationCommand = {
        type: "project.reconfigure",
        commandId: CommandId.makeUnsafe("transfer"),
        projectId,
        title: project.title,
        workspaceRoot: destination,
        expectedUpdatedAt: project.updatedAt,
        verifiedWorktreePaths: [],
        executionTargetId: "local",
        workspaceExecutionTargetId: "local",
        providerRuntimeExecutionTargetId: "local",
        workspaceAction: "transfer",
        ...(mode !== "missing-consent"
          ? { nativeContextReset: "archive-and-reset-muse" as const }
          : {}),
      };
      await system.runSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (mode === "unqualified-v2" || mode === "qualified-v2" || mode === "uncertain-v2") {
            yield* sql`INSERT INTO opencode_v2_shared_bindings (thread_id, material_json, state, revision)
            VALUES ('cold', ${JSON.stringify({
              threadId: "cold",
              nativeSessionId: "native",
              storageIdentity: "storage",
              directory: source,
              runtimeTargetId: "local",
              workspaceTargetId: "local",
              identityKind: "shared-api-v1",
              material: "retained-model",
            })}, 'verified', 1)`;
          } else {
            yield* sql`INSERT INTO muse_session_bindings
            (thread_id, native_session_id, creation_command_id, workspace, storage_identity, selection_fingerprint, created_at, phase, revision)
            VALUES ('cold', 'native', 'historic', ${source}, 'storage', 'historic-model', 'now', 'bound', 1)`;
          }
          if (mode === "rollback-retry")
            yield* sql`CREATE TRIGGER fail_coordinator_commit BEFORE UPDATE OF workspace_root ON projection_projects
          BEGIN SELECT RAISE(ABORT, 'injected coordinator commit failure'); END`;
        }),
      );
      let stops = 0;
      let moves = 0;
      let inspectionAvailable = mode !== "uncertain-v2";
      const coordinate = await system.runSql(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return makeProjectWorkspaceNativeCoordinator({
            sql,
            engine: system.engine,
            receipts: yield* OrchestrationCommandReceiptRepository,
            ...(mode === "qualified-v2" || mode === "uncertain-v2"
              ? {
                  v2: {
                    move: (_step, beforeDispatch) =>
                      Effect.gen(function* () {
                        yield* beforeDispatch({ created: 123, model: null, metadata: null });
                        const journal =
                          yield* sql`SELECT phase FROM project_workspace_native_operations`;
                        expect(journal).toEqual([{ phase: "native-dispatched" }]);
                        const fence =
                          yield* sql`SELECT 1 FROM worktree_operations WHERE phase NOT IN ('completed', 'rejected')`;
                        expect(fence).toHaveLength(1);
                        moves += 1;
                      }),
                    inspect: (step) =>
                      inspectionAvailable
                        ? Effect.succeed({
                            nativeSessionId: step.nativeSessionId,
                            storageIdentity: step.storageIdentity,
                            directory: step.destinationDirectory,
                            identity: { created: 123, model: null, metadata: null },
                          })
                        : Effect.fail(new Error("mocked uncertain native inspection")),
                  },
                }
              : {}),
            registry: {
              listProviders: () => Effect.succeed(mode === "ready-handle" ? ["muse"] : []),
              getByProvider: () =>
                mode !== "ready-handle"
                  ? Effect.die(new Error("No adapters may be started for a dormant binding"))
                  : Effect.succeed({
                      listSessions: () =>
                        Effect.succeed([
                          {
                            provider: "muse",
                            threadId: ThreadId.makeUnsafe("cold"),
                            status: "ready",
                            runtimeMode: "approval-required",
                            createdAt: now(),
                            updatedAt: now(),
                          },
                        ]),
                      stopSession: () =>
                        Effect.gen(function* () {
                          // This callback runs at the real idle-close boundary, before filesystem staging.
                          for (const cwd of [source!, destination, "/unrelated-cwd-alias"]) {
                            const admission = yield* sql`INSERT INTO worktree_runtime_leases
                          (lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at)
                          VALUES ('racing-terminal', 'cold', 'terminal', ${cwd}, 123, 456, 'now', 'now')`.pipe(
                              Effect.result,
                            );
                            expect(admission._tag).toBe("Failure");
                          }
                          const racingStart = yield* system.engine
                            .dispatch({
                              type: "thread.session.set",
                              commandId: CommandId.makeUnsafe("racing-ready"),
                              threadId: ThreadId.makeUnsafe("cold"),
                              createdAt: now(),
                              session: {
                                ...before.threads[0]!.session!,
                                status: "ready",
                                updatedAt: now(),
                              },
                            })
                            .pipe(Effect.result);
                          expect(racingStart._tag).toBe("Failure");
                          stops += 1;
                        }),
                    } as unknown as ProviderAdapterShape<ProviderAdapterError>),
            },
          });
        }).pipe(Effect.provide(OrchestrationCommandReceiptRepositoryLive)),
      );
      if (mode === "missing-consent" || mode === "unqualified-v2") {
        await expect(system.run(coordinate(command))).rejects.toThrow(
          mode === "missing-consent" ? "Explicit Muse" : "not qualified",
        );
        expect(await fs.readdir(destination)).toEqual([]);
        const journals = await system.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT * FROM project_workspace_native_operations`;
          }),
        );
        expect(journals).toEqual([]);
        const outcome = await system.run(system.engine.getCommandOutcome!(command.commandId));
        expect(outcome).toMatchObject({
          status: "rejected",
          detail: expect.stringContaining(
            mode === "missing-consent" ? "Explicit Muse" : "not qualified",
          ),
        });
        await expect(system.run(coordinate(command))).rejects.toThrow();
        // Changing the payload cannot reuse a refused ID to stage files or reset context.
        await expect(
          system.run(coordinate({ ...command, nativeContextReset: "archive-and-reset-muse" })),
        ).rejects.toThrow();
        expect(await fs.readdir(destination)).toEqual([]);
        if (mode === "missing-consent") {
          await system.run(
            coordinate({
              ...command,
              commandId: CommandId.makeUnsafe("consented-new-request"),
              nativeContextReset: "archive-and-reset-muse",
            }),
          );
          const after = await system.run(system.engine.getReadModel());
          expect(after.projects.find((entry) => entry.id === projectId)?.workspaceRoot).toBe(
            destination,
          );
          expect(after.threads[0]?.modelSelection).toEqual(before.threads[0]?.modelSelection);
        }
      } else {
        if (mode === "rollback-retry") {
          await expect(system.run(coordinate(command))).rejects.toThrow("retained for recovery");
          await system.runSql(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`DROP TRIGGER fail_coordinator_commit`;
            }),
          );
          // A second exclusive transfer would fail because destination is populated: retry must inspect only.
        }
        if (mode === "uncertain-v2") {
          await expect(system.run(coordinate(command))).rejects.toThrow("retained for recovery");
          expect(moves).toBe(1);
          expect(
            await system.run(system.engine.getCommandOutcome!(command.commandId)),
          ).toMatchObject({
            status: "unknown",
            workspaceTransition: {
              phase: "recovery-required",
              sourcePath: source,
              destinationPath: destination,
              steps: [{ provider: "opencodeV2", nativeSessionId: "native" }],
            },
          });
          await expect(system.run(coordinate(command))).rejects.toThrow(
            "still requires explicit recovery",
          );
          expect(moves).toBe(1);
          inspectionAvailable = true;
        }
        const accepted = await system.run(coordinate(command));
        // A lost success response replays the receipt, never the copy or native move.
        expect(await system.run(coordinate(command))).toEqual(accepted);
        if (mode === "qualified-v2" || mode === "uncertain-v2") expect(moves).toBe(1);
        expect(stops).toBe(mode === "ready-handle" ? 1 : 0);
        const after = await system.run(system.engine.getReadModel());
        expect(after.projects.find((entry) => entry.id === projectId)?.workspaceRoot).toBe(
          destination,
        );
        expect(after.threads[0]?.modelSelection).toEqual(before.threads[0]?.modelSelection);
        expect(after.threads[0]?.messages).toEqual(before.threads[0]?.messages);
        const result = await system.runSql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              journals: yield* sql`SELECT phase FROM project_workspace_native_operations`,
              archives: yield* sql`SELECT provider FROM provider_workspace_binding_archives`,
              bindings: yield* sql`SELECT * FROM muse_session_bindings`,
            };
          }),
        );
        expect(result.journals).toEqual([{ phase: "committed" }]);
        expect(result.archives).toEqual([
          { provider: mode === "qualified-v2" || mode === "uncertain-v2" ? "opencodeV2" : "muse" },
        ]);
        expect(result.bindings).toEqual([]);
        expect(await fs.readFile(path.join(destination, "keep"), "utf8")).toBe(
          "original recovery copy",
        );
      }
      expect(await fs.readFile(path.join(source, "keep"), "utf8")).toBe("original recovery copy");
    } finally {
      await system.dispose();
      if (source) await fs.rm(source, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
