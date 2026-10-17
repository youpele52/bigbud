import { createHash, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import {
  V2_N0_BOOTSTRAP_COMPATIBILITY,
  V2_N0_COMPATIBILITY_DIGEST,
  V2_N1_BOOTSTRAP_COMPATIBILITY,
  V2_N1_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import {
  V2_BOOTSTRAP_COMPATIBILITY,
  V2_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import {
  assertV2QualifiedBootstrap,
  validateV2NativeQualificationRegistry,
} from "./NativeCompatibility.qualification.ts";

it.each([
  ["N0", V2_N0_BOOTSTRAP_COMPATIBILITY, V2_N0_COMPATIBILITY_DIGEST],
  ["N1", V2_N1_BOOTSTRAP_COMPATIBILITY, V2_N1_COMPATIBILITY_DIGEST],
] as const)(
  "a signed retained %s descriptor keeps its original encoding rather than the new major-V2 policy",
  async (_name, compatibility, compatibilityDigest) => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const original = JSON.parse(
        await readFile(path.join(app.artifact.directory, "manifest.json"), "utf8"),
      );
      // Manifest mechanism fixture only: these modified owned bytes do not claim native conformance.
      const contents = new Map<string, string>();
      for (const [name] of original.hashes as [string, string][])
        contents.set(name, await readFile(path.join(app.artifact.directory, name), "utf8"));
      contents.set(
        "index.mjs",
        `${contents.get("index.mjs")}\n// retained descriptor mechanism fixture\n`,
      );
      const hashes = [...contents].map(([name, value]) => [
        name,
        createHash("sha256").update(value).digest("hex"),
      ]);
      const digest = createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
        directory = path.join(path.dirname(app.artifact.directory), digest);
      await mkdir(directory, { mode: 0o700 });
      for (const [name, value] of contents)
        await writeFile(path.join(directory, name), value, { mode: 0o600 });
      const { signature: _signature, ...body } = original;
      const retained = {
        ...body,
        artifactDigest: digest,
        bootstrapDigest: digest,
        compatibility,
        compatibilityDigest,
        hashes,
      };
      const signed = {
        ...retained,
        signature: sign(
          null,
          Buffer.from(JSON.stringify(["bigbud.thread.bootstrap.manifest.v1", retained])),
          app.artifact.privateKey,
        ).toString("base64url"),
      };
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify(signed), {
        mode: 0o600,
      });
      const loaded = await readV2RetainedArtifact(app.artifact, digest);
      expect(loaded.compatibility).toEqual(compatibility);
      expect(loaded.compatibilityDigest).toBe(compatibilityDigest);
      expect(loaded.bootstrapDigest).toBe(digest);
      expect(loaded.compatibilityDigest).not.toBe(app.artifact.compatibilityDigest);
      await loaded.verify();
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({ ...signed, compatibility: V2_BOOTSTRAP_COMPATIBILITY }),
        { mode: 0o600 },
      );
      await expect(loaded.verify()).rejects.toThrow("signed compatible");
    } finally {
      await app.close();
    }
  },
);

it("synthetic qualification for N0 alone does not require N1 coverage or admit N0 on 28", () => {
  const registry = validateV2NativeQualificationRegistry(
      [
        {
          ...syntheticV2QualificationRecord("2.0.26"),
          bootstrapContractDigests: [V2_N0_COMPATIBILITY_DIGEST],
        },
      ],
      [],
    ),
    record = registry.qualified.get(JSON.stringify(["2.0.26", "darwin", "arm64"]))!.record;
  const n0 = {
    compatibility: V2_N0_BOOTSTRAP_COMPATIBILITY,
    compatibilityDigest: V2_N0_COMPATIBILITY_DIGEST,
  };
  expect(() => assertV2QualifiedBootstrap(record, n0)).not.toThrow();
  expect(() =>
    assertV2QualifiedBootstrap(record, {
      compatibility: V2_BOOTSTRAP_COMPATIBILITY,
      compatibilityDigest: V2_COMPATIBILITY_DIGEST,
    }),
  ).toThrow("selected bootstrap");
  expect(() => assertV2QualifiedBootstrap({ ...record, nativeVersion: "2.0.28" }, n0)).toThrow(
    "original constraints",
  );
});
