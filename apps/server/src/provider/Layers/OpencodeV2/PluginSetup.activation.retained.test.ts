import { readFile, stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { knownV2BootstrapCompatibility } from "./Orchestration.compatibility.ts";
import {
  assertV2RuntimeBootstrap,
  assertV2QualifiedBootstrap,
  validateV2NativeQualificationRegistry,
} from "./NativeCompatibility.qualification.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import { createHash } from "node:crypto";
import {
  V2_N4_BOOTSTRAP_COMPATIBILITY,
  V2_N4_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";

vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => {
    throw new Error("No native activation/reload allowed in retained adoption fixture");
  },
}));

it("recognizes the exact signed PREVIOUS-current v3 descriptor derived from pinned HEAD", async () => {
  const f = await makeV2RetainedActivationFixture();
  try {
    expect(f.installed.compatibilityDigest).toBe(
      "d992b9c514082e59f91d877d954048e62a4a5025836b295097cdb64719d7b7db",
    );
    const retained = await readV2RetainedArtifact(f.preferred, f.installed.artifactDigest);
    expect(
      knownV2BootstrapCompatibility(retained.compatibility, retained.compatibilityDigest),
    ).toEqual(f.installed.compatibility);
    expect(() => assertV2RuntimeBootstrap("2.2.0", retained)).not.toThrow();
    expect(retained.compatibilityDigest).not.toBe(f.preferred.compatibilityDigest);
    await retained.verify();
    expect(
      createHash("sha256").update(JSON.stringify(V2_N4_BOOTSTRAP_COMPATIBILITY)).digest("hex"),
    ).toBe(V2_N4_COMPATIBILITY_DIGEST);
    expect(() =>
      assertV2QualifiedBootstrap(
        [
          ...validateV2NativeQualificationRegistry(
            [syntheticV2QualificationRecord("2.2.0")],
            [],
          ).qualified.values(),
        ][0]!.record,
        retained,
      ),
    ).toThrow("selected bootstrap");
  } finally {
    await f.close();
  }
});

it("adopts the unchanged active signed same-issuer managed entry despite unsettled retained owners, without any native or durable mutation", async () => {
  const f = await makeV2RetainedActivationFixture();
  try {
    const owners = await f.enrollments.inventory(),
      publications = await f.installations.inventory();
    // Expiry is not retirement: the same old owner still blocks preferred-byte replacement.
    await expect(assertV2PluginUpgradeIdle(f.preferred)).rejects.toThrow();
    const ready = await f.ready();
    expect(ready.stamp.bootstrapDigest).toBe(f.installed.artifactDigest);
    expect(f.installed.artifactDigest).not.toBe(f.preferred.artifactDigest);
    expect(f.setup).not.toHaveBeenCalled();
    expect(await f.enrollments.inventory()).toEqual(owners);
    expect(await f.installations.inventory()).toEqual(publications);
    expect(await readFile(f.filename, "utf8")).toBe(f.entry.content);
    expect((await stat(f.filename)).ino).toBe(f.nativeFile.identity.ino);
    expect(f.rpc.mock.calls.every(([input]) => input.method === "info")).toBe(true);
    expect(f.client.session.active as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(f.client.session.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(f.client.session.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(f.client.session.prompt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // A subsequent new foreground readiness uses the same exact registration, not preferred bytes.
    const again = await f.ready();
    expect(again.stamp.bootstrapDigest).toBe(f.installed.artifactDigest);
    expect(f.setup).not.toHaveBeenCalled();
    await expect(assertV2PluginUpgradeIdle(f.preferred)).rejects.toThrow();
  } finally {
    await f.close();
  }
});
