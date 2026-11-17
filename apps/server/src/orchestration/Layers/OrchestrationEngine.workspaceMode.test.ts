import { CommandId } from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeWorkspaceModeGate } from "../../remote-backend/workspaceMode.gate.ts";
import { reserveWorkspaceMode } from "../../remote-backend/workspaceMode.reserve.ts";
import {
  makeWorkspaceModeFixture,
  OWNER_A,
  OWNER_B,
} from "../../remote-backend/workspaceMode.test.helpers.ts";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).toReversed()) await dispose();
});

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "engine workspace mode reservation",
  () => {
    it("reserves before committing an SSH project and refuses the opposite mode", async () => {
      const f = makeWorkspaceModeFixture();
      cleanup.push(f.close);
      const system = await createOrchestrationSystem({
        workspaceModeGate: makeWorkspaceModeGate({
          serverMode: "desktop",
          owner: OWNER_A,
          localStore: f.localStore,
          sshStore: () => f.shellStore,
        }),
      });
      cleanup.push(system.dispose);
      const create = (id: string, workspaceRoot: string) =>
        system.run(
          system.engine
            .dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe(`create-${id}`),
              projectId: asProjectId(id),
              title: id,
              workspaceExecutionTargetId: "ssh:devbox",
              executionTargetId: "ssh:devbox",
              workspaceRoot,
              createdAt: now(),
            })
            .pipe(
              Effect.flip,
              Effect.orElseSucceed(() => undefined),
            ),
        );

      expect(await create("laptop", f.workspace)).toBeUndefined();
      expect(await f.shellStore.inspect(f.workspace)).toMatchObject({
        current: { mode: "laptop-runtime", owner: OWNER_A },
      });

      const owned = `${f.base}/projects`;
      await reserveWorkspaceMode(f.localStore, owned, "remote-runtime", OWNER_B);
      const refused = await create("refused", owned);
      expect(String((refused as { detail?: string } | undefined)?.detail)).toContain(
        "is a remote-runtime workspace: the bigbud backend on that host owns it",
      );
      const projects = (await system.run(system.engine.getReadModel())).projects;
      expect(projects.map((project) => project.id)).not.toContain("refused");
    });
  },
);
