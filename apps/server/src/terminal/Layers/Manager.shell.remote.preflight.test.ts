import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preflightRemoteTerminalShellProfile } from "./Manager.shell.remote";

const mocks = vi.hoisted(() => ({ composition: vi.fn(), binding: vi.fn(), getBound: vi.fn() }));
vi.mock("../../remote-agent/remoteAgentDefault.ts", () => ({
  getConfiguredRemoteAgentComposition: mocks.composition,
}));
vi.mock("../../remote-agent/remoteAgentAdmission.ts", () => ({
  remoteAgentAdmission: { resolveBinding: mocks.binding },
}));
const target = "ssh:host=example.test&user=tester&transport=agent";
const binding = { targetKey: "retained-binding" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.composition.mockReturnValue({
    managed: true,
    ptyResolver: { restoreOrCreate: vi.fn() },
    pool: { getBound: mocks.getBound },
  });
  mocks.binding.mockResolvedValue(binding);
  mocks.getBound.mockResolvedValue({});
});

describe("Manager authenticated durable profile preflight", () => {
  it("requires profile capability on the authenticated lifecycle binding", async () => {
    await Effect.runPromise(preflightRemoteTerminalShellProfile(target));
    expect(mocks.binding).toHaveBeenCalledWith(target);
    expect(mocks.getBound).toHaveBeenCalledWith(target, binding, [
      "terminal.pty",
      "workspace.files",
      "terminal.shell-profiles",
    ]);
  });
  for (const composition of [
    null,
    { managed: false, ptyResolver: { restoreOrCreate: vi.fn() } },
    { managed: true, ptyResolver: {} },
  ]) {
    it("rejects missing/unmanaged/nonowned lane before resolving a binding", async () => {
      mocks.composition.mockReturnValue(composition);
      const result = await Effect.runPromise(
        preflightRemoteTerminalShellProfile(target).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect(mocks.binding).not.toHaveBeenCalled();
      expect(mocks.getBound).not.toHaveBeenCalled();
    });
  }
  it("supports ordinary/custom ownership using its own pinned binding, not managed admission", async () => {
    const resolveProfileBinding = vi.fn(async () => binding);
    mocks.composition.mockReturnValue({
      managed: false,
      ptyResolver: { restoreOrCreate: vi.fn(), resolveProfileBinding },
      pool: { getBound: mocks.getBound },
    });
    await Effect.runPromise(preflightRemoteTerminalShellProfile(target));
    expect(resolveProfileBinding).toHaveBeenCalledWith(target);
    expect(mocks.binding).not.toHaveBeenCalled();
    expect(mocks.getBound).toHaveBeenCalledWith(target, binding, [
      "terminal.pty",
      "workspace.files",
      "terminal.shell-profiles",
    ]);
  });
  it("rejects unavailable authenticated binding without transport fallback", async () => {
    mocks.binding.mockResolvedValue(undefined);
    const result = await Effect.runPromise(
      preflightRemoteTerminalShellProfile(target).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(mocks.getBound).not.toHaveBeenCalled();
  });
  it("rejects old-agent capability failure as a typed discovery error", async () => {
    mocks.getBound.mockRejectedValue(new Error("terminal.shell-profiles unavailable"));
    const result = await Effect.runPromise(
      preflightRemoteTerminalShellProfile(target).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.reason).toBe("unsupported-target");
    expect(mocks.getBound).toHaveBeenCalledTimes(1);
  });
});
