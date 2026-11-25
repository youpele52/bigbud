import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile) as unknown as (
    ...args: unknown[]
  ) => Promise<{ stdout: string; stderr: string }>;
  spawnMock.mockImplementation(actual.spawn);
  execFileMock.mockImplementation(((...args: unknown[]) => run(...args)) as never);
  const execFile = Object.defineProperty(vi.fn(actual.execFile), promisify.custom, {
    value: execFileMock,
  });
  return { ...actual, execFile, spawn: spawnMock };
});
vi.mock("../../../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReadyAsync: vi.fn(async () => {
    throw new Error("legacy SSH readiness must not run for the selected owner");
  }),
}));
vi.mock("./PiRemoteWorkspaceBridge.ts", () => ({
  createPiRemoteWorkspaceBridge: vi.fn(async () => {
    throw new Error("the selected owner never builds a local workspace bridge");
  }),
}));

import { activateDevSshOwner, isDevSshOwnerSelected } from "../../../ssh/sshOwnerDevMode.ts";
import { DevSshOwnerRuntime } from "../../../ssh/sshOwnerDevRuntime.ts";
import { assertSshExecutionTargetReadyAsync } from "../../../ssh/sshVerification.ts";
import { resolveProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { resolveWorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { createPiRpcProcess } from "./RpcProcess.ts";
import {
  PI_OWNER_CANCEL_TIMEOUT_MS,
  PI_OWNER_START_TIMEOUT_MS,
  startOwnedPiRpcProcess,
  type PiOwnerExit,
  type PiOwnerSession,
  type PiRpcOwner,
} from "./RpcProcess.owner.ts";
import { resolveSelectedPiRpcOwner, selectedDevPiRpcOwner } from "./RpcProcess.owner.selected.ts";

const targetId = "ssh:host=pi-fixture&auth=ssh-key&transport=direct-ssh";
const threadId = ThreadId.makeUnsafe("thread-pi-owner-selected");
const cwd = "/srv/pi workspace";
const binaryPath = "/opt/pi/bin/pi";
const directTargets = {
  providerRuntimeTarget: resolveProviderRuntimeTarget({ executionTargetId: targetId }),
  workspaceTarget: resolveWorkspaceTarget({ executionTargetId: targetId, cwd }),
};

function ownerFixture(options: { readonly autoReady?: boolean } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = Promise.withResolvers<PiOwnerExit>();
  const ready = Promise.withResolvers<PiOwnerSession>();
  const cancel = vi.fn(async () => {});
  const session: PiOwnerSession = { stdin, stdout, stderr, exit: exit.promise };
  const owner = {
    probeProvider: vi.fn<PiRpcOwner["probeProvider"]>(async () => "pi v0.99.0\n"),
    startProvider: vi.fn<PiRpcOwner["startProvider"]>(() => ({ ready: ready.promise, cancel })),
  };
  const port: PiRpcOwner = owner;
  if (options.autoReady !== false) ready.resolve(session);
  stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8").trim()) as {
      readonly type: string;
      readonly id: string;
    };
    stdout.write(
      `${JSON.stringify({
        type: "response",
        command: request.type,
        id: request.id,
        success: true,
        data: { ok: true },
      })}\n`,
    );
  });
  const picker = {
    withOwner: vi.fn(
      async <A>(exactTarget: string, operation: (client: object) => Promise<A>): Promise<A> => {
        expect(exactTarget).toBe(targetId);
        return operation({ piRpcOwner: port });
      },
    ),
  };
  return { owner, ready, exit, cancel, picker };
}

beforeEach(() => {
  vi.clearAllMocks();
  activateDevSshOwner();
});

