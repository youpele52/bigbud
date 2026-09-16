import { describe, expect, it } from "vitest";
import { installInput, installManagerFixture } from "./remoteAgentInstallManager.fixtures.ts";

describe("staged publication reconciliation", () => {
  it("reconciles a lost publication reply without clearing committed pending state", async () => {
    const fixture = installManagerFixture();
    const update = fixture.control.registry.update;
    fixture.control.registry.update = async (transition) => {
      const state = await update(transition);
      if (state.pending) throw new Error("lost publication acknowledgement");
      return state;
    };
    await expect(fixture.manager.install(installInput)).resolves.toMatchObject({
      status: "staged",
    });
    expect((await fixture.control.registry.read()).stages[0]?.phase).toBe("published");
    expect(fixture.runRemoteCommand).not.toHaveBeenCalled();
  });
  it("retains uncertain reservation when publication cannot be proven", async () => {
    const fixture = installManagerFixture();
    const update = fixture.control.registry.update;
    let writes = 0;
    fixture.control.registry.update = async (transition) => {
      if (++writes === 2) throw new Error("publication unavailable");
      return update(transition);
    };
    await expect(fixture.manager.install(installInput)).rejects.toThrow("publication unavailable");
    expect(await fixture.control.registry.read()).toMatchObject({ current: null, pending: null });
    expect((await fixture.control.registry.read()).stages[0]?.phase).toBe("reserved");
  });
});
