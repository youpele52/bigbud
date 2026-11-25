import { Effect, Layer } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { activateDevSshOwner } from "../ssh/sshOwnerDevMode.ts";
import { makePickerProofShellClient } from "../ssh/sshOwnerPickerProof.client.shell.ts";
import { readProofShellResult } from "../ssh/sshOwnerPickerProof.codec.shell.ts";
import { runToolCommand } from "../tool-transport/toolTransport.ts";
import { runRemoteWorkspaceProcess } from "./http.threadTools.remoteWorkspace.ts";
import {
  isFixedProviderShellCommand,
  PROVIDER_SHELL_REFUSAL,
  type SelectedProviderWorkspaceShell,
} from "./remoteWorkspaceProviderShell.ts";

vi.mock("../tool-transport/toolTransport.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tool-transport/toolTransport.ts")>();
  return { ...actual, runToolCommand: vi.fn() };
});

const threadId = ThreadId.makeUnsafe("thread-provider-shell");
const projectId = ProjectId.makeUnsafe("project-provider-shell");
const targetId = "ssh:host=devbox&user=root&port=22&transport=direct-ssh";

function port(
  run: SelectedProviderWorkspaceShell["run"],
  overrides: Partial<SelectedProviderWorkspaceShell> = {},
): SelectedProviderWorkspaceShell {
  return { targetId, workspaceRoot: "/srv/project", run, ...overrides };
}

function invoke(
  request: Parameters<typeof runRemoteWorkspaceProcess>[0]["request"],
  selectedProviderShell?: SelectedProviderWorkspaceShell,
  options: { workspaceRoot?: string; targetId?: string } = {},
) {
  return Effect.runPromise(
    Effect.result(
      runRemoteWorkspaceProcess({
        callerThreadId: threadId,
        ...(selectedProviderShell ? { selectedProviderShell } : {}),
        request,
      }).pipe(
        Effect.provide(
          Layer.succeed(OrchestrationEngineService, {
            getReadModel: () =>
              Effect.succeed({
                threads: [
                  {
                    id: threadId,
                    projectId,
                    worktreePath: null,
                    workspaceExecutionTargetId: options.targetId ?? targetId,
                  },
                ],
                projects: [
                  {
                    id: projectId,
                    workspaceRoot: options.workspaceRoot ?? "/srv/project",
                    workspaceExecutionTargetId: options.targetId ?? targetId,
                  },
                ],
              }),
          } as never),
        ),
      ),
    ),
  );
}

afterEach(() => vi.clearAllMocks());

it("binds provider/session/invocation provenance to the workspace and returns the owner result", async () => {
  activateDevSshOwner();
  const calls: unknown[] = [];
  const result = await invoke(
    {
      remoteInvocationId: "provider-call-1",
      remoteCommand: "printf provider",
      remoteTimeoutMs: 5_000,
    },
    port(async (input) => {
      calls.push(input);
      return { output: "provider output\n", exitCode: 0, truncated: false, timedOut: false };
    }),
  );
  expect(result).toMatchObject({
    _tag: "Success",
    success: { stdout: "provider output\n", stderr: "", code: 0 },
  });
  expect(calls).toEqual([
    {
      workspaceRoot: "/srv/project",
      cwd: "/srv/project",
      provider: "thread-tool",
      sessionId: threadId,
      invocationId: "provider-call-1",
      command: "printf provider",
      timeoutMs: 5_000,
    },
  ]);
  expect(runToolCommand).not.toHaveBeenCalled();
});

