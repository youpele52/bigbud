import { describe, expect, it, vi } from "vitest";
import {
  installInput,
  installManagerFixture,
  paths,
} from "./remoteAgentInstallManager.fixtures.ts";

describe("remote staged install cancellation", () => {
  it("does not mutate for a pre-aborted caller", async () => {
    const fixture = installManagerFixture();
    await expect(
      fixture.manager.install({
        ...installInput,
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(fixture.installArtifact).not.toHaveBeenCalled();
  });
  it("honors cancellation while waiting for the install lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const verify = vi.fn(async () => {
      await gate;
    });
    const fixture = installManagerFixture({ verifyInstalledAgent: verify });
    const first = fixture.manager.install(installInput);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const second = fixture.manager.install({ ...installInput, signal: controller.signal });
    const rejected = expect(second).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    release();
    await first;
    await rejected;
    expect(fixture.installArtifact).toHaveBeenCalledOnce();
  });
  it("cancels before publication without changing selection or starting a supervisor", async () => {
    const controller = new AbortController();
    const fixture = installManagerFixture({
      installArtifact: async () => {
        controller.abort(new Error("cancelled"));
        return paths;
      },
    });
    await expect(
      fixture.manager.install({ ...installInput, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    const state = await fixture.control.registry.read();
    expect(state).toMatchObject({ pending: null, current: null, launches: [] });
    expect(state.stages[0]?.phase).toBe("cancelled");
  });
});
