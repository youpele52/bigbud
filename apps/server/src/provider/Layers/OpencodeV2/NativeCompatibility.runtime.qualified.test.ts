import { afterEach, expect, it, vi } from "vitest";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { withV2RuntimeWarningFixture } from "./NativeCompatibility.runtime.warning.fixture.ts";
import {
  V2_N0_COMPATIBILITY_DIGEST,
  V2_N0_BOOTSTRAP_COMPATIBILITY,
  V2_N1_COMPATIBILITY_DIGEST,
  V2_N1_BOOTSTRAP_COMPATIBILITY,
} from "./Orchestration.compatibility.legacy.ts";
import { assertV2RuntimeBootstrap } from "./NativeCompatibility.qualification.ts";
import { v2NativeProofMetadata, v2NativeReadyNotice } from "./NativeCompatibility.status.ts";
import { v2NativeRuntimePlatform } from "./NativeCompatibility.platform.ts";
import { v2ConfigSourcePaths } from "./NativeCompatibility.sources.platform.ts";

const registry = vi.hoisted(() => ({ passes: [] as unknown[], failures: [] as unknown[] }));
vi.mock("./NativeCompatibility.qualification.registry.ts", () => ({
  V2_NATIVE_RELEASE_QUALIFICATIONS: registry.passes,
  V2_NATIVE_RELEASE_INCOMPATIBILITIES: registry.failures,
}));
afterEach(() => {
  registry.passes.length = 0;
  registry.failures.length = 0;
});

it("retains completed-evidence identity and success severity only for the qualified branch", async () => {
  registry.passes.push({ ...syntheticV2QualificationRecord(), ...v2NativeRuntimePlatform() });
  await withV2RuntimeWarningFixture("2.0.28", async (f) => {
    const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
    expect(proof.evidenceKind).toBe("qualified");
    expect(proof).toMatchObject(v2NativeRuntimePlatform());
    expect(proof.qualificationRecordId).toMatch(/^[a-f0-9]{64}$/);
    expect(v2NativeProofMetadata(proof)).toMatchObject({
      qualificationState: "qualified",
      qualificationRecordId: proof.qualificationRecordId,
    });
    expect(v2NativeReadyNotice("Verified")).toEqual({
      severity: "success",
      message: "Verified",
    });
  });
});

it.each(["platform", "arch"] as const)(
  "does not borrow qualification for another %s",
  async (field) => {
    const host = v2NativeRuntimePlatform();
    registry.passes.push({
      ...syntheticV2QualificationRecord(),
      ...host,
      [field]:
        field === "platform"
          ? host.platform === "linux"
            ? "darwin"
            : "linux"
          : host.arch === "arm64"
            ? "x64"
            : "arm64",
    });
    await withV2RuntimeWarningFixture("2.0.28", async (f) => {
      const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
      expect(proof.evidenceKind).toBe("runtime-checked");
      expect(proof).not.toHaveProperty("qualificationRecordId");
    });
  },
);

it.each([
  "malformed",
  "duplicate",
  "known-incompatible",
  "uncovered-bootstrap",
  "wrong-source-profile",
] as const)("does not downgrade %s evidence to runtime-only acceptance", async (scenario) => {
  const record = { ...syntheticV2QualificationRecord(), ...v2NativeRuntimePlatform() };
  if (scenario === "malformed") record.testedBinarySha256 = "invalid";
  if (scenario === "uncovered-bootstrap")
    record.bootstrapContractDigests = [V2_N0_COMPATIBILITY_DIGEST];
  if (scenario === "wrong-source-profile") record.semanticProfile = "v2-global-config-v1";
  registry.passes.push(record);
  if (scenario === "duplicate") registry.passes.push(record);
  if (scenario === "known-incompatible")
    registry.failures.push({
      format: "bigbud.thread.native-incompatible.v1",
      nativeVersion: "2.0.28",
      platform: record.platform,
      arch: record.arch,
      nativeContractDigest: record.nativeContractDigest,
      scope: "native-tool-schema-catalog-permissions",
      reason: "Synthetic incompatibility",
      resultsDigest: record.resultsDigest,
    });
  await withV2RuntimeWarningFixture("2.0.28", async (f) => {
    if (scenario === "wrong-source-profile")
      f.config.mockResolvedValue([
        { type: "directory", path: v2ConfigSourcePaths().systemRoot },
        { type: "directory", path: f.root },
      ]);
    await expect(
      verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root),
    ).rejects.toThrow();
  });
});

it("runtime-only evidence cannot widen N0's frozen version guard or accept an unknown descriptor", () => {
  const retained = {
    compatibility: V2_N0_BOOTSTRAP_COMPATIBILITY,
    compatibilityDigest: V2_N0_COMPATIBILITY_DIGEST,
  };
  expect(() => assertV2RuntimeBootstrap("2.0.26", retained)).not.toThrow();
  expect(() => assertV2RuntimeBootstrap("2.0.28", retained)).toThrow("original constraints");
  expect(() => assertV2RuntimeBootstrap("3.0.0", retained)).toThrow();
  expect(() =>
    assertV2RuntimeBootstrap("2.0.26", { ...retained, compatibilityDigest: "0".repeat(64) }),
  ).toThrow();
});

it("retains N1's exact historical descriptor and minimum without imposing it on newly generated bootstraps", () => {
  expect(V2_N1_COMPATIBILITY_DIGEST).toBe(
    "3f4f18e4a6b88f488a5fd52bf125a276647e67a3a3389699caf508712ff684d0",
  );
  const retained = {
    compatibility: V2_N1_BOOTSTRAP_COMPATIBILITY,
    compatibilityDigest: V2_N1_COMPATIBILITY_DIGEST,
  };
  for (const version of ["2.0.26", "2.0.28", "2.1.0"])
    expect(() => assertV2RuntimeBootstrap(version, retained)).not.toThrow();
  for (const version of ["2.0.0", "2.0.25", "3.0.0"])
    expect(() => assertV2RuntimeBootstrap(version, retained)).toThrow("original constraints");
});
