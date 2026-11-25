import { it as effectIt } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, it, vi } from "vitest";
import { PickerProofOwnerError, type PickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import type { WorkspaceMutationsShape } from "../workspace-runtime/Services/WorkspaceMutations.ts";
import {
  createDevWorkspaceFile,
  withWsSshOwnerDevEntryActions,
} from "./wsSshOwnerDev.workspace.create.ts";

const targetId = "ssh:host=fixture&auth=ssh-key&transport=direct-ssh";
const cwd = "/fixture/workspace";
const relativePath = "existing/new.txt";

it("does not replay an unknown create and rejects invalid operands before apply", async () => {
  const apply = vi.fn(async () => {
    throw new PickerProofOwnerError("outcomeUnknown");
  });
  const input = { cwd, relativePath, contents: "", createOnly: true };
  const result = (overrides: Partial<typeof input> & { expectedSha256?: string } = {}) =>
    Effect.runPromise(
      Effect.flip(createDevWorkspaceFile({ ...input, ...overrides }, relativePath, { apply })),
    );
  expect(await result({ expectedSha256: "0".repeat(64) })).toMatchObject({
    writeDisposition: "not-dispatched",
  });
  expect(await result({ contents: "é".repeat(24 * 1024 + 1) })).toMatchObject({
    writeDisposition: "not-dispatched",
  });
  expect(apply).not.toHaveBeenCalled();
  expect(await result()).toMatchObject({ writeDisposition: "unknown", retryable: false });
  expect(apply).toHaveBeenCalledExactlyOnceWith({ relativePath, contents: new Uint8Array() });
});

it("advertises only exact qualified file create and keeps the other delegates", async () => {
  const original = {
    createFile: { allowed: true },
    createFolder: { allowed: true },
    delete: { allowed: true, permanent: false },
  };
  const backend: WorkspaceMutationsShape = {
    entryActions: () => Effect.succeed(original),
    createDirectory: () => Effect.die("unused create directory delegate"),
    deleteEntry: () => Effect.die("unused delete delegate"),
  };
  const binding = {
    targetId,
    workspaceRoot: cwd,
    withOwner: <A>(_target: string, _use: (owner: PickerProofOwner) => Promise<A>) =>
      Promise.reject<A>(new Error("must not acquire")),
  };
  const qualified = withWsSshOwnerDevEntryActions(backend, {
    ...binding,
    exclusiveCreate: { apply: async () => "created" },
  });
  const unqualified = withWsSshOwnerDevEntryActions(backend, binding);
  const flags = (
    runtime: WorkspaceMutationsShape,
    input: Parameters<WorkspaceMutationsShape["entryActions"]>[0],
  ) => Effect.runPromise(runtime.entryActions(input));
  expect(await flags(qualified, { cwd })).toBe(original);
  const fixtureEnabled = {
    ...original,
    createFile: { allowed: true },
    createFolder: { allowed: true },
    delete: { allowed: true, permanent: true },
  };
  expect(await flags(qualified, { cwd, executionTargetId: targetId })).toEqual(fixtureEnabled);
  const refused = {
    ...original,
    createFile: { allowed: false, reason: "unsupportedTarget" },
    createFolder: { allowed: false, reason: "unsupportedTarget" },
    delete: { allowed: false, reason: "unsupportedTarget", permanent: true },
  };
  expect(await flags(qualified, { cwd: `${cwd}/nested`, executionTargetId: targetId })).toEqual(
    refused,
  );
  expect(
    await flags(qualified, { cwd, executionTargetId: targetId.replace("fixture", "other") }),
  ).toEqual(refused);
  expect(await flags(unqualified, { cwd, executionTargetId: targetId })).toEqual({
    ...fixtureEnabled,
    createFile: { allowed: false, reason: "unsupportedTarget" },
  });
});

effectIt.effect(
  "first entryActions waits only for the exact fixture's existing qualification",
  () =>
    Effect.gen(function* () {
      const proof = Promise.withResolvers<void>();
      const pendingCreateQualification = vi.fn(() => proof.promise);
      const binding: Parameters<typeof withWsSshOwnerDevEntryActions>[1] & object = {
        targetId,
        workspaceRoot: cwd,
        pendingCreateQualification,
      };
      const runtime = withWsSshOwnerDevEntryActions(undefined, binding);
      const input = { cwd, executionTargetId: targetId };
      const denied = { allowed: false, reason: "unsupportedTarget" };
      expect((yield* runtime.entryActions({ ...input, cwd: `${cwd}/other` })).createFile).toEqual(
        denied,
      );
      expect(pendingCreateQualification).not.toHaveBeenCalled();

      const request = yield* runtime
        .entryActions(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(request.pollUnsafe()).toBeUndefined();
      const cancelled = yield* runtime
        .entryActions(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      expect(request.pollUnsafe()).toBeUndefined();

      const timesOut = yield* runtime
        .entryActions(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 seconds");
      expect(timesOut.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(timesOut)).createFile).toEqual(denied);

      const firstVisit = yield* runtime
        .entryActions(input)
        .pipe(Effect.forkChild({ startImmediately: true }));
      Object.assign(binding, { exclusiveCreate: { apply: async () => "created" } });
      proof.resolve();
      expect((yield* Fiber.join(firstVisit)).createFile).toEqual({ allowed: true });
    }),
);
