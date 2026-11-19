import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { vi } from "vitest";

import { runToolCommand } from "../tool-transport/toolTransport.ts";
import { makeLocalWorkspaceAgentLayer } from "../workspace-runtime/Layers/LocalWorkspaceAgent.ts";
import { makeWorkspaceRuntimeLayer } from "../workspace-runtime/Layers/WorkspaceRuntime.ts";
import { LocalWorkspaceAgent } from "../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import { WorkspaceRuntime } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspaceWatch } from "../workspace-runtime/Services/WorkspaceWatch.ts";
import { fakeSearchConnection } from "./agentWorkspaceContentSearch.test.helpers.ts";
import type { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

vi.mock("../tool-transport/toolTransport.ts", () => ({
  resolveToolTransportTarget: (target: unknown) => target,
  runToolCommand: vi.fn(),
}));

const search = fakeSearchConnection();
const agents = { created: 0, closed: 0, connections: 0 };
const AgentLayer = makeLocalWorkspaceAgentLayer(() => {
  agents.created += 1;
  return {
    getConnection: async () => {
      agents.connections += 1;
      return search.connection;
    },
    getWorkspaceClient: async () => ({}) as RemoteAgentWorkspaceClient,
    close: () => {
      agents.closed += 1;
    },
  };
});

const TestLayer = makeWorkspaceRuntimeLayer(undefined, undefined, undefined, AgentLayer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("local workspace search composition", (it) => {
  it.effect("shares one local agent between watch and search", () =>
    Effect.gen(function* () {
      yield* WorkspaceWatch;
      yield* WorkspaceRuntime;
      const agent = yield* LocalWorkspaceAgent;
      yield* Effect.promise(() => agent.getConnection());
      expect(agents.created).toBe(1);
      expect(agents.closed).toBe(0);
    }),
  );

  it.effect("sends local content search to the agent and never runs rg", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkspaceRuntime;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "bigbud-local-search-" });
      vi.mocked(runToolCommand).mockClear();
      const before = search.requests.length;

      const result = yield* runtime.search.searchFileContents({
        cwd,
        query: "needle",
        limit: 10,
        executionTargetId: "local",
      });

      expect(result.matches).toEqual([{ path: "src/a.ts", line: 1, column: 14, lineText: "x" }]);
      expect(result.notice).toBeUndefined();
      expect(search.requests.length).toBe(before + 1);
      expect(runToolCommand).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps rg on direct-SSH hosts, with the managed-agent hint", () =>
    Effect.gen(function* () {
      const runtime = yield* WorkspaceRuntime;
      vi.mocked(runToolCommand).mockResolvedValueOnce({
        stdout: `${JSON.stringify({
          type: "match",
          data: {
            path: { text: "./src/index.ts" },
            line_number: 2,
            lines: { text: "const remote = true;\n" },
            submatches: [{ start: 6 }],
          },
        })}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
        stdoutTruncated: false,
      });
      const before = search.requests.length;

      const result = yield* runtime.search.searchFileContents({
        cwd: "/srv/project",
        query: "remote",
        limit: 10,
        executionTargetId: "ssh:dev",
      });

      expect(result).toEqual({
        matches: [{ path: "src/index.ts", line: 2, column: 7, lineText: "const remote = true;" }],
        truncated: false,
        notice: "use-managed-agent",
      });
      expect(runToolCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "rg" }));
      expect(search.requests.length).toBe(before);
    }),
  );
});