describe("selected Pi SSH owner composition", () => {
  it("resolves the typed Pi port from the composed dev owner service", async () => {
    const { owner, picker } = ownerFixture();
    const resolved = await Effect.runPromise(
      selectedDevPiRpcOwner().pipe(
        Effect.provide(
          Layer.succeed(DevSshOwnerRuntime, {
            session: { targetId, picker },
          } as never),
        ),
      ),
    );
    expect(resolved?.targetId).toBe(targetId);
    expect(resolved?.owner).toBe(owner);
    expect(picker.withOwner).toHaveBeenCalledOnce();
  });

  it("returns no binding when the selected dev runtime is absent", async () => {
    await expect(Effect.runPromise(selectedDevPiRpcOwner())).resolves.toBeUndefined();
  });

  it("starts, probes, requests and exits through the owner ports with zero legacy launches", async () => {
    const { owner, exit, cancel, picker } = ownerFixture();
    const binding = await resolveSelectedPiRpcOwner({ targetId, picker } as never);
    expect(binding?.owner).toBe(owner);

    const rpc = await createPiRpcProcess({
      ...directTargets,
      binaryPath,
      ownerBinding: { ...binding!, threadId, sessionEpoch: 4 },
    });

    expect(owner.probeProvider).toHaveBeenCalledExactlyOnceWith(
      { provider: "pi", threadId, sessionEpoch: 4, executionTargetId: targetId, binaryPath, cwd },
      expect.any(AbortSignal),
    );
    expect(owner.startProvider).toHaveBeenCalledExactlyOnceWith({
      provider: "pi",
      threadId,
      sessionEpoch: 4,
      executionTargetId: targetId,
      binaryPath,
      cwd,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(assertSshExecutionTargetReadyAsync).not.toHaveBeenCalled();
    expect(rpc.child).toBeUndefined();
    expect(rpc.supportsAgentSettled).toBe(true);

    await expect(rpc.request({ type: "get_state", id: "owner-rpc" }, 1_000)).resolves.toMatchObject(
      { success: true, id: "owner-rpc" },
    );

    const onExit = vi.fn();
    rpc.onExit(onExit);
    expect(rpc.isAlive()).toBe(true);
    exit.resolve({ kind: "signaled", signal: "SIGTERM" });
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(rpc.isAlive()).toBe(false);

    await rpc.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("suppresses the owner start when cancelled during the bounded probe", async () => {
    const { owner, picker } = ownerFixture();
    const binding = await resolveSelectedPiRpcOwner({ targetId, picker } as never);
    expect(binding?.owner).toBe(owner);
    const probing = Promise.withResolvers<AbortSignal>();
    owner.probeProvider.mockImplementationOnce((_runtime, signal) => {
      probing.resolve(signal);
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const acquisition = startOwnedPiRpcProcess({
      owner,
      threadId,
      sessionEpoch: 4,
      ...directTargets,
      binaryPath,
      signal: controller.signal,
    });
    const probeSignal = await probing.promise;
    const reason = new Error("cancel during owner probe");
    controller.abort(reason);
    await expect(acquisition).rejects.toBe(reason);
    expect(probeSignal.aborted).toBe(true);
    expect(owner.startProvider).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("bounds an unconfirmed owner teardown instead of spawning a child", async () => {
    const { owner, cancel } = ownerFixture({ autoReady: false });
    cancel.mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const acquisition = startOwnedPiRpcProcess({
        owner,
        threadId,
        sessionEpoch: 4,
        ...directTargets,
        binaryPath,
      });
      const rejected = expect(acquisition).rejects.toMatchObject({
        message: "Pi SSH owner RPC start cleanup failed.",
      });
      await vi.advanceTimersByTimeAsync(PI_OWNER_START_TIMEOUT_MS + PI_OWNER_CANCEL_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("refuses selected remote Pi without an owner binding before any launch", async () => {
    expect(isDevSshOwnerSelected()).toBe(true);
    await expect(createPiRpcProcess({ ...directTargets, binaryPath })).rejects.toMatchObject({
      code: "unsupported-by-selected-ssh-owner",
      capability: "remote-rpc-start",
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(assertSshExecutionTargetReadyAsync).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "leaves local Pi on its child-process path with the owner selected",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "bigbud-pi-owner-local-"));
      const localBinary = path.join(root, "pi-recorder");
      try {
        await writeFile(
          localBinary,
          `#!/bin/sh
case "$*" in
  --version) printf '%s\\n' '1.4.0';;
  '--mode rpc')
    IFS= read -r request
    printf '%s\\n' '{"type":"response","command":"get_state","id":"local-owner-test","success":true}'
    IFS= read -r unused;;
  *) exit 2;;
esac
`,
        );
        await chmod(localBinary, 0o700);
        const rpc = await createPiRpcProcess({
          binaryPath: localBinary,
          providerRuntimeTarget: { location: "local", executionTargetId: "local" },
          workspaceTarget: { location: "local", executionTargetId: "local", cwd: root },
          env: {},
        });
        try {
          expect(rpc.child).toBeDefined();
          expect(rpc.command).toBe(localBinary);
          expect(spawnMock).toHaveBeenCalledOnce();
          await expect(
            rpc.request({ type: "get_state", id: "local-owner-test" }, 2_000),
          ).resolves.toMatchObject({ success: true });
        } finally {
          await rpc.stop();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
