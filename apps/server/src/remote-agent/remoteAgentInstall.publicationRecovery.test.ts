import { describe, expect, it, vi } from "vitest";
import { RemoteAgentRemoteCommandError } from "./remoteAgentDiagnostics.ts";
import {
  installInput,
  installManagerFixture,
  paths,
} from "./remoteAgentInstallManager.fixtures.ts";

describe("stage publication after a lost upload acknowledgement", () => {
  it("recovers an inbox claim refusal after the lock is released without uploading", async () => {
    const adopt = vi
      .fn()
      .mockRejectedValueOnce(
        new RemoteAgentRemoteCommandError("install", 75, false, "inbox is busy"),
      )
      .mockResolvedValue(paths);
    const fixture = installManagerFixture({
      probePlacedArtifact: async () => "inbox",
      adoptPlacedArtifact: adopt,
    });
    await expect(fixture.manager.install(installInput)).rejects.toThrow("exit 75");
    expect((await fixture.control.registry.read()).stages[0]).toMatchObject({
      phase: "failed",
      failure: "ambiguous",
    });
    await expect(fixture.manager.install(installInput)).resolves.toMatchObject({
      placement: "inbox",
      status: "staged",
    });
    expect((await fixture.control.registry.read()).stages[0]).toMatchObject({ phase: "published" });
    expect((await fixture.control.registry.read()).stages[0]).not.toHaveProperty("failure");
    expect(fixture.installArtifact).not.toHaveBeenCalled();
    expect(fixture.verifyInstalledAgent).toHaveBeenCalledOnce();
  });

  it("rechecks existing bytes and clears only the recovered stage failure on publication", async () => {
    let present = false;
    const upload = vi.fn(async () => {
      present = true;
      throw new RemoteAgentRemoteCommandError("install", 255, false, "Broken pipe");
    });
    const adopt = vi.fn(async () => paths);
    const fixture = installManagerFixture({
      installArtifact: upload,
      probePlacedArtifact: async () => (present ? "managed" : "absent"),
      adoptPlacedArtifact: adopt,
    });
    await expect(fixture.manager.install(installInput)).rejects.toThrow("exit 255");
    const failed = await fixture.control.registry.read();
    expect(failed.stages[0]).toMatchObject({ phase: "failed", failure: "ambiguous" });
    expect(failed.current).toBeNull();
    expect(failed.pending).toBeNull();

    await expect(fixture.manager.install(installInput)).resolves.toMatchObject({
      status: "staged",
      placement: "managed",
    });
    const recovered = await fixture.control.registry.read();
    expect(recovered.stages[0]).toMatchObject({ id: failed.stages[0]!.id, phase: "published" });
    expect(recovered.stages[0]).not.toHaveProperty("failure");
    expect(recovered.pending).toBe(recovered.builds[0]!.id);
    expect(recovered.current).toBeNull();
    expect(upload).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
    expect(fixture.verifyInstalledAgent).toHaveBeenCalledOnce();
    await expect(fixture.manager.install(installInput)).resolves.toMatchObject({
      status: "staged",
    });
    expect(upload).toHaveBeenCalledOnce();
  });
});
