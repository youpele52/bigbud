import { describe, expect, it, vi } from "vitest";
import { cleanupRemoteAgentBuilds } from "./remoteAgentInstall.cleanup.ts";
import { installInput, installManagerFixture } from "./remoteAgentInstallManager.fixtures.ts";

async function unselectedBuild() {
  const fixture = installManagerFixture();
  await fixture.manager.install(installInput);
  const state = await fixture.control.registry.update((current) => ({
    ...current,
    revision: current.revision + 1,
    pending: null,
    stages: [],
  }));
  const build = state.builds[0]!;
  vi.mocked(fixture.control.run).mockImplementation(async (command) =>
    command.includes("printf deleted") ? "deleted" : "absent",
  );
  return { ...fixture, build };
}

describe("ordinary cleanup durable reference recheck", () => {
  it.each(["referenced", "unreadable"] as const)(
    "preserves bytes if service refs become %s after the initial snapshot",
    async (outcome) => {
      const fixture = await unselectedBuild();
      let observations = 0;
      const references = vi.fn(async () => {
        if (++observations === 1) return new Set<string>();
        if (outcome === "unreadable") throw new Error("service metadata unavailable");
        return new Set([fixture.build.id]);
      });
      expect(await cleanupRemoteAgentBuilds(fixture.control, references)).toMatchObject({
        deleted: 0,
      });
      expect(references).toHaveBeenCalledTimes(2);
      const state = await fixture.control.registry.read();
      expect(state.builds[0]?.binary).toBe("present");
      expect(state.retirementReservations[0]?.phase).toBe("failed");
      expect(
        vi
          .mocked(fixture.control.run)
          .mock.calls.every(([command]) => !command.includes("printf deleted")),
      ).toBe(true);
    },
  );

  it("manager cleanup honors its explicit reference source and propagates unknown state", async () => {
    const references = vi.fn(async () => {
      throw new Error("service inventory unavailable");
    });
    const fixture = installManagerFixture({ referencedBuildIds: references });
    await expect(fixture.manager.cleanup(installInput.executionTargetId)).rejects.toThrow(
      "service inventory unavailable",
    );
    expect(references).toHaveBeenCalledWith(installInput.executionTargetId);
  });
});