it("refuses stdin, caller argv and fixed tool commands before dispatch", async () => {
  activateDevSshOwner();
  const selected = port(async () => ({
    output: "",
    exitCode: 0,
    truncated: false,
    timedOut: false,
  }));
  for (const [label, request, expected] of [
    [
      "stdin",
      { remoteInvocationId: "p-stdin", remoteCommand: "cat", remoteStdin: "input" },
      "does not accept stdin",
    ],
    [
      "argv",
      { remoteInvocationId: "p-args", remoteCommand: "printf", remoteArgs: ["x"] },
      "not caller-selected argv",
    ],
    [
      "fixed",
      { remoteInvocationId: "p-fixed", remoteCommand: "rg pattern" },
      PROVIDER_SHELL_REFUSAL,
    ],
  ] as const) {
    const result = await invoke(request, selected);
    expect(result._tag, label).toBe("Failure");
    if (result._tag === "Failure")
      expect(JSON.stringify(result.failure), label).toContain(expected);
  }
  expect(runToolCommand).not.toHaveBeenCalled();
});

it("refuses cross-target, cross-workspace and owner-less selected requests", async () => {
  activateDevSshOwner();
  const selected = port(async () => ({
    output: "",
    exitCode: 0,
    truncated: false,
    timedOut: false,
  }));
  for (const [label, candidate, options] of [
    ["cross target", { ...selected, targetId: "ssh:other" }, {}],
    ["cross workspace", { ...selected, workspaceRoot: "/srv/other" }, {}],
    ["no owner", undefined, {}],
  ] as const) {
    const result = await invoke(
      { remoteInvocationId: `p-${label.replaceAll(" ", "-")}`, remoteCommand: "printf x" },
      candidate,
      options,
    );
    expect(result._tag, label).toBe("Failure");
    if (result._tag === "Failure")
      expect(JSON.stringify(result.failure), label).toContain("exact selected SSH workspace");
  }
  expect(runToolCommand).not.toHaveBeenCalled();
});

it("keeps the provider verb separate from the thread-shell verb", async () => {
  const operations: Array<{ kind: string; provider?: string }> = [];
  const client = makePickerProofShellClient(async (operation) => {
    operations.push(operation);
    return {
      kind: "proofProviderShell",
      value: { output: "ok\n", exitCode: 0, truncated: false, timedOut: false },
    };
  });
  await expect(
    client.runProofProviderWorkspaceShell({
      workspaceRoot: "/srv/project",
      cwd: "/srv/project",
      provider: "thread-tool",
      sessionId: threadId,
      invocationId: "inv-1",
      command: "printf ok",
      timeoutMs: 5_000,
    }),
  ).resolves.toEqual({ output: "ok\n", exitCode: 0, truncated: false, timedOut: false });
  expect(operations).toEqual([
    expect.objectContaining({
      kind: "proofRunProviderWorkspaceShell",
      provider: "thread-tool",
      sessionId: threadId,
      invocationId: "inv-1",
    }),
  ]);

  const threadOutcome = makePickerProofShellClient(async () => ({
    kind: "proofThreadShell",
    value: { output: "wrong\n", exitCode: 0, truncated: false, timedOut: false },
  }));
  await expect(
    threadOutcome.runProofProviderWorkspaceShell({
      workspaceRoot: "/srv/project",
      cwd: "/srv/project",
      provider: "thread-tool",
      sessionId: threadId,
      invocationId: "inv-2",
      command: "printf wrong",
      timeoutMs: 5_000,
    }),
  ).rejects.toMatchObject({ code: "protocolError" });
});

it("classifies fixed file, search, listing and patch commands as typed-verb actions", () => {
  for (const command of ["rg x", "grep x", "ls", "find .", "cat a", "sed -n 1p a", "apply_patch"]) {
    expect(isFixedProviderShellCommand(command), command).toBe(true);
  }
  expect(isFixedProviderShellCommand("printf ok")).toBe(false);
});

it("reads a zero exit code that protobuf omitted as a confirmed success", () => {
  // field 1 = "ok\n"; fields 3/4 are absent because their default values were omitted.
  const result = readProofShellResult(Uint8Array.from([0x0a, 0x03, 0x6f, 0x6b, 0x0a]));
  expect(result).toEqual({ output: "ok\n", exitCode: 0, truncated: false, timedOut: false });
});
