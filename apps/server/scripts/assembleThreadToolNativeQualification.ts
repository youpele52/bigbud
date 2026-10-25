import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  v2QualificationApproval,
  v2QualificationEnvironmentEvidence,
  v2QualificationEvidencePacket,
  v2QualificationExpectedEnv,
  v2QualificationProvisioningRecord,
  sha256Hex,
} from "../src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.assemble.ts";
import {
  V2_NATIVE_QUALIFICATION_SUITE,
  V2_NATIVE_QUALIFICATION_TARGET as TARGET,
} from "../src/provider/Layers/OpencodeV2/NativeCompatibility.qualification.suite.ts";
import { V2_NATIVE_QUALIFICATION_SCOPES } from "../src/provider/Layers/OpencodeV2/NativeCompatibility.types.ts";
import { V2_NATIVE_ISOLATION_APPROVALS } from "../src/provider/Layers/OpencodeV2/SharedService.native.isolation.approvals.ts";

// Offline tooling for the macos-arm64-qualification job and the promotion runbook. It reads runner
// artifacts and the checked-out tree; it never launches OpenCode or edits any registry/approval file.
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
};
const run = (file: string, args: string[]) =>
  execFileSync(file, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const writeJson = (file: string, value: unknown) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });

/** SHA-256 over the full tracked tree manifest of HEAD (mode, type, object, path). */
const sourceSnapshotDigest = () => sha256Hex(run("git", ["ls-tree", "-r", "--full-tree", "HEAD"]));
const egressProfileSha256 = async () =>
  sha256Hex(await readFile(path.join(repoRoot, TARGET.egressProfile)));
const environment = async () =>
  v2QualificationEnvironmentEvidence(process.env, {
    egressProfileSha256: await egressProfileSha256(),
    bun: run("bun", ["--version"]),
    node: run("node", ["--version"]),
  });
const provisioning = async () =>
  v2QualificationProvisioningRecord({
    imageOS: process.env.ImageOS ?? "",
    imageVersion: process.env.ImageVersion ?? "",
    productVersion: run("sw_vers", ["-productVersion"]),
    buildVersion: run("sw_vers", ["-buildVersion"]),
    xcode: run("xcodebuild", ["-version"]).split("\n")[0] ?? "",
    machine: run("uname", ["-m"]),
    egressProfileSha256: await egressProfileSha256(),
  });
const committedApproval = () =>
  V2_NATIVE_ISOLATION_APPROVALS.find((approval) => approval.id === TARGET.approvalId);

