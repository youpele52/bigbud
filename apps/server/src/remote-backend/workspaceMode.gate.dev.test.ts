import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { machineIdentity } from "@bigbud/shared/machineIdentity";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker } from "../ssh/sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "../ssh/sshOwnerDevRuntime.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import { runSshCommand } from "../ssh/sshProcess.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "../ssh/sshTargetDisconnects.ts";
import { ServerConfig } from "../startup/config.ts";
import { WorkspaceModeGate, WorkspaceModeGateLive } from "./workspaceMode.gate.ts";
import { makeLocalWorkspaceModeStore } from "./workspaceMode.local.ts";
import { HOST_IDENTITY, makeWorkspaceModeFixture } from "./workspaceMode.test.helpers.ts";

vi.mock("../ssh/sshProcess.ts", () => ({ runSshCommand: vi.fn() }));
vi.mock("@bigbud/shared/machineIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bigbud/shared/machineIdentity")>()),
  machineIdentity: vi.fn(),
}));

const targetId = "ssh:host=fixture&auth=ssh-key&transport=direct-ssh";
const create = (workspaceRoot: string, workspaceExecutionTargetId = targetId) =>
  ({ type: "project.create", workspaceRoot, workspaceExecutionTargetId }) as OrchestrationCommand;
const turn = { type: "thread.message.submit", threadId: "t" } as OrchestrationCommand;
const model = (workspaceRoot: string) =>
  ({
    projects: [{ id: "p", workspaceRoot, workspaceExecutionTargetId: targetId }],
    threads: [{ id: "t", projectId: "p" }],
  }) as unknown as OrchestrationReadModel;

type DevSession = NonNullable<(typeof DevSshOwnerRuntime.Service)["session"]>;

async function makeGate(stateDir: string, session?: DevSession) {
  const config = Layer.succeed(ServerConfig, {
    mode: "desktop",
    stateDir,
  } as typeof ServerConfig.Service);
  const runtime = Layer.succeed(DevSshOwnerRuntime, { session });
  return Effect.runPromise(
    Effect.service(WorkspaceModeGate).pipe(
      Effect.provide(WorkspaceModeGateLive.pipe(Layer.provide([config, runtime]))),
    ),
  );
}

