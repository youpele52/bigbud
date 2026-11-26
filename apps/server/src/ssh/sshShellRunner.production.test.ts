import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import {
  makeFakeShellOwner,
  type FakeShellOutcome,
} from "./sshOwnerPickerProof.productionShell.fixture.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";
import { makeSshShellRunner } from "./sshShellRunner.ts";
import { makeProductionShellRunner } from "./sshShellRunner.production.ts";
import { makeProductionProviderWorkspaceShell } from "../ws/remoteWorkspaceProviderShell.ts";

afterEach(() => vi.clearAllMocks());

const TARGET = "ssh:host=devbox&transport=direct-ssh";

function registration(outcome: FakeShellOutcome, pollsBeforeExit = 2) {
  const owner = makeFakeShellOwner({ outcome, pollsBeforeExit });
  const descriptors: string[] = [];
  const live = {
    handle: { target: () => owner.client },
    descriptorFor: async (targetId: string) => {
      descriptors.push(targetId);
      return { targetId } as never;
    },
  } as unknown as SshOwnerProductionRegistration;
  return { owner, live, descriptors };
}

it("runs the thread command as a thread lease on the exact target with cwd as its root", async () => {
  const { owner, live, descriptors } = registration({ exit: 3, output: Buffer.from("out\n") });
  const chunks: string[] = [];
  const result = await Effect.runPromise(
    makeProductionShellRunner(TARGET, () => live).run({
      threadId: "thread-1",
      cwd: "/srv/work",
      command: "printf out; exit 3",
      timeoutMs: 999_999,
      onOutputChunk: (chunk) => chunks.push(chunk),
    }),
  );
  expect(result).toEqual({ output: "out\n", exitCode: 3 });
  expect(chunks).toEqual(["out\n"]);
  expect(descriptors).toEqual([TARGET]);
  expect(owner.operations[0]).toMatchObject({
    kind: "runThreadShell",
    workspaceRoot: "/srv/work",
    cwd: "/srv/work",
    threadId: "thread-1",
    timeoutMs: 120_000,
  });
  // Settled leases are released, and no legacy SSH launch happens.
  expect(owner.operations.at(-1)).toMatchObject({ kind: "shellClose", role: "thread" });
  expect(owner.leases.size).toBe(0);
});

it("reads output larger than one owner chunk back in order", async () => {
  const output = Buffer.alloc(2 * 1024 * 1024 + 5, 0x61);
  const { owner, live } = registration({ exit: 0, output, truncated: true }, 0);
  const result = await Effect.runPromise(
    makeProductionShellRunner(TARGET, () => live).run({
      threadId: "t",
      cwd: "/srv/work",
      command: "big",
    }),
  );
  expect(result.output.length).toBe(output.length);
  const offsets = owner.operations
    .filter((operation) => operation.kind === "shellStatus")
    .map((operation) => (operation as { offset: number }).offset);
  expect(offsets).toEqual([0, 1024 * 1024, 2 * 1024 * 1024]);
});

it("abort kills only this lease and reports cancellation without replay", async () => {
  const { owner, live } = registration({ exit: 0, output: Buffer.from("never") }, 1_000);
  const controller = new AbortController();
  const shell = makeProductionProviderWorkspaceShell(TARGET, "/srv/work", () => live);
  const pending = shell.run(
    {
      workspaceRoot: "/srv/work",
      cwd: "/srv/work",
      provider: "thread-tool",
      sessionId: "s",
      invocationId: "i",
      command: "sleep 100",
      timeoutMs: 30_000,
    },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "shellCancelled" });
  const opens = owner.operations.filter((operation) => operation.kind.startsWith("run"));
  expect(opens).toHaveLength(1);
  expect(opens[0]).toMatchObject({ kind: "runProviderWorkspaceShell", provider: "thread-tool" });
  expect(owner.operations.at(-1)).toMatchObject({ kind: "shellClose", role: "providerWorkspace" });
  expect(owner.leases.size).toBe(0);
});

it("surfaces typed owner failures and refuses without an owner or a resolvable target", async () => {
  const timedOut = registration({ error: "shellTimedOut" });
  const failure = await Effect.runPromise(
    Effect.flip(
      makeProductionShellRunner(TARGET, () => timedOut.live).run({
        threadId: "t",
        cwd: "/srv/work",
        command: "sleep 200",
      }),
    ),
  );
  expect(failure.message).toContain("timed out");
  const none = await Effect.runPromise(
    Effect.flip(
      makeProductionShellRunner(TARGET, () => undefined).run({
        threadId: "t",
        cwd: "/srv/work",
        command: "true",
      }),
    ),
  );
  expect(none.message).toContain("no production owner is open");
  const refused = {
    handle: { target: () => timedOut.owner.client },
    descriptorFor: async () => {
      throw Object.assign(new Error("refused"), { reason: "password-auth" });
    },
  } as unknown as SshOwnerProductionRegistration;
  const target = await Effect.runPromise(
    Effect.flip(
      makeProductionShellRunner(TARGET, () => refused).run({
        threadId: "t",
        cwd: "/srv/work",
        command: "true",
      }),
    ),
  );
  expect(target.message).toContain("target refused (password-auth)");
  const root = await Effect.runPromise(
    Effect.flip(
      makeProductionShellRunner(TARGET, () => timedOut.live).run({
        threadId: "t",
        cwd: "/",
        command: "true",
      }),
    ),
  );
  expect(root.message).toContain("not an exact absolute workspace path");
});

it("production activation selects the owner runner and never the legacy SSH launch", async () => {
  const runner = makeSshShellRunner(TARGET);
  const failure = await Effect.runPromise(
    Effect.flip(runner.run({ threadId: "t", cwd: "/srv/work", command: "true" })),
  );
  expect(failure.message).toContain("No legacy shell was started");
});
