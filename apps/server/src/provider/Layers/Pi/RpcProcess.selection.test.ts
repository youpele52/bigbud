import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

import { createPiOrchestrationBridge } from "../../../orchestration-tools/PiOrchestrationBridge.ts";
import { resolveProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { activateDevSshOwner } from "../../../ssh/sshOwnerDevMode.ts";
import { assertSshExecutionTargetReadyAsync } from "../../../ssh/sshVerification.ts";
import { resolveWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { makePiStartSession } from "./Adapter.methods.startSession.ts";
import { createPiRemoteWorkspaceBridge } from "./PiRemoteWorkspaceBridge.ts";
import { detectPiSettlementSupport } from "./RpcProcess.capabilities.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";

const { runVersion } = vi.hoisted(() => ({ runVersion: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  runVersion.mockImplementation(promisify(actual.execFile));
  const execFile = Object.defineProperty(vi.fn(actual.execFile), promisify.custom, {
    value: runVersion,
  });
  return { ...actual, execFile, spawn: vi.fn(actual.spawn) };
});
vi.mock("../../../orchestration-tools/PiOrchestrationBridge.ts", () => ({
  createPiOrchestrationBridge: vi.fn(),
}));
vi.mock("../../../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: vi.fn(),
}));
vi.mock("./PiRemoteWorkspaceBridge.ts", () => ({ createPiRemoteWorkspaceBridge: vi.fn() }));

const local = "local";
const direct = "ssh:host=bigbud-loopback&auth=ssh-key&transport=direct-ssh";
const other = "ssh:host=other.invalid&auth=ssh-key&transport=direct-ssh";
const agent = "ssh:host=bigbud-loopback&auth=ssh-key&transport=agent";
const cwd = "/disposable-workspace";
const threadId = ThreadId.makeUnsafe("pi-selected-owner-test");
const unsupportedCode = "unsupported-by-selected-ssh-owner";

beforeAll(activateDevSshOwner);
beforeEach(() => vi.clearAllMocks());

function rpcOptions(runtimeId: string, workspaceId: string) {
  return {
    binaryPath: "/nonexistent/pi-recorder",
    providerRuntimeTarget: resolveProviderRuntimeTarget({ executionTargetId: runtimeId }),
    workspaceTarget: resolveWorkspaceTarget({ executionTargetId: workspaceId, cwd }),
    env: {},
  };
}

function expectNoLaunchSideEffects() {
  expect(assertSshExecutionTargetReadyAsync).not.toHaveBeenCalled();
  expect(createPiOrchestrationBridge).not.toHaveBeenCalled();
  expect(createPiRemoteWorkspaceBridge).not.toHaveBeenCalled();
  expect(runVersion).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
}

it.each([
  [direct, direct, "remote-rpc-start"],
  [other, other, "remote-rpc-start"],
  [agent, agent, "remote-rpc-start"],
  [direct, local, "remote-rpc-start"],
  [direct, other, "remote-rpc-start"],
  [local, direct, "remote-workspace-bridge"],
  [local, agent, "remote-workspace-bridge"],
])(
  "denies Pi RPC for runtime %s and workspace %s before any side effects",
  async (runtimeId, workspaceId, capability) => {
    await expect(createPiRpcProcess(rpcOptions(runtimeId, workspaceId))).rejects.toMatchObject({
      code: unsupportedCode,
      capability,
    });
    expectNoLaunchSideEffects();
  },
);

it.each([
  {
    providerRuntimeExecutionTargetId: direct,
    workspaceExecutionTargetId: direct,
    detail: "remote RPC start",
  },
  {
    providerRuntimeExecutionTargetId: local,
    workspaceExecutionTargetId: direct,
    detail: "local-runtime remote workspace bridge",
  },
])(
  "rejects the adapter's resolved targets before preparing thread tools: $detail",
  async ({ detail, ...executionTargets }) => {
    const readSettings = vi.fn();
    const sessions = new Map();
    const startSession = makePiStartSession({
      attachmentsDir: "/tmp",
      stateDir: "/unused",
      host: "127.0.0.1",
      port: 3773,
      emit: () => Effect.die("denied launch must not emit events"),
      handleProcessExit: () => Effect.void,
      handleStdoutEvent: () => Effect.void,
      makeSyntheticEvent: () => Effect.die("denied launch must not emit events"),
      runPromise: Effect.runPromise,
      serverSettings: { getSettings: Effect.sync(readSettings) },
      sessions,
    });

    await expect(
      Effect.runPromise(
        startSession({
          ...executionTargets,
          provider: "pi",
          threadId,
          cwd,
          runtimeMode: "full-access",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ProviderAdapterProcessError",
      detail: `Pi ${detail} is unavailable with the source-dev SSH owner.`,
      cause: { code: unsupportedCode },
    });
    expect(readSettings).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
    expectNoLaunchSideEffects();
  },
);

it("refuses a direct remote version probe without invoking its runner", async () => {
  const run = vi.fn();
  await expect(detectPiSettlementSupport(rpcOptions(direct, direct), run)).rejects.toMatchObject({
    code: unsupportedCode,
    capability: "remote-version-probe",
  });
  expect(run).not.toHaveBeenCalled();
  expectNoLaunchSideEffects();
});

it.skipIf(process.platform === "win32")(
  "keeps local Pi RPC available with the owner selected",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bigbud-pi-selection-"));
    const binaryPath = path.join(root, "pi-recorder");
    try {
      await writeFile(
        binaryPath,
        `#!/bin/sh
case "$*" in
  --version) printf '%s\\n' '1.4.0';;
  '--mode rpc')
    IFS= read -r request
    [ "$request" = '{"type":"get_state","id":"local-recorder"}' ] || exit 1
    printf '%s\\n' '{"type":"response","command":"get_state","id":"local-recorder","success":true}'
    IFS= read -r unused;;
  *) exit 2;;
esac
`,
      );
      await chmod(binaryPath, 0o700);
      const rpc = await createPiRpcProcess({
        ...rpcOptions(local, local),
        binaryPath,
        workspaceTarget: resolveWorkspaceTarget({ executionTargetId: local, cwd: root }),
      });
      try {
        expect(rpc.supportsAgentSettled).toBe(true);
        expect(rpc.supportsPromptDisposition).toBe(true);
        await expect(
          rpc.request({ type: "get_state", id: "local-recorder" }, 2_000),
        ).resolves.toMatchObject({ success: true });
        expect(runVersion).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledOnce();
        expect(assertSshExecutionTargetReadyAsync).not.toHaveBeenCalled();
      } finally {
        await rpc.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
