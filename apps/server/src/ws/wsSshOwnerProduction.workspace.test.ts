import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";

import type { PickerProofWorkspaceClient } from "../ssh/sshOwnerPickerProof.client.workspace.ts";
import type { SshOwnerTargetDescriptor } from "../ssh/sshOwnerProductionClient.launch.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { SshOwnerTargetRefusal } from "../ssh/sshOwnerProductionTargets.ts";
import { unsupportedWorkspaceMutations } from "../workspace-runtime/Services/WorkspaceMutations.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { withWsSshOwnerProductionWorkspace } from "./wsSshOwnerProduction.workspace.ts";

const alias = "ssh:prod-box";
const cwd = "/home/dev/project";
const pathsLayer = WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer));

const descriptor = {
  targetId: "prod-box",
  kind: "alias",
  host: "192.0.2.10",
  port: 22,
  user: "dev",
  authMode: "key",
  identityFile: "/home/me/.ssh/id_ed25519",
  knownHostsFile: "/home/me/.ssh/known_hosts",
} as SshOwnerTargetDescriptor;

function setup(options: { live?: boolean; refuse?: boolean } = {}) {
  const fallback = vi.fn(() => Effect.die("unexpected default workspace operation"));
  const original: WorkspaceRuntimeShape = {
    files: {
      listDirectory: fallback,
      readFilePreview: fallback,
      readFileRange: fallback,
      writeFile: fallback,
    },
    search: { searchEntries: fallback, searchFileContents: fallback },
    watch: { watchDirectory: fallback },
  };
  const bound = {
    listProofWorkspaceDirectory: vi.fn<PickerProofWorkspaceClient["listProofWorkspaceDirectory"]>(
      async () => ({ entries: [{ name: "src", directory: true }], truncated: false }),
    ),
    readProofWorkspaceFile: vi.fn<PickerProofWorkspaceClient["readProofWorkspaceFile"]>(
      async () => ({ data: new TextEncoder().encode("hi\n"), sizeBytes: 3, truncated: false }),
    ),
    writeProofWorkspaceFile: vi.fn<PickerProofWorkspaceClient["writeProofWorkspaceFile"]>(
      async () => undefined,
    ),
    createProofWorkspaceFile: vi.fn<PickerProofWorkspaceClient["createProofWorkspaceFile"]>(
      async () => "created",
    ),
    createProofWorkspaceDirectory: vi.fn<
      PickerProofWorkspaceClient["createProofWorkspaceDirectory"]
    >(async () => "created"),
    deleteProofWorkspaceEntry: vi.fn<PickerProofWorkspaceClient["deleteProofWorkspaceEntry"]>(
      async () => "deleted",
    ),
  };
  const target = vi.fn(() => bound as never);
  const descriptorFor = vi.fn(async (_id: string) => {
    if (options.refuse) throw new SshOwnerTargetRefusal("config-refused");
    return descriptor;
  });
  const registration = {
    handle: { target, state: () => "open" },
    descriptorFor,
  } as unknown as SshOwnerProductionRegistration;
  const composed = withWsSshOwnerProductionWorkspace(
    { workspaceRuntime: original, workspaceMutations: unsupportedWorkspaceMutations },
    { read: () => (options.live === false ? undefined : registration) },
  );
  if (!composed) throw new Error("Expected the production composition");
  const runtime = Effect.runSync(composed.workspaceRuntime.pipe(Effect.provide(pathsLayer)));
  return {
    runtime,
    mutations: composed.workspaceMutations,
    bound,
    target,
    descriptorFor,
    fallback,
  };
}

const flip = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("production SSH Files over the live owner", () => {
  it("serves reads and lists through the exact target with the request's own root", async () => {
    const { runtime, bound, descriptorFor, target, fallback } = setup();
    const input = { executionTargetId: alias, cwd };
    await expect(Effect.runPromise(runtime.files.listDirectory(input))).resolves.toEqual({
      entries: [{ path: "src", kind: "directory" }],
    });
    const preview = await Effect.runPromise(
      runtime.files.readFilePreview({ ...input, relativePath: "src/../README.md" }),
    );
    expect(preview).toMatchObject({ contents: "hi\n", relativePath: "README.md" });
    expect(bound.readProofWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: alias, workspaceRoot: cwd, kind: "preview" }),
    );
    expect(descriptorFor).toHaveBeenCalledWith(alias);
    expect(target).toHaveBeenCalledWith(descriptor);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("refuses before dispatch without a live owner or a resolvable target", async () => {
    for (const options of [{ live: false }, { refuse: true }]) {
      const { runtime, bound, fallback } = setup(options);
      const failure = await flip(
        runtime.files.writeFile({ executionTargetId: alias, cwd, relativePath: "a", contents: "" }),
      );
      expect(failure).toMatchObject({ writeDisposition: "not-dispatched" });
      expect(bound.writeProofWorkspaceFile).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    }
  });

  it("refuses guarded saves and serves New File through exclusive create", async () => {
    const { runtime, bound } = setup();
    const input = { executionTargetId: alias, cwd, relativePath: "a.txt", contents: "x" };
    expect(
      await flip(runtime.files.writeFile({ ...input, expectedSha256: "a".repeat(64) })),
    ).toMatchObject({ writeDisposition: "not-dispatched" });
    expect(bound.writeProofWorkspaceFile).not.toHaveBeenCalled();
    await Effect.runPromise(runtime.files.writeFile({ ...input, createOnly: true }));
    expect(bound.createProofWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: alias,
        workspaceRoot: cwd,
        relativePath: "a.txt",
      }),
    );
    bound.createProofWorkspaceFile.mockResolvedValueOnce("alreadyExists");
    expect(await flip(runtime.files.writeFile({ ...input, createOnly: true }))).toMatchObject({
      writeDisposition: "terminal",
    });
    await Effect.runPromise(runtime.files.writeFile(input));
    expect(bound.writeProofWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: alias, workspaceRoot: cwd }),
    );
  });

  it("advertises New File and performs folder create and delete", async () => {
    const { mutations, bound } = setup();
    const input = { executionTargetId: alias, cwd };
    const actions = await Effect.runPromise(mutations.entryActions(input));
    expect(actions.createFolder.allowed).toBe(true);
    expect(actions.delete).toMatchObject({ allowed: true, permanent: true });
    expect(actions.createFile.allowed).toBe(true);
    await Effect.runPromise(mutations.createDirectory({ ...input, relativePath: "new" }));
    await Effect.runPromise(
      mutations.deleteEntry({ ...input, relativePath: "new", expectedKind: "directory" }),
    );
    expect(bound.createProofWorkspaceDirectory).toHaveBeenCalledWith({
      executionTargetId: alias,
      workspaceRoot: cwd,
      relativePath: "new",
    });
    expect(bound.deleteProofWorkspaceEntry).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "new", expectedDirectory: true }),
    );
  });

  it("keeps a relative or non-SSH root off the owner", async () => {
    const { runtime, bound } = setup();
    expect(
      await flip(runtime.files.listDirectory({ executionTargetId: alias, cwd: "relative" })),
    ).toMatchObject({ _tag: "WorkspaceEntriesError" });
    expect(bound.listProofWorkspaceDirectory).not.toHaveBeenCalled();
  });
});