describe.runIf(process.platform === "linux" || process.platform === "darwin")(
  "live workspace mode gate with selected development SSH",
  () => {
    let fixture: ReturnType<typeof makeWorkspaceModeFixture>;
    let closePicker: (() => Promise<void>) | undefined;
    beforeEach(() => {
      vi.mocked(runSshCommand).mockReset();
      vi.mocked(machineIdentity).mockReset().mockReturnValue(HOST_IDENTITY);
      fixture = makeWorkspaceModeFixture();
    });
    afterEach(async () => {
      try {
        await closePicker?.();
      } finally {
        closePicker = undefined;
        fixture.close();
      }
    });

    async function setup(kind: DevSession["kind"] = "unix") {
      let connected = true;
      const ready = { os: "linux" as const, architecture: "aarch64" };
      const probeProofWorkspaceReadiness = vi.fn(
        async (request: { executionTargetId: string; workspaceRoot: string }) => {
          expect(request).toEqual({
            executionTargetId: targetId,
            workspaceRoot: fixture.workspace,
          });
          if (!connected) throw new PickerProofOwnerError("targetDisconnected");
          return ready;
        },
      );
      const picker = makeSshOwnerDevPicker({
        executionTargetId: targetId,
        host: "fixture",
        startOwner: async () => ({
          probeProofWorkspaceReadiness,
          listAliases: async () => ({ entries: [], truncated: false, maxEntries: 256 }),
          connect: async () => {
            connected = true;
            return { state: "connected" };
          },
          disconnect: async () => {
            connected = false;
            return { state: "disconnected" };
          },
          listRemoteFolders: vi.fn(),
          inspectTrust: vi.fn(),
          approveTrust: vi.fn(),
          close: async () => {},
        }),
      });
      closePicker = picker.close;
      const withOwner = vi.spyOn(picker, "withOwner");
      const session = {
        kind,
        targetId,
        fixture: { root: fixture.home, folder: fixture.workspace },
        picker,
      } as unknown as DevSession;
      const gate = await makeGate(fixture.base, session);
      const store = makeLocalWorkspaceModeStore({ home: fixture.home });
      return { gate, store, picker, probeProofWorkspaceReadiness, withOwner };
    }

    it("rechecks a held fixture reservation and denies a lazy turn after native admission is lost", async () => {
      const { gate, store, picker, probeProofWorkspaceReadiness, withOwner } = await setup();
      const root = fixture.workspace;
      const readModel = model(root);
      await Effect.runPromise(gate.check(create(root), readModel));
      expect(probeProofWorkspaceReadiness.mock.calls).toHaveLength(2);
      const reservation = await store.inspect(root);
      expect(reservation).toMatchObject({ current: { generation: 1, mode: "laptop-runtime" } });

      await picker.disconnectExecutionTarget({ executionTargetId: targetId });
      await expect(Effect.runPromise(gate.check(turn, readModel))).rejects.toMatchObject({
        detail: expect.stringContaining(REMOTE_TARGET_DISCONNECTED_MESSAGE),
      });
      await picker.connectExecutionTarget({ executionTargetId: targetId });
      await Effect.runPromise(gate.check(turn, readModel));
      expect(probeProofWorkspaceReadiness.mock.calls).toHaveLength(4);
      expect(withOwner).toHaveBeenCalledTimes(4);
      expect(await store.inspect(root)).toEqual(reservation);
      expect(gate.resolve(targetId)).toBeUndefined();
      expect(runSshCommand).not.toHaveBeenCalled();
    });

    it("refuses cold lazy claims on owner loss and does not cache the refusal as success", async () => {
      const { gate, store, probeProofWorkspaceReadiness } = await setup();
      const root = fixture.workspace;
      probeProofWorkspaceReadiness.mockRejectedValue(new PickerProofOwnerError("ownerUnavailable"));
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(Effect.runPromise(gate.check(turn, model(root)))).rejects.toMatchObject({
          detail: expect.stringContaining("development SSH owner is no longer available"),
        });
      }
      expect(probeProofWorkspaceReadiness.mock.calls).toHaveLength(2);
      expect(await store.inspect(root)).toMatchObject({ current: null });
      expect(runSshCommand).not.toHaveBeenCalled();
    });

    it("refuses a different target or root before dispatch and denies a failed native readiness check", async () => {
      const { gate, store, probeProofWorkspaceReadiness, withOwner } = await setup();
      const root = fixture.workspace;
      for (const request of [create(root, "ssh:another"), create(`${root}/.`)]) {
        await expect(Effect.runPromise(gate.check(request, model(root)))).rejects.toMatchObject({
          detail: expect.stringContaining("Only the disposable Rust SSH owner workspace"),
        });
      }
      expect(withOwner).not.toHaveBeenCalled();
      probeProofWorkspaceReadiness
        .mockResolvedValueOnce({ os: "linux", architecture: "aarch64" })
        .mockRejectedValueOnce(new PickerProofOwnerError("workspacePathDenied"));
      await expect(Effect.runPromise(gate.check(create(root), model(root)))).rejects.toMatchObject({
        detail: expect.stringContaining("development SSH owner rejected this operation"),
      });
      expect(probeProofWorkspaceReadiness.mock.calls).toHaveLength(3);
      expect(await store.inspect(root)).toMatchObject({ current: null });
      expect(runSshCommand).not.toHaveBeenCalled();
    });

    it("fails closed when the fixture-local store cannot establish a reservation", async () => {
      vi.mocked(machineIdentity).mockReturnValueOnce(HOST_IDENTITY).mockReturnValueOnce(null);
      const { gate, probeProofWorkspaceReadiness } = await setup();
      const root = fixture.workspace;
      await expect(Effect.runPromise(gate.check(turn, model(root)))).rejects.toMatchObject({
        detail: expect.stringContaining("no stable machine identity"),
      });
      expect(probeProofWorkspaceReadiness.mock.calls).toHaveLength(1);
      expect(runSshCommand).not.toHaveBeenCalled();
    });

    it.each(["windows", "linux-jump"] as const)(
      "does not allow unsupported selected %s reservations to skip or fall back",
      async (kind) => {
        const { gate, withOwner } = await setup(kind);
        const root = fixture.workspace;
        for (const request of [turn, create(root)]) {
          await expect(Effect.runPromise(gate.check(request, model(root)))).rejects.toMatchObject({
            detail: expect.stringContaining("cannot reserve a workspace"),
          });
        }
        expect(gate.resolve(targetId)).toBeUndefined();
        expect(withOwner).not.toHaveBeenCalled();
        expect(runSshCommand).not.toHaveBeenCalled();
      },
    );

    it("keeps the ordinary live SSH store and positive cache when no dev session is selected", async () => {
      const gate = await makeGate(fixture.base);
      vi.mocked(runSshCommand).mockResolvedValueOnce({
        stdout: "unsupported not-linux",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
      const root = fixture.workspace;
      expect(gate.resolve(targetId)?.mode).toBe("laptop-runtime");
      await Effect.runPromise(gate.check(create(root), model(root)));
      await Effect.runPromise(gate.check(turn, model(root)));
      expect(runSshCommand).toHaveBeenCalledTimes(1);
    });
  },
);
