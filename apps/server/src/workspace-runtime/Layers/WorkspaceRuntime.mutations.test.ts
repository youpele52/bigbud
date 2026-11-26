import { describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";

import type { WorkspaceRuntimeBackendShape } from "../Services/WorkspaceRuntime.ts";
import type { WorkspaceMutationsShape } from "../Services/WorkspaceMutations.ts";
import { makeTargetAwareRuntime } from "./WorkspaceRuntime.ts";

const unused = () => Effect.die("unused");

function backend(mutations?: WorkspaceMutationsShape): WorkspaceRuntimeBackendShape {
  return {
    files: {
      writeFile: unused,
      readFilePreview: unused,
      readFileRange: unused,
      listDirectory: unused,
    },
    search: { searchEntries: unused, searchFileContents: unused },
    watch: { watchDirectory: unused },
    ...(mutations ? { mutations } : {}),
  };
}

function mutations(label: string): WorkspaceMutationsShape {
  return {
    entryActions: vi.fn(() =>
      Effect.succeed({
        createFile: { allowed: true },
        createFolder: { allowed: label === "local" },
        delete: { allowed: true, permanent: label !== "local" },
      }),
    ),
    createDirectory: vi.fn((input) =>
      Effect.succeed({ relativePath: `${label}:${input.relativePath}` }),
    ),
    deleteEntry: vi.fn((input) =>
      Effect.succeed({
        relativePath: `${label}:${input.relativePath}`,
        disposition: "deleted" as const,
      }),
    ),
  };
}

describe("target-aware workspace mutations", () => {
  const agent = "ssh:host=example&transport=agent";

  it("routes local targets locally and remote targets to the remote backend", async () => {
    const runtime = makeTargetAwareRuntime({
      local: backend(mutations("local")),
      remote: backend(mutations("remote")),
    });
    const local = await Effect.runPromise(
      runtime.mutations!.createDirectory({ cwd: "/w", relativePath: "a" }),
    );
    const remote = await Effect.runPromise(
      runtime.mutations!.createDirectory({
        cwd: "/w",
        relativePath: "a",
        executionTargetId: agent,
      }),
    );
    expect([local.relativePath, remote.relativePath]).toEqual(["local:a", "remote:a"]);
  });

  it("refuses when the selected backend has no mutations", async () => {
    const runtime = makeTargetAwareRuntime({
      local: backend(mutations("local")),
      remote: backend(),
    });
    const exit = await Effect.runPromiseExit(
      runtime.mutations!.deleteEntry({
        cwd: "/w",
        relativePath: "a",
        expectedKind: "file",
        executionTargetId: agent,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const actions = await Effect.runPromise(
      runtime.mutations!.entryActions({ cwd: "/w", executionTargetId: agent }),
    );
    expect(actions.delete).toMatchObject({ allowed: false, reason: "unsupportedTarget" });
  });
});
