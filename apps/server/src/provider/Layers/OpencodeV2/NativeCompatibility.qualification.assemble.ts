import { createHash } from "node:crypto";
import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import { V2_NATIVE_CONTRACT_DIGEST } from "./NativeCompatibility.contract.ts";
import { v2NativeQualificationResultsDigest } from "./NativeCompatibility.evidence.ts";
import {
  V2_NATIVE_QUALIFICATION_SUITE,
  V2_NATIVE_QUALIFICATION_SUITE_REVISION,
  V2_NATIVE_QUALIFICATION_TARGET as TARGET,
} from "./NativeCompatibility.qualification.suite.ts";
import { V2_NATIVE_QUALIFICATION_SCOPES } from "./NativeCompatibility.types.ts";
import { V2_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.ts";
import type { V2NativeIsolationApproval } from "./SharedService.native.isolation.fixture.ts";

/** Pure assembly of runner artifacts into an approval record and evidence packet. It never runs a
 * native executable and cannot change the runtime registry; promotion stays a reviewed paste. */
type Scope = (typeof V2_NATIVE_QUALIFICATION_SCOPES)[number];
export const sha256Hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Sorted-key JSON so digests do not depend on construction order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .toSorted()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The exact environment every scope runs with (the snapshot digest is recorded separately). */
export function v2QualificationExpectedEnv(sourceSnapshotDigest?: string) {
  return {
    BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID: TARGET.approvalId,
    BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID: TARGET.machineId,
    BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY: TARGET.executablePath,
    BIGBUD_OPENCODE_V2_TEST_BINARY: TARGET.executablePath,
    BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION: TARGET.nativeVersion,
    BIGBUD_OPENCODE_V2_REQUIRED_NATIVE: "1",
    BIGBUD_OPENCODE_V2_CANDIDATE_SEMANTIC_PROFILE: TARGET.semanticProfile,
    TMPDIR: `${TARGET.fixtureRoot}/tmp`,
    ...(sourceSnapshotDigest
      ? { BIGBUD_OPENCODE_V2_CANDIDATE_SOURCE_SNAPSHOT_DIGEST: sourceSnapshotDigest }
      : {}),
  };
}

export function v2QualificationEnvironmentEvidence(
  env: Readonly<Record<string, string | undefined>>,
  tools: { readonly egressProfileSha256: string; readonly bun: string; readonly node: string },
) {
  const expected = v2QualificationExpectedEnv();
  for (const [key, value] of Object.entries(expected))
    if (env[key] !== value)
      throw new Error(`Qualification environment ${key} differs from target.`);
  const evidence = {
    format: "bigbud.thread.native-qualification.environment.v1",
    env: expected,
    ...tools,
  };
  return { evidence, digest: sha256Hex(canonicalJson(evidence)) };
}

/** Image identity of the hosted runner; committed as the provisioning record (imageDigest). */
export function v2QualificationProvisioningRecord(input: {
  readonly imageOS: string;
  readonly imageVersion: string;
  readonly productVersion: string;
  readonly buildVersion: string;
  readonly xcode: string;
  readonly machine: string;
  readonly egressProfileSha256: string;
}) {
  if (Object.values(input).some((value) => !value || value.length > 200))
    throw new Error("Runner provisioning evidence is incomplete.");
  const record = {
    format: "bigbud.thread.native-qualification.runner.v1",
    runnerLabel: TARGET.runnerLabel,
    ...input,
    egress: "seatbelt-loopback-only-v1",
  };
  const bytes = `${canonicalJson(record)}\n`;
  return { record, bytes, digest: sha256Hex(bytes) };
}

export function v2QualificationApproval(input: {
  readonly imageDigest: string;
  readonly environmentEvidenceDigest: string;
  readonly executableSha256: string;
}): V2NativeIsolationApproval {
  if (input.executableSha256 !== TARGET.executableSha256)
    throw new Error("Downloaded executable differs from the npm-verified preparation hash.");
  return {
    id: TARGET.approvalId,
    machineId: TARGET.machineId,
    imageDigest: input.imageDigest,
    environmentEvidenceDigest: input.environmentEvidenceDigest,
    fixtureRoot: TARGET.fixtureRoot,
    executablePath: TARGET.executablePath,
    executableSha256: input.executableSha256,
    nativeVersion: TARGET.nativeVersion,
    platform: "darwin",
    arch: "arm64",
    controlledPath: TARGET.controlledPath,
    cleanSystemAndManagedPolicy: true,
    noHostMountsAccountsOrKeychain: true,
    loopbackOnlyEgress: true,
  };
}

/** Report test-file names (absolute on the runner) as suite paths relative to apps/server. */
const suiteRelative = (name: string) => {
  const normalized = name.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/apps/server/");
  return index === -1 ? normalized : normalized.slice(index + "/apps/server/".length);
};

/** The report must have run exactly the frozen scope file set: no subset, no extra file. */
function assertV2QualificationScopeFiles(scope: Scope, parsed: Record<string, unknown>) {
  const results = Array.isArray(parsed.testResults) ? (parsed.testResults as unknown[]) : [];
  const ran = results.map((result) =>
    result && typeof result === "object" && typeof (result as { name?: unknown }).name === "string"
      ? suiteRelative((result as { name: string }).name)
      : "",
  );
  const expected = V2_NATIVE_QUALIFICATION_SUITE[scope];
  const missing = expected.filter((file) => !ran.includes(file));
  const extra = ran.filter((file) => !expected.includes(file));
  if (missing.length || extra.length || new Set(ran).size !== ran.length)
    throw new Error(
      `Qualification scope ${scope} did not run its exact file set (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"}; files=${ran.length}).`,
    );
}

/** One scope from a vitest JSON report: exactly the frozen file set, and every test must execute
 * and pass (skipped: 0). */
export function v2QualificationScopeResult(
  scope: Scope,
  report: string,
  context: {
    readonly testedBinarySha256: string;
    readonly sourceSnapshotDigest: string;
    readonly environmentEvidenceDigest: string;
  },
) {
  const parsed = JSON.parse(report) as Record<string, unknown>;
  const count = (key: string) => (Number.isSafeInteger(parsed[key]) ? (parsed[key] as number) : -1);
  const tests = count("numTotalTests"),
    failures = count("numFailedTests"),
    skipped = count("numPendingTests") + count("numTodoTests");
  if (parsed.success !== true || tests < 1 || failures !== 0 || skipped !== 0)
    throw new Error(
      `Qualification scope did not fully pass (tests=${tests}, failures=${failures}, skipped=${skipped}).`,
    );
  assertV2QualificationScopeFiles(scope, parsed);
  // Key order mirrors the evidence schema so the results digest is stable after decoding.
  return {
    status: "passed" as const,
    tests,
    failures: 0 as const,
    skipped: 0 as const,
    nativeVersion: TARGET.nativeVersion,
    testedBinarySha256: context.testedBinarySha256,
    sourceSnapshotDigest: context.sourceSnapshotDigest,
    environmentEvidenceDigest: context.environmentEvidenceDigest,
    outputDigest: sha256Hex(report),
  };
}

export interface V2QualificationReview {
  readonly status: "passed";
  readonly reviewer: string;
  readonly sourceSnapshotDigest: string;
}

/** Evidence packet for `thread-tools:native-qualification:prepare`; reviews are never synthesized. */
export function v2QualificationEvidencePacket(input: {
  readonly reports: Readonly<Record<Scope, string>>;
  readonly binaryBefore: string;
  readonly binaryAfter: string;
  readonly sourceSnapshotDigest: string;
  readonly environmentEvidenceDigest: string;
  readonly bootstrapGeneratorSourceDigest: string;
  readonly completedAt: string;
  readonly reviews?: {
    readonly code: V2QualificationReview;
    readonly security: V2QualificationReview;
    readonly requirements: V2QualificationReview;
  };
}) {
  const context = {
    testedBinarySha256: input.binaryBefore,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    environmentEvidenceDigest: input.environmentEvidenceDigest,
  };
  const results = Object.fromEntries(
    V2_NATIVE_QUALIFICATION_SCOPES.map((scope) => [
      scope,
      v2QualificationScopeResult(scope, input.reports[scope], context),
    ]),
  ) as Record<Scope, ReturnType<typeof v2QualificationScopeResult>>;
  const record = {
    format: "bigbud.thread.native-qualification.v1",
    nativeVersion: TARGET.nativeVersion,
    platform: TARGET.platform,
    arch: TARGET.arch,
    clientVersion: OPENCODE_V2_CLIENT_VERSION,
    nativeContractDigest: V2_NATIVE_CONTRACT_DIGEST,
    bootstrapContractDigests: [V2_COMPATIBILITY_DIGEST],
    bootstrapGeneratorSourceDigest: input.bootstrapGeneratorSourceDigest,
    semanticProfile: TARGET.semanticProfile,
    suiteRevision: V2_NATIVE_QUALIFICATION_SUITE_REVISION,
    sourceSnapshotDigest: input.sourceSnapshotDigest,
    testedBinarySha256: input.binaryBefore,
    nativeSourceCommit: TARGET.nativeSourceCommit,
    environmentEvidenceDigest: input.environmentEvidenceDigest,
    resultsDigest: v2NativeQualificationResultsDigest(results),
    completedAt: input.completedAt,
    scopes: Object.fromEntries(V2_NATIVE_QUALIFICATION_SCOPES.map((scope) => [scope, "passed"])),
  };
  return {
    format: "bigbud.thread.native-qualification.evidence.v1",
    record,
    binaryBefore: input.binaryBefore,
    binaryAfter: input.binaryAfter,
    ...(input.reviews ? { reviews: input.reviews } : {}),
    results,
  };
}