switch (command) {
  case "mode":
    console.log(committedApproval() ? "qualify" : "provision");
    break;
  case "scopes":
    console.log(V2_NATIVE_QUALIFICATION_SCOPES.join("\n"));
    break;
  case "files": {
    const scope = rest[0] as (typeof V2_NATIVE_QUALIFICATION_SCOPES)[number];
    if (!V2_NATIVE_QUALIFICATION_SUITE[scope]) throw new Error(`Unknown scope ${rest[0]}.`);
    console.log(V2_NATIVE_QUALIFICATION_SUITE[scope].join(" "));
    break;
  }
  case "snapshot":
    console.log(sourceSnapshotDigest());
    break;
  case "env":
    // GITHUB_ENV lines; the snapshot digest pins the exact checked-out tree.
    for (const [key, value] of Object.entries(v2QualificationExpectedEnv(sourceSnapshotDigest())))
      console.log(`${key}=${value}`);
    break;
  case "provision": {
    // First pass on a fresh runner: everything needed to commit the approval record, no launch.
    const out = rest[0];
    if (!out) throw new Error("Usage: provision <output directory>");
    await mkdir(out, { recursive: true });
    const fixture = JSON.parse(
      await readFile(path.join(TARGET.fixtureRoot, "fixture", "fixture.json"), "utf8"),
    ) as { binaryPath: string; binarySha256: string; integrity: string; url: string };
    if (
      fixture.binaryPath !== TARGET.executablePath ||
      fixture.integrity !== TARGET.npmIntegrity ||
      fixture.url !== TARGET.npmTarball
    )
      throw new Error("Fixture provenance differs from the prepared target.");
    const env = await environment(),
      image = await provisioning();
    const approval = v2QualificationApproval({
      imageDigest: image.digest,
      environmentEvidenceDigest: env.digest,
      executableSha256: fixture.binarySha256,
    });
    await writeFile(path.join(out, "runner-provisioning.json"), image.bytes);
    await writeJson(path.join(out, "environment-evidence.json"), env.evidence);
    await writeJson(path.join(out, "approval.json"), approval);
    console.log(
      JSON.stringify({ imageDigest: image.digest, environmentEvidenceDigest: env.digest }),
    );
    break;
  }
  case "verify": {
    // Second pass: the committed approval must describe this exact image and environment.
    const approval = committedApproval();
    if (!approval) throw new Error("No committed approval for the qualification target.");
    const env = await environment(),
      image = await provisioning();
    if (approval.imageDigest !== image.digest)
      throw new Error("Runner image changed since provisioning; re-provision (never relabel).");
    if (approval.environmentEvidenceDigest !== env.digest)
      throw new Error("Qualification environment changed since provisioning.");
    console.log(
      JSON.stringify({ imageDigest: image.digest, environmentEvidenceDigest: env.digest }),
    );
    break;
  }
  case "summary": {
    // Written by the job after all scopes: identities the evidence packet must agree on.
    const [out, before, after] = rest;
    if (!out || !/^[a-f0-9]{64}$/.test(before ?? "") || !/^[a-f0-9]{64}$/.test(after ?? ""))
      throw new Error("Usage: summary <output file> <binary sha256 before> <binary sha256 after>");
    const check = JSON.parse(
      run("bun", ["apps/server/scripts/checkThreadToolNativeQualifications.ts", "--check"]),
    ) as { generatorSourceDigest: string };
    await writeJson(out, {
      binaryBefore: before,
      binaryAfter: after,
      sourceSnapshotDigest: sourceSnapshotDigest(),
      environmentEvidenceDigest: (await environment()).digest,
      generatorSourceDigest: check.generatorSourceDigest,
      completedAt: new Date().toISOString(),
    });
    break;
  }
  case "evidence": {
    // Assemble from downloaded job artifacts; reviews come only from three top-level sessions.
    const artifacts = rest[0];
    if (!artifacts) throw new Error("Usage: evidence <artifacts> [--reviews file] [--out file]");
    const read = (name: string) => readFile(path.join(artifacts, name), "utf8");
    const reports = Object.fromEntries(
      await Promise.all(
        V2_NATIVE_QUALIFICATION_SCOPES.map(async (scope) => [
          scope,
          await read(`scope-${scope}.json`),
        ]),
      ),
    );
    const summary = JSON.parse(await read("qualification-summary.json")) as {
      binaryBefore: string;
      binaryAfter: string;
      sourceSnapshotDigest: string;
      environmentEvidenceDigest: string;
      generatorSourceDigest: string;
      completedAt: string;
    };
    const reviewsFile = flag("--reviews");
    const packet = v2QualificationEvidencePacket({
      reports: reports as Parameters<typeof v2QualificationEvidencePacket>[0]["reports"],
      binaryBefore: summary.binaryBefore,
      binaryAfter: summary.binaryAfter,
      sourceSnapshotDigest: summary.sourceSnapshotDigest,
      environmentEvidenceDigest: summary.environmentEvidenceDigest,
      bootstrapGeneratorSourceDigest: summary.generatorSourceDigest,
      completedAt: summary.completedAt,
      ...(reviewsFile ? { reviews: JSON.parse(await readFile(reviewsFile, "utf8")) } : {}),
    });
    const out =
      flag("--out") ??
      path.join(
        repoRoot,
        `docs/validation/opencode-v2-native-qualification-${TARGET.nativeVersion}-evidence.json`,
      );
    await writeJson(out, packet);
    console.log(reviewsFile ? `Evidence packet written: ${out}` : `Unreviewed packet: ${out}`);
    break;
  }
  default:
    throw new Error(
      "Usage: assembleThreadToolNativeQualification.ts <mode|scopes|files|snapshot|env|provision|verify|summary|evidence>",
    );
}
