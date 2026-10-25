import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prepareV2NativeQualificationRecord } from "./NativeCompatibility.evidence.ts";
import {
  canonicalJson,
  v2QualificationApproval,
  v2QualificationEnvironmentEvidence,
  v2QualificationEvidencePacket,
  v2QualificationExpectedEnv,
  v2QualificationProvisioningRecord,
  v2QualificationScopeResult,
} from "./NativeCompatibility.qualification.assemble.ts";
import {
  V2_NATIVE_QUALIFICATION_EXCLUDED,
  V2_NATIVE_QUALIFICATION_SUITE,
  V2_NATIVE_QUALIFICATION_SUITE_REVISION,
  V2_NATIVE_QUALIFICATION_TARGET as TARGET,
} from "./NativeCompatibility.qualification.suite.ts";
import { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";
import { validateV2NativeIsolationApproval } from "./SharedService.native.isolation.fixture.ts";

const serverRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const hex = (c: string) => c.repeat(64);
type Scope = (typeof V2_NATIVE_QUALIFICATION_SCOPES)[number];
/** Vitest JSON reports name each test file by its absolute path on the runner. */
const runnerPath = (file: string) => `/Users/runner/work/bigbud/bigbud/apps/server/${file}`;
const report = (
  tests: number,
  pending = 0,
  failed = 0,
  files: readonly string[] = V2_NATIVE_QUALIFICATION_SUITE["packaged-ab"],
) =>
  JSON.stringify({
    numTotalTests: tests,
    numPassedTests: tests - pending - failed,
    numFailedTests: failed,
    numPendingTests: pending,
    numTodoTests: 0,
    success: failed === 0,
    testResults: files.map((file) => ({ name: runnerPath(file), status: "passed" })),
  });
const scopeReport = (scope: Scope, files = V2_NATIVE_QUALIFICATION_SUITE[scope]) =>
  report(3, 0, 0, files);
const reports = Object.fromEntries(
  V2_NATIVE_QUALIFICATION_SCOPES.map((s) => [s, scopeReport(s)]),
) as { [K in Scope]: string };

it("the frozen suite maps every scope to existing files exactly once", () => {
  expect(Object.keys(V2_NATIVE_QUALIFICATION_SUITE).toSorted()).toEqual(
    [...V2_NATIVE_QUALIFICATION_SCOPES].toSorted(),
  );
  for (const scope of V2_NATIVE_QUALIFICATION_SCOPES)
    expect(V2_NATIVE_QUALIFICATION_SUITE[scope].length, scope).toBeGreaterThan(0);
  const all = Object.values(V2_NATIVE_QUALIFICATION_SUITE).flat();
  expect(new Set(all).size).toBe(all.length);
  for (const file of all) expect(existsSync(path.join(serverRoot, file)), file).toBe(true);
  for (const file of Object.keys(V2_NATIVE_QUALIFICATION_EXCLUDED)) {
    expect(all).not.toContain(file);
    // Only the public-network smoke survives; retired-path exclusions were deleted in Phase 4.1.
    expect(existsSync(path.join(serverRoot, file)), file).toBe(
      file.endsWith("/Catalog.native.test.ts"),
    );
  }
  expect(V2_NATIVE_QUALIFICATION_SUITE_REVISION).toBe("opencode-v2-native-qualification-suite.v2");
});

it("every native suite file runs on the shared production path, never the private launcher", async () => {
  const native = Object.values(V2_NATIVE_QUALIFICATION_SUITE)
    .flat()
    .filter((file) => file.endsWith(".native.test.ts"));
  expect(native.length).toBeGreaterThan(0);
  for (const file of native) {
    const source = await readFile(path.join(serverRoot, file), "utf8");
    expect(source, file).toContain("BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY");
    expect(source, file).not.toMatch(
      /ServerManager\.fixture|Application\.fixture\.ts|startOwnedV2Process|makeV2CodingNativeFixture|BIGBUD_OPENCODE_V2_TEST_BINARY|PUBLIC_CATALOG_SMOKE/,
    );
  }
});

it("assembles a packet the promotion validator accepts only with three distinct reviews", () => {
  const input = {
    reports,
    binaryBefore: TARGET.executableSha256,
    binaryAfter: TARGET.executableSha256,
    sourceSnapshotDigest: hex("1"),
    environmentEvidenceDigest: hex("2"),
    bootstrapGeneratorSourceDigest: hex("3"),
    completedAt: "2026-10-16T00:00:00.000Z",
  };
  expect(() => prepareV2NativeQualificationRecord(v2QualificationEvidencePacket(input))).toThrow();
  const review = (reviewer: string) =>
    ({ status: "passed", reviewer, sourceSnapshotDigest: hex("1") }) as const;
  const reviews = {
    code: review("ses_a"),
    security: review("ses_b"),
    requirements: review("ses_c"),
  };
  const record = prepareV2NativeQualificationRecord(
    JSON.parse(JSON.stringify(v2QualificationEvidencePacket({ ...input, reviews }))),
  );
  expect(record).toMatchObject({
    nativeVersion: TARGET.nativeVersion,
    platform: "darwin",
    arch: "arm64",
    suiteRevision: V2_NATIVE_QUALIFICATION_SUITE_REVISION,
    nativeSourceCommit: TARGET.nativeSourceCommit,
    semanticProfile: "v2-system-global-config-v1",
    testedBinarySha256: TARGET.executableSha256,
  });
  const same = { ...reviews, requirements: review("ses_a") };
  expect(() =>
    prepareV2NativeQualificationRecord(v2QualificationEvidencePacket({ ...input, reviews: same })),
  ).toThrow("review identity");
  expect(() =>
    v2QualificationEvidencePacket({
      ...input,
      reports: { ...reports, "packaged-ab": report(3, 1) },
    }),
  ).toThrow("skipped=1");
  expect(() =>
    v2QualificationEvidencePacket({
      ...input,
      reports: { ...reports, "isolation-hooks": report(3, 0, 1) },
    }),
  ).toThrow("failures=1");
});

it("accepts a scope report only for exactly its frozen file set", () => {
  const scope = "api-transport-admission";
  const suite = V2_NATIVE_QUALIFICATION_SUITE[scope];
  const context = { testedBinarySha256: hex("1"), sourceSnapshotDigest: hex("2") };
  const result = (files: readonly string[]) =>
    v2QualificationScopeResult(scope, report(3, 0, 0, files), {
      ...context,
      environmentEvidenceDigest: hex("3"),
    });
  expect(result(suite).status).toBe("passed");
  // Relative names (a local run from apps/server) normalize to the same set.
  expect(
    v2QualificationScopeResult(
      scope,
      JSON.stringify({
        ...JSON.parse(scopeReport(scope)),
        testResults: suite.map((name) => ({ name })),
      }),
      { ...context, environmentEvidenceDigest: hex("3") },
    ).status,
  ).toBe("passed");
  expect(() => result(suite.slice(1))).toThrow(`missing: ${suite[0]}; unexpected: none`);
  const other = V2_NATIVE_QUALIFICATION_SUITE["packaged-ab"][0]!;
  expect(() => result([...suite, other])).toThrow(`missing: none; unexpected: ${other}`);
  expect(() => result([...suite, suite[0]!])).toThrow("did not run its exact file set");
  expect(() => result([])).toThrow(`Qualification scope ${scope} did not run its exact file set`);
  // A scope's report cannot stand in for another scope.
  expect(() =>
    v2QualificationEvidencePacket({
      reports: { ...reports, [scope]: scopeReport("isolation-hooks") },
      binaryBefore: TARGET.executableSha256,
      binaryAfter: TARGET.executableSha256,
      sourceSnapshotDigest: hex("1"),
      environmentEvidenceDigest: hex("2"),
      bootstrapGeneratorSourceDigest: hex("3"),
      completedAt: "2026-10-16T00:00:00.000Z",
    }),
  ).toThrow(`Qualification scope ${scope} did not run its exact file set`);
});

it("builds a structurally valid approval only for the npm-verified image", () => {
  const approval = v2QualificationApproval({
    imageDigest: hex("4"),
    environmentEvidenceDigest: hex("5"),
    executableSha256: TARGET.executableSha256,
  });
  expect(() => validateV2NativeIsolationApproval(approval)).not.toThrow();
  expect(approval.executablePath.startsWith(`${approval.fixtureRoot}/`)).toBe(true);
  expect(() =>
    v2QualificationApproval({
      imageDigest: hex("4"),
      environmentEvidenceDigest: hex("5"),
      executableSha256: hex("6"),
    }),
  ).toThrow("npm-verified");
});

it("environment and runner evidence are canonical and refuse drift", () => {
  const tools = { egressProfileSha256: hex("7"), bun: "1.3.14", node: "v24.0.0" };
  const env = v2QualificationExpectedEnv(hex("8"));
  expect(env.TMPDIR.startsWith(`${TARGET.fixtureRoot}/`)).toBe(true);
  const first = v2QualificationEnvironmentEvidence(env, tools);
  const reordered = Object.fromEntries(Object.entries(env).toReversed());
  expect(v2QualificationEnvironmentEvidence(reordered, tools).digest).toBe(first.digest);
  expect(first.evidence.env).not.toHaveProperty(
    "BIGBUD_OPENCODE_V2_CANDIDATE_SOURCE_SNAPSHOT_DIGEST",
  );
  expect(() =>
    v2QualificationEnvironmentEvidence(
      { ...env, BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID: undefined },
      tools,
    ),
  ).toThrow("NATIVE_MACHINE_ID");
  const runner = {
    imageOS: "macos15",
    imageVersion: "20261012.1",
    productVersion: "15.6",
    buildVersion: "24G84",
    xcode: "Xcode 16.4",
    machine: "arm64",
    egressProfileSha256: hex("7"),
  };
  const image = v2QualificationProvisioningRecord(runner);
  expect(image.bytes).toBe(`${canonicalJson(image.record)}\n`);
  expect(
    v2QualificationProvisioningRecord({ ...runner, imageVersion: "20261019.1" }).digest,
  ).not.toBe(image.digest);
  expect(() => v2QualificationProvisioningRecord({ ...runner, xcode: "" })).toThrow("incomplete");
});
