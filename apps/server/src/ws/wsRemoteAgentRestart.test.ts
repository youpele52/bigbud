import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "@bigbud/contracts/server/server.remoteRestart.ts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { RemoteAgentRestartServiceShape } from "../remote-agent/remoteAgentRestart.ts";
import {
  getRemoteAgentRestartStatusEffect,
  restartRemoteAgentEffect,
  type RemoteAgentRestartProjectSources,
} from "./wsRemoteAgentRestart.ts";

const target = "ssh:host=restart&user=deploy&auth=ssh-key";
const input = {
  requestId: "request-1",
  projectId: "project-1",
  expectedWorkspaceExecutionTargetId: target,
} as unknown as ServerRestartRemoteAgentInput;
const ready = {
  requestId: input.requestId,
  projectId: input.projectId,
  executionTargetId: input.expectedWorkspaceExecutionTargetId,
  phase: "ready",
  message: "Remote service restarted.",
} as ServerRestartRemoteAgentResult;

function service() {
  return {
    restart: vi.fn(async () => ready),
    status: vi.fn(async () => ready),
  } satisfies RemoteAgentRestartServiceShape;
}

/** Read model after a backend restart: a project without operational threads is not hydrated. */
function engine(projects: ReadonlyArray<{ id: string; workspaceExecutionTargetId: string }> = []) {
  return {
    getReadModel: () => Effect.succeed({ projects }),
  } as unknown as OrchestrationEngineShape;
}

function repository(saved: Record<string, string>, fail = false) {
  return {
    getById: ({ projectId }: { projectId: ProjectId }) =>
      fail
        ? Effect.fail(new PersistenceSqlError({ operation: "getById", detail: "locked" }))
        : Effect.succeed(
            saved[projectId] === undefined
              ? Option.none()
              : Option.some({ projectId, workspaceExecutionTargetId: saved[projectId] }),
          ),
  } as unknown as ProjectionProjectRepositoryShape;
}

const run = (
  call: typeof restartRemoteAgentEffect,
  restart: RemoteAgentRestartServiceShape,
  sources: RemoteAgentRestartProjectSources,
) => Effect.runPromiseExit(call(input, restart, sources));

describe("managed remote restart project admission", () => {
  it("keeps status and same-request retry available for a durable project not in the read model", async () => {
    const restart = service();
    const sources = {
      orchestrationEngine: engine(),
      projectionProjectRepository: Option.some(repository({ [input.projectId]: target })),
    };

    const status = await Effect.runPromise(
      getRemoteAgentRestartStatusEffect(input, restart, sources),
    );
    const retry = await Effect.runPromise(restartRemoteAgentEffect(input, restart, sources));

    expect(status).toEqual(ready);
    expect(retry).toEqual(ready);
    expect(restart.status).toHaveBeenCalledWith(input);
    expect(restart.restart).toHaveBeenCalledWith(input);
  });

  it.each([
    [
      "a project retargeted to another service",
      { [input.projectId]: "ssh:host=other&auth=ssh-key" },
    ],
    ["a project that no longer exists", {}],
  ])("refuses status and retry for %s", async (_label, saved) => {
    const restart = service();
    // A stale in-memory entry must not override the durable project row.
    const sources = {
      orchestrationEngine: engine([{ id: input.projectId, workspaceExecutionTargetId: target }]),
      projectionProjectRepository: Option.some(repository(saved)),
    };

    for (const call of [getRemoteAgentRestartStatusEffect, restartRemoteAgentEffect]) {
      const exit = await run(call, restart, sources);
      expect(JSON.stringify(exit)).toContain(
        "The project no longer references the selected remote service.",
      );
    }
    expect(restart.status).not.toHaveBeenCalled();
    expect(restart.restart).not.toHaveBeenCalled();
  });

  it("fails closed when the durable project row cannot be read", async () => {
    const restart = service();
    const sources = {
      orchestrationEngine: engine([{ id: input.projectId, workspaceExecutionTargetId: target }]),
      projectionProjectRepository: Option.some(repository({}, true)),
    };

    for (const call of [getRemoteAgentRestartStatusEffect, restartRemoteAgentEffect]) {
      const exit = await run(call, restart, sources);
      expect(JSON.stringify(exit)).toContain("could not be read");
    }
    expect(restart.status).not.toHaveBeenCalled();
    expect(restart.restart).not.toHaveBeenCalled();
  });

  it("falls back to the read model only when no durable repository is configured", async () => {
    const restart = service();
    const matching = {
      orchestrationEngine: engine([{ id: input.projectId, workspaceExecutionTargetId: target }]),
    };
    expect(
      await Effect.runPromise(getRemoteAgentRestartStatusEffect(input, restart, matching)),
    ).toEqual(ready);

    const missing = await run(getRemoteAgentRestartStatusEffect, restart, {
      orchestrationEngine: engine(),
      projectionProjectRepository: Option.none(),
    });
    expect(JSON.stringify(missing)).toContain("no longer references");
    expect(restart.status).toHaveBeenCalledTimes(1);
  });
});
