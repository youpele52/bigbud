import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { convertBackendWorkspaceMode } from "./workspaceMode.conversion.ts";
import { makeWorkspaceModeGate } from "./workspaceMode.gate.ts";
import type { WorkspaceModeStore } from "./workspaceMode.record.ts";
import { reserveWorkspaceMode } from "./workspaceMode.reserve.ts";
import { makeWorkspaceModeFixture, OWNER_A, OWNER_B } from "./workspaceMode.test.helpers.ts";

const SSH = "ssh:devbox";
const command = (value: object) => value as unknown as OrchestrationCommand;
const readModel = (projects: object[], threads: object[] = []) =>
  ({ projects, threads }) as unknown as OrchestrationReadModel;
const failure = (effect: Effect.Effect<void, { detail: string }>) =>
  Effect.runPromise(effect.pipe(Effect.flip)).then((error) => error.detail);

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "workspace mode gate",
  () => {
    let f: ReturnType<typeof makeWorkspaceModeFixture> | undefined;
    afterEach(() => {
      f?.close();
      f = undefined;
    });

    const gates = (
      fixture: ReturnType<typeof makeWorkspaceModeFixture>,
      sshStore?: WorkspaceModeStore,
    ) => ({
      laptop: makeWorkspaceModeGate({
        serverMode: "desktop",
        owner: OWNER_A,
        localStore: fixture.localStore,
        sshStore: () => sshStore ?? fixture.shellStore,
      }),
      remote: makeWorkspaceModeGate({
        serverMode: "remote",
        owner: OWNER_B,
        localStore: fixture.localStore,
      }),
    });

    it("remote_project_refused_on_laptop_runtime_workspace", async () => {
      f = makeWorkspaceModeFixture();
      const { laptop, remote } = gates(f);
      const create = (target: string) =>
        command({
          type: "project.create",
          projectId: "p",
          workspaceExecutionTargetId: target,
          workspaceRoot: f!.workspace,
        });
      await Effect.runPromise(laptop.check(create(SSH), readModel([])));
      expect(await failure(remote.check(create("local"), readModel([])))).toContain(
        "is a laptop-runtime workspace: a laptop bigbud backend runs providers against it over SSH. Open it from that laptop instead",
      );
    });

    it("refuses creation when the reservation cannot be established", async () => {
      f = makeWorkspaceModeFixture();
      const broken: WorkspaceModeStore = {
        inspect: async () => {
          throw new Error("ssh: connect to host devbox port 22: Connection refused");
        },
        publish: async () => "conflict",
      };
      const { laptop } = gates(f, broken);
      const create = command({
        type: "project.create",
        projectId: "p",
        workspaceExecutionTargetId: SSH,
        workspaceRoot: "/srv/app",
      });
      expect(await failure(laptop.check(create, readModel([])))).toContain(
        "Could not reserve '/srv/app' on ssh:devbox for laptop-runtime use: ssh: connect to host devbox",
      );
    });

    it("existing_project_claims_lazily", async () => {
      f = makeWorkspaceModeFixture();
      const { laptop, remote } = gates(f);
      const project = { id: "p", workspaceRoot: f.workspace, workspaceExecutionTargetId: SSH };
      const turn = command({ type: "thread.turn.start", threadId: "t" });
      // A project created before WP-4A has no reservation; its next turn claims the current mode.
      expect(await f.shellStore.inspect(f.workspace)).toMatchObject({ current: null });
      await Effect.runPromise(
        laptop.check(turn, readModel([project], [{ id: "t", projectId: "p" }])),
      );
      expect(await f.shellStore.inspect(f.workspace)).toMatchObject({
        current: { mode: "laptop-runtime", owner: OWNER_A, generation: 1 },
      });
      // The opposite mode is now refused on the remote backend's existing project too.
      const local = { id: "q", workspaceRoot: f.workspace, workspaceExecutionTargetId: "local" };
      expect(
        await failure(remote.check(turn, readModel([local], [{ id: "t", projectId: "q" }]))),
      ).toContain("laptop-runtime workspace");
    });

    it("an unreachable store does not block an existing project's turn", async () => {
      f = makeWorkspaceModeFixture();
      let calls = 0;
      const broken: WorkspaceModeStore = {
        inspect: async () => {
          calls++;
          throw new Error("timeout");
        },
        publish: async () => "conflict",
      };
      const { laptop } = gates(f, broken);
      const model = readModel(
        [{ id: "p", workspaceRoot: "/srv/app", executionTargetId: SSH }],
        [{ id: "t", projectId: "p" }],
      );
      const turn = command({ type: "thread.message.submit", threadId: "t" });
      await Effect.runPromise(laptop.check(turn, model));
      await Effect.runPromise(laptop.check(turn, model));
      expect(calls).toBe(1); // Cached, so a down host does not add latency to every turn.
    });

    it("desktop backends reserve nothing for local folders", async () => {
      f = makeWorkspaceModeFixture();
      const { laptop } = gates(f);
      const create = command({
        type: "project.create",
        projectId: "p",
        workspaceRoot: f.workspace,
      });
      await Effect.runPromise(laptop.check(create, readModel([])));
      expect(await f.localStore.inspect(f.workspace)).toMatchObject({ current: null });
    });

    it("convert_refused_while_busy through the backend entry point", async () => {
      f = makeWorkspaceModeFixture();
      const { remote } = gates(f);
      await reserveWorkspaceMode(f.localStore, f.workspace, "remote-runtime", OWNER_B);
      const idleSql = (() => Effect.succeed([])) as unknown as SqlClient.SqlClient;
      const projects = [
        { id: "p", workspaceRoot: `${f.workspace}/.`, workspaceExecutionTargetId: "local" },
      ];
      const convert = (session: object | null) =>
        Effect.runPromise(
          convertBackendWorkspaceMode({
            gate: remote,
            sql: idleSql,
            terminal: undefined,
            readModel: readModel(projects, [{ id: "t", projectId: "p", session }]),
            executionTargetId: "local",
            workspaceRoot: f!.workspace,
            targetMode: "laptop-runtime",
          }),
        );
      // The project names the folder through an alias path; it still counts.
      expect(await convert({ status: "running" })).toMatchObject({
        kind: "refused",
        reason: expect.stringContaining("thread 't' has a running turn."),
      });
      expect(await convert({ status: "ready" })).toMatchObject({
        kind: "converted",
        record: { mode: "laptop-runtime", owner: null },
      });
    });
  },
);
