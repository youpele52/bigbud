import { Deferred, Effect } from "effect";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { makePickerProofShellClient } from "./sshOwnerPickerProof.client.shell.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeSshShellRunner } from "./sshShellRunner.ts";
import type { ProofShellResult } from "./sshOwnerPickerProof.codec.shell.ts";
import type { SshShellOwnerAccess } from "./sshShellRunner.owner.ts";
import { runSshCommand } from "./sshProcess.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

vi.mock("./sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

const ownerAccess = (
  run: (input: {
    workspaceRoot: string;
    cwd: string;
    threadId: string;
    command: string;
    timeoutMs: number;
  }) => Promise<ProofShellResult>,
): SshShellOwnerAccess => ({
  targetId: "ssh:host=devbox&transport=direct-ssh",
  workspaceRoot: "/srv/project",
  withOwner: async (_targetId, use) =>
    use({
      runProofThreadShell: async (input: {
        workspaceRoot: string;
        cwd: string;
        threadId: string;
        command: string;
        timeoutMs: number;
      }) => run(input),
    } as never),
});

afterEach(() => vi.clearAllMocks());

it("runs the authorized thread command over the owner with the 30 s default and no legacy launch", async () => {
  activateDevSshOwner();
  const calls: Array<{
    workspaceRoot: string;
    cwd: string;
    threadId: string;
    command: string;
    timeoutMs: number;
  }> = [];
  const runner = makeSshShellRunner(
    "ssh:host=devbox&transport=direct-ssh",
    ownerAccess(async (input) => {
      calls.push(input);
      return { output: "thread output\n", exitCode: 0, truncated: false, timedOut: false };
    }),
  );
  const result = await Effect.runPromise(
    runner.run({
      threadId: "thread-1",
      cwd: "/srv/project",
      command: "printf thread",
      timeoutMs: null,
    }),
  );
  expect(result).toEqual({ output: "thread output\n", exitCode: 0 });
  expect(calls).toEqual([
    {
      workspaceRoot: "/srv/project",
      cwd: "/srv/project",
      threadId: "thread-1",
      command: "printf thread",
      timeoutMs: 30_000,
    },
  ]);
  expect(runSshCommand).not.toHaveBeenCalled();
});

it("clamps the requested timeout to the 120 s ceiling and truncates at 8 MiB", async () => {
  activateDevSshOwner();
  let observedTimeout = 0;
  const oversized = "a".repeat(9 * 1024 * 1024);
  const runner = makeSshShellRunner(
    "ssh:host=devbox&transport=direct-ssh",
    ownerAccess(async (input) => {
      observedTimeout = input.timeoutMs;
      return { output: oversized, exitCode: 0, truncated: true, timedOut: false };
    }),
  );
  const result = await Effect.runPromise(
    runner.run({
      threadId: "thread-2",
      cwd: "/srv/project",
      command: "printf huge",
      timeoutMs: 999_999,
    }),
  );
  expect(observedTimeout).toBe(120_000);
  expect(Buffer.byteLength(result.output)).toBe(8 * 1024 * 1024);
});

it("refuses a second concurrent command for the same thread while one is active", async () => {
  activateDevSshOwner();
  const gate = Deferred.makeUnsafe<void>();
  let calls = 0;
  const runner = makeSshShellRunner(
    "ssh:host=devbox&transport=direct-ssh",
    ownerAccess(async () => {
      calls += 1;
      await Effect.runPromise(Deferred.await(gate));
      return { output: "done\n", exitCode: 0, truncated: false, timedOut: false };
    }),
  );
  const first = Effect.runPromise(
    runner.run({ threadId: "thread-3", cwd: "/srv/project", command: "sleep 1" }),
  );
  await expect(
    Effect.runPromise(
      runner.run({ threadId: "thread-3", cwd: "/srv/project", command: "printf second" }),
    ),
  ).rejects.toThrow("already running");
  Effect.runSync(Deferred.succeed(gate, undefined));
  await expect(first).resolves.toEqual({ output: "done\n", exitCode: 0 });
  expect(calls).toBe(1);
  expect(runSshCommand).not.toHaveBeenCalled();
});

it("cancels only the operation lease and never replays the command", async () => {
  const operations: Array<{ kind: string }> = [];
  const client = makePickerProofShellClient((operation) => {
    operations.push(operation);
    return new Promise(() => undefined);
  });
  const controller = new AbortController();
  const pending = client.runProofThreadShell(
    {
      workspaceRoot: "/srv/project",
      cwd: "/srv/project",
      threadId: "thread-4",
      command: "printf cancel",
      timeoutMs: 30_000,
    },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "shellCancelled" });
  expect(operations.map(({ kind }) => kind)).toEqual(["proofRunThreadShell"]);
});

it("does not accept an ACP or provider outcome for the thread-shell authority", async () => {
  for (const outcome of [
    {
      kind: "proofAcpCommand",
      value: { output: "/srv/project\n", exitCode: 0, truncated: false },
    },
    {
      kind: "proofProviderShell",
      value: { output: "provider\n", exitCode: 0, truncated: false, timedOut: false },
    },
  ] as const) {
    const client = makePickerProofShellClient(async () => outcome);
    await expect(
      client.runProofThreadShell({
        workspaceRoot: "/srv/project",
        cwd: "/srv/project",
        threadId: "thread-5",
        command: "printf wrong",
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "protocolError" });
  }
});

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "runs an authorized thread command over the real Rust owner with zero legacy launches",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "thread-shell.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            workspaceRoot: fixture.folder,
            devInteractiveTerminal: true,
          });
          try {
            const observed = await owner.inspectTrust();
            if (observed.state === "approvalRequired") await owner.approveTrust(observed.challenge);
            activateDevSshOwner();
            const runner = makeSshShellRunner(options.targetId, {
              targetId: options.targetId,
              workspaceRoot: fixture.folder,
              withOwner: (_targetId, use) => use(owner),
            });
            const result = await Effect.runPromise(
              runner.run({
                threadId: "thread-live-owner-shell",
                cwd: fixture.folder,
                command: "printf 'owner-thread\\n'",
              }),
            );
            expect(result.output).toContain("owner-thread");
            expect(result.exitCode).toBe(0);
            expect(await fixture.launchNames()).toEqual([]);
            expect(runSshCommand).not.toHaveBeenCalled();
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
