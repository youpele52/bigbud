import { expect, it } from "vitest";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { withV2RuntimeWarningFixture } from "./NativeCompatibility.runtime.warning.fixture.ts";
import { v2ConfigSourcePaths } from "./NativeCompatibility.sources.platform.ts";

it.each(["allow", "deny"] as const)(
  "checks %s permissions in the native document-before-directory layout",
  async (effect) => {
    await withV2RuntimeWarningFixture("2.0.28", async (f) => {
      f.config.mockResolvedValue([
        {
          type: "document",
          path: `${f.root}/opencode.json`,
          info: {
            permissions: [{ action: "bigbud_thread_v1_*", resource: "*", effect }],
          },
        },
        { type: "directory", path: f.root },
        { type: "directory", path: `${f.directory}/.opencode` },
      ]);
      const result = verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
      if (effect === "deny") await expect(result).rejects.toThrow("native source policy is denied");
      else
        await expect(result).resolves.toMatchObject({
          evidenceKind: "runtime-checked",
          semanticProfile: "v2-global-config-v1",
        });
    });
  },
);

it.each(["2.0.0", "2.0.25", "2.0.26", "2.0.27", "2.0.28", "2.1.0", "2.999.999"])(
  "production runtime checks permit %s without fabricating semantic qualification",
  async (version) => {
    await withV2RuntimeWarningFixture(version, async (f) => {
      const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
      expect(proof.evidenceKind).toBe("runtime-checked");
      expect(proof).not.toHaveProperty("qualificationRecordId");
      expect(proof).toMatchObject({
        nativeVersion: version,
        semanticProfile: "v2-global-config-v1",
        compatibilityDigest: f.artifact.compatibilityDigest,
      });
      proof.assertCurrent();
    });
  },
);

it.each(["2.0.0", "2.0.25", "2.0.28", "2.999.999"])(
  "stable V2 %s still requires the actual canonical API",
  async (version) => {
    await withV2RuntimeWarningFixture(version, async (f) => {
      delete f.contract.paths["/api/config"];
      await expect(
        verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root),
      ).rejects.toMatchObject({ reasonCode: "native-contract-incompatible" });
      expect(f.config).not.toHaveBeenCalled();
    });
  },
);

it("derives the system/global profile from observed source shape, never a version range", async () => {
  await withV2RuntimeWarningFixture("2.9.123", async (f) => {
    const { systemRoot, paths } = v2ConfigSourcePaths();
    f.config.mockResolvedValue([
      { type: "directory", path: systemRoot },
      {
        type: "document",
        path: paths.join(systemRoot, "opencode.json"),
        info: {},
      },
      { type: "directory", path: f.root },
    ]);
    expect(
      (await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root)).semanticProfile,
    ).toBe("v2-system-global-config-v1");
  });
});

it.each(["bad-api", "ambiguous-source", "native-deny", "revoked", "expired"] as const)(
  "missing qualification never masks %s",
  async (scenario) => {
    await withV2RuntimeWarningFixture("2.0.28", async (f) => {
      if (scenario === "bad-api") delete f.contract.paths["/api/config"];
      if (scenario === "ambiguous-source")
        f.config.mockResolvedValue([
          { type: "directory", path: "/fixture/foreign-root" },
          { type: "directory", path: f.root },
        ]);
      if (scenario === "native-deny")
        f.config.mockResolvedValue([
          { type: "directory", path: f.root },
          {
            type: "document",
            info: {
              permissions: [{ action: "bigbud_thread_v1_*", resource: "*", effect: "deny" }],
            },
          },
        ]);
      if (scenario === "revoked" || scenario === "expired")
        f.config.mockImplementation(async () => {
          if (scenario === "revoked") f.revoke();
          else
            f.context.operationGuard = () => {
              throw new Error("V2 short deadline expired");
            };
          return [{ type: "directory", path: f.root }];
        });
      await expect(
        verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root),
      ).rejects.toThrow();
    });
  },
);
