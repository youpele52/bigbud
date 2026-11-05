import * as NodeServices from "@effect/platform-node/NodeServices";
import { BUILT_IN_CHATS_PROJECT_ID, DEFAULT_SERVER_SETTINGS, ProjectId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { expect, it, vi } from "vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { ServerConfig } from "./config.ts";
import { autoBootstrapWelcome } from "./serverRuntimeStartup.bootstrap.ts";

it("does not bootstrap a replacement runtime for an existing removed-provider preference", async () => {
  const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
  const projectId = ProjectId.makeUnsafe("old-kilo-project");
  const selection = { provider: "kilocode", model: "legacy-model" };
  const result = await Effect.runPromise(
    autoBootstrapWelcome.pipe(
      Effect.provideService(ServerConfig, {
        autoBootstrapProjectFromCwd: true,
        cwd: "/tmp/old-project",
      } as never),
      Effect.provideService(ProjectionSnapshotQuery, {
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(Option.some({ id: projectId, defaultModelSelection: selection })),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({ projects: [{ id: BUILT_IN_CHATS_PROJECT_ID }], threads: [] }),
        dispatch,
      } as never),
      Effect.provideService(ProviderRegistry, { getProviders: Effect.succeed([]) } as never),
      Effect.provideService(ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as never),
      Effect.provide(NodeServices.layer),
    ),
  );
  expect(result.bootstrapProjectId).toBe(projectId);
  expect(result).not.toHaveProperty("bootstrapThreadId");
  expect(dispatch).not.toHaveBeenCalled();
  expect(selection).toEqual({ provider: "kilocode", model: "legacy-model" });
});
