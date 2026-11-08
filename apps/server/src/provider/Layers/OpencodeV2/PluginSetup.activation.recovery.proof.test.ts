import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { makeV2RecoveryProofFixture } from "./PluginSetup.activation.recovery.proof.fixture.ts";
import { V2HttpStatusError } from "./Client.errors.ts";

it.each([false, true])(
  "recovers both v3 owners using production proof scope before v4 publication (renumbered: %s)",
  async (renumbered) => {
    const x = await makeV2RecoveryProofFixture();
    try {
      if (renumbered) {
        const dev = Number(x.f.publication.rootIdentity.dev) + 1;
        await x.f.installations.replace(
          x.f.key,
          (await x.f.installations.read(x.f.key))!.revision,
          {
            ...x.f.publication,
            rootIdentity: { ...x.f.publication.rootIdentity, dev },
            pluginsIdentity: { ...x.f.publication.pluginsIdentity, dev },
            nextIdentity: { ...x.f.publication.nextIdentity, dev },
          },
        );
      }
      const before = await x.f.enrollments.inventory();
      await x.run();
      for (const identity of x.identities) await x.retirement.assertSettled(identity);
      expect(x.f.rpc.mock.calls.filter(([input]) => input.method === "detach")).toHaveLength(2);
      expect(await x.f.enrollments.inventory()).toEqual(before);
      expect(await readFile(x.f.filename, "utf8")).not.toBe(x.f.entry.content);
      expect(x.job.installed).toHaveBeenCalledWith(
        x.f.app.artifact.artifactDigest,
        expect.anything(),
      );
      expect(x.f.client.session.create).not.toHaveBeenCalled();
      expect(x.f.client.session.update).not.toHaveBeenCalled();
      expect(x.f.client.session.prompt).not.toHaveBeenCalled();
    } finally {
      await x.close();
    }
  },
);

it.each([
  "missing-plugin",
  "native-rejection",
  "wrong-inspection",
  "wrong-detach",
  "incomplete-detach",
])("preserves owners and installation when release encounters %s", async (scenario) => {
  const x = await makeV2RecoveryProofFixture();
  try {
    const before = await x.f.enrollments.inventory();
    const original = x.f.rpc.getMockImplementation()!;
    x.f.rpc.mockImplementation(async (input) => {
      if (["inspect", "detach"].includes(input.method)) {
        if (scenario === "missing-plugin") throw new V2HttpStatusError(404);
        if (scenario === "native-rejection")
          throw new Error("native payload with PRIVATE_FIXTURE_SECRET");
        const result = await original(input);
        if (scenario === "wrong-inspection" && input.method === "inspect")
          return { output: { ...result.output, ownerDigest: "f".repeat(64) } };
        if (scenario === "wrong-detach" && input.method === "detach")
          return { output: { ...result.output, enrollmentNonce: "f".repeat(32) } };
        if (scenario === "incomplete-detach" && input.method === "detach")
          return { output: { state: "revoked" } };
        return result;
      }
      return original(input);
    });
    const error = await x.run().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("owner=");
    expect((error as Error).message).toContain(
      scenario.includes("detach") ? "stage=detach-acknowledgement" : "stage=inspect",
    );
    expect((error as Error).message).not.toContain("PRIVATE_FIXTURE_SECRET");
    expect(await x.f.enrollments.inventory()).toEqual(before);
    expect(await readFile(x.f.filename, "utf8")).toBe(x.f.entry.content);
    expect(x.job.installed).not.toHaveBeenCalled();
    for (const identity of x.identities)
      await expect(x.retirement.assertSettled(identity)).rejects.toThrow();
  } finally {
    await x.close();
  }
});

it.each(["native-active", "native-read-failed", "live-owner", "lost-lock", "generation-changed"])(
  "refuses recovery without detaching when %s",
  async (scenario) => {
    const x = await makeV2RecoveryProofFixture();
    try {
      const before = await x.f.enrollments.inventory();
      if (scenario === "native-active")
        vi.mocked(x.f.client.session.active).mockResolvedValue({
          [x.f.owner.nativeSessionId]: { type: "running" },
          "second-native": { type: "running" },
        });
      if (scenario === "native-read-failed")
        vi.mocked(x.f.client.session.active).mockRejectedValue(new Error("PRIVATE_FIXTURE_SECRET"));
      if (scenario === "live-owner") vi.mocked(x.backend.classifyOwner).mockReturnValue("live");
      if (scenario === "lost-lock")
        vi.mocked(x.backend.assertHeld).mockRejectedValue(new Error("V2 fixture lock lost"));
      if (scenario === "generation-changed") x.loseGeneration();
      await expect(x.run()).rejects.toThrow();
      expect(x.f.rpc.mock.calls.some(([input]) => input.method === "detach")).toBe(false);
      expect(await x.f.enrollments.inventory()).toEqual(before);
      expect(await readFile(x.f.filename, "utf8")).toBe(x.f.entry.content);
      expect(x.job.installed).not.toHaveBeenCalled();
    } finally {
      await x.close();
    }
  },
);
