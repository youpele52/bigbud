import { expect, it } from "vitest";
import {
  resolveV2NativeQualification,
  selectV2NativeQualification,
  validateV2NativeQualificationRegistry,
} from "./NativeCompatibility.qualification.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import { V2_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.ts";
import { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";

it.each(["2.0.0", "2.0.25", "2.0.26", "2.0.27", "2.0.28", "2.1.0", "2.999.999"])(
  "the empty production registry cannot claim completed semantic qualification for %s",
  (version) => {
    expect(() =>
      resolveV2NativeQualification(version, V2_COMPATIBILITY_DIGEST, "darwin", "arm64"),
    ).toThrow("Native qualification is required");
  },
);

it.each(V2_NATIVE_QUALIFICATION_SCOPES)(
  "a skipped/missing %s scope cannot promote a record",
  (scope) => {
    const missing = syntheticV2QualificationRecord();
    delete missing.scopes[scope];
    expect(() => validateV2NativeQualificationRegistry([missing], [])).toThrow();
    const skipped = syntheticV2QualificationRecord();
    skipped.scopes[scope] = "skipped";
    expect(() => validateV2NativeQualificationRegistry([skipped], [])).toThrow();
  },
);

it("synthetic selection is bound to release/platform/bootstrap; incompatibility wins over a synthetic pass", () => {
  const record = syntheticV2QualificationRecord(),
    registry = validateV2NativeQualificationRegistry([record], []);
  const selected = selectV2NativeQualification(
    registry,
    "2.0.28",
    V2_COMPATIBILITY_DIGEST,
    "darwin",
    "arm64",
  );
  expect(selected.record.suiteRevision).toBe("synthetic-not-native-qualification");
  expect(() =>
    selectV2NativeQualification(registry, "2.0.29", V2_COMPATIBILITY_DIGEST, "darwin", "arm64"),
  ).toThrow("qualification is required");
  expect(() =>
    selectV2NativeQualification(registry, "2.0.28", "a".repeat(64), "darwin", "arm64"),
  ).toThrow("selected bootstrap");
  expect(() =>
    selectV2NativeQualification(registry, "2.0.28", V2_COMPATIBILITY_DIGEST, "linux", "arm64"),
  ).toThrow("qualification is required");
  const incompatible = validateV2NativeQualificationRegistry(
    [record],
    [
      {
        format: "bigbud.thread.native-incompatible.v1",
        nativeVersion: record.nativeVersion,
        platform: record.platform,
        arch: record.arch,
        nativeContractDigest: record.nativeContractDigest,
        scope: "native-tool-schema-catalog-permissions",
        reason: "Synthetic semantic incompatibility",
        resultsDigest: record.resultsDigest,
      },
    ],
  );
  expect(() =>
    selectV2NativeQualification(incompatible, "2.0.28", V2_COMPATIBILITY_DIGEST, "darwin", "arm64"),
  ).toThrow("recorded an incompatibility");
});

it.each([
  "nativeContractDigest",
  "bootstrapGeneratorSourceDigest",
  "environmentEvidenceDigest",
  "sourceSnapshotDigest",
  "resultsDigest",
  "testedBinarySha256",
  "nativeSourceCommit",
  "clientVersion",
  "platform",
  "arch",
  "semanticProfile",
  "completedAt",
])("malformed %s and unknown/duplicate evidence fail closed", (field) => {
  expect(() =>
    validateV2NativeQualificationRegistry(
      [{ ...syntheticV2QualificationRecord(), [field]: "invalid" }],
      [],
    ),
  ).toThrow();
});

it("duplicate, conflicting and unknown authoritative fields do not silently select a winner", () => {
  const record = syntheticV2QualificationRecord();
  expect(() => validateV2NativeQualificationRegistry([record, record], [])).toThrow("conflicts");
  expect(() =>
    validateV2NativeQualificationRegistry([{ ...record, qualified: true }], []),
  ).toThrow();
});
