import { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { ServerDiscoveryCatalog } from "@bigbud/contracts/server/server.providers.ts";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { expandProviderInputMentions } from "./ProviderCommandReactorInputExpansion.ts";

const thread = Schema.decodeUnknownSync(OrchestrationThread)({
  id: "thread",
  projectId: "project",
  title: "References",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z",
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: null,
});

function makeExpansion(catalog: ServerDiscoveryCatalog = { agents: [], skills: [] }) {
  const readFileString = vi.fn(() =>
    Effect.succeed("# Instructions\nFollow this direct reference."),
  );
  const resolvePath = vi.fn(({ relativePath }: { relativePath: string }) =>
    Effect.succeed({
      absolutePath: `/workspace/${relativePath}`,
      relativePath,
    }),
  );
  const getCatalog = vi.fn(() => catalog);
  const run = (messageText: string) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* expandProviderInputMentions({
        fileSystem,
        discoveryRegistry: {
          getCatalog: Effect.sync(getCatalog),
          refresh: () => Effect.succeed(catalog),
          streamChanges: Stream.empty,
        },
        workspacePaths: {
          normalizeWorkspaceRoot: Effect.succeed,
          resolveRelativePathWithinRoot: resolvePath,
        },
        resolveDefaultChatCwd: () => Effect.succeed("/workspace"),
      })({ messageText, thread, workspaceRoot: "/workspace" });
    }).pipe(Effect.provide(FileSystem.layerNoop({ readFileString })), Effect.runPromise);
  return { run, readFileString, resolvePath, getCatalog };
}

describe("compact reference expansion after marketplace retirement", () => {
  it.each(["@plugin::example", "@plugin:example", "/plugins"])(
    "keeps %s literal without file or registry access",
    async (message) => {
      const harness = makeExpansion();
      expect(await harness.run(message)).toBe(message);
      expect(harness.readFileString).not.toHaveBeenCalled();
      expect(harness.resolvePath).not.toHaveBeenCalled();
      expect(harness.getCatalog).not.toHaveBeenCalled();
    },
  );

  it("still expands direct agent and skill references while ignoring retired tokens", async () => {
    const harness = makeExpansion({
      agents: [
        {
          id: "review",
          name: "review",
          provider: "codex",
          source: "user",
          sourcePath: "/agents/review.md",
        },
      ],
      skills: [
        {
          id: "handoff",
          name: "handoff",
          provider: "bigbud",
          source: "project",
          sourcePath: "/skills/handoff/SKILL.md",
        },
      ],
    });
    const message = "@plugin::example @agent::review @skill::handoff";
    const result = await harness.run(message);
    expect(result).toContain(message);
    expect(result).toContain("Referenced agent: review");
    expect(result).toContain("Referenced skill: handoff");
    expect(result).toContain("Follow this direct reference.");
    expect(result).not.toContain("Plugin activation");
    expect(result).not.toContain("Plugin Store");
    expect(harness.readFileString.mock.calls).toHaveLength(2);
    expect(harness.resolvePath).not.toHaveBeenCalled();
  });

  it("still expands slash skill references", async () => {
    const harness = makeExpansion({
      agents: [],
      skills: [
        {
          id: "handoff",
          name: "handoff",
          provider: "codex",
          source: "user",
          sourcePath: "/skills/handoff/SKILL.md",
        },
      ],
    });
    expect(await harness.run("/skills handoff")).toContain("Referenced skill: handoff");
    expect(harness.readFileString).toHaveBeenCalledOnce();
  });
});
