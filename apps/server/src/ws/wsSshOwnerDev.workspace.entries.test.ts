import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";

import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";
import {
  unsupportedWorkspaceMutations,
  WORKSPACE_ENTRY_ALREADY_EXISTS,
  WORKSPACE_ENTRY_NOT_FOUND,
  type WorkspaceMutationsShape,
} from "../workspace-runtime/Services/WorkspaceMutations.ts";
import { withSelectedEntryMutations } from "./wsSshOwnerDev.workspace.entries.ts";
import type { SelectedEntryMutationBinding } from "./wsSshOwnerDev.workspace.entries.ts";

const targetId = "ssh:host=fixture&transport=direct-ssh";
const cwd = "/fixture/workspace";

function binding(owner: {
  create?: () => Promise<"created" | "alreadyExists">;
  remove?: () => Promise<"deleted" | "notFound">;
}): SelectedEntryMutationBinding {
  const withOwner = vi.fn(async (_id: string, use: (value: never) => Promise<unknown>) =>
    use({
      createProofWorkspaceDirectory: vi.fn(owner.create ?? (async () => "created")),
      deleteProofWorkspaceEntry: vi.fn(owner.remove ?? (async () => "deleted")),
    } as never),
  );
  return { targetId, workspaceRoot: cwd, withOwner } as unknown as SelectedEntryMutationBinding;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

it("maps typed folder mutations and refuses ambiguous outcomes without replay", async () => {
  const unknown = binding({
    create: async () => {
      throw new PickerProofOwnerError("outcomeUnknown");
    },
    remove: async () => {
      throw new PickerProofOwnerError("outcomeUnknown");
    },
  });
  const runtime = withSelectedEntryMutations(unsupportedWorkspaceMutations, () => unknown);
  const create = { executionTargetId: targetId, cwd, relativePath: "folder" };
  const remove = { ...create, relativePath: "folder", expectedKind: "directory" as const };
  expect(await run(runtime.createDirectory(create))).toMatchObject({
    detail: expect.stringContaining("outcomeUnknown"),
    writeDisposition: "unknown",
    retryable: false,
  });
  expect(await run(runtime.deleteEntry(remove))).toMatchObject({
    detail: expect.stringContaining("outcomeUnknown"),
    writeDisposition: "unknown",
    retryable: false,
  });
  expect(unknown.withOwner).toHaveBeenCalledTimes(2);
});

it("reports typed already-exists and not-found as terminal refusals", async () => {
  const runtime = withSelectedEntryMutations(unsupportedWorkspaceMutations, () =>
    binding({
      create: async () => "alreadyExists",
      remove: async () => "notFound",
    }),
  );
  const input = { executionTargetId: targetId, cwd, relativePath: "folder" };
  expect(await run(runtime.createDirectory(input))).toMatchObject({
    detail: WORKSPACE_ENTRY_ALREADY_EXISTS,
    writeDisposition: "terminal",
  });
  expect(await run(runtime.deleteEntry({ ...input, expectedKind: "file" }))).toMatchObject({
    detail: WORKSPACE_ENTRY_NOT_FOUND,
    writeDisposition: "terminal",
  });
});

it("refuses traversal and disconnected targets before acquiring the owner", async () => {
  const blocked = binding({});
  const runtime = withSelectedEntryMutations(unsupportedWorkspaceMutations, () => blocked);
  for (const relativePath of ["../outside", "a/../../b", "a\\b", ""]) {
    expect(
      await run(runtime.createDirectory({ executionTargetId: targetId, cwd, relativePath })),
    ).toMatchObject({ writeDisposition: "not-dispatched" });
  }
  expect(blocked.withOwner).not.toHaveBeenCalled();

  const disconnected = binding({
    create: async () => {
      throw new RemoteTargetDisconnectedError(targetId);
    },
  });
  const offline = withSelectedEntryMutations(unsupportedWorkspaceMutations, () => disconnected);
  expect(
    await run(
      offline.createDirectory({ executionTargetId: targetId, cwd, relativePath: "folder" }),
    ),
  ).toMatchObject({ writeDisposition: "not-dispatched" });
});

it("delegates non-selected targets to the composed backend", async () => {
  const backend: WorkspaceMutationsShape = {
    ...unsupportedWorkspaceMutations,
    createDirectory: vi.fn(() => Effect.succeed({ relativePath: "local" })),
    deleteEntry: vi.fn(() =>
      Effect.succeed({ relativePath: "local", disposition: "deleted" as const }),
    ),
  };
  const runtime = withSelectedEntryMutations(backend, () => binding({}));
  expect(
    await Effect.runPromise(
      runtime.createDirectory({
        executionTargetId: "local",
        cwd: "/tmp/project",
        relativePath: "x",
      }),
    ),
  ).toEqual({ relativePath: "local" });
  expect(backend.createDirectory).toHaveBeenCalledOnce();
  expect(
    await run(
      runtime.createDirectory({
        executionTargetId: targetId,
        cwd: "/elsewhere",
        relativePath: "x",
      }),
    ),
  ).toMatchObject({ writeDisposition: "not-dispatched" });
});
