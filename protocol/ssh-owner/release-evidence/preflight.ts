import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { machine, release } from "node:os";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const profiles = {
  D: ["desktopInstallSigningAndRelaunch"],
  "V-E": ["electronBackendEntryAndTerminalAdapter"],
  "V-B": ["bunBackendEntryAndTerminalAdapter"],
  N: ["cleanNodeInstallAndCliDelegation"],
  R: ["verifiedGraphAccountAndRoleAdmission"],
} as const;
type Profile = keyof typeof profiles;

const commonTraceFields = [
  "artifactSignatureOrManifestVerification",
  "targetOsArchAbiAndProductRuntime",
  "productResolvedOpenSshImageAndVersion",
  "openSshDefaultConfigCompatibility",
  "ownerHelperLookupIdentityAndVerification",
  "processAncestryProtocolEpochDbDomainAndStartOrAttach",
  "missingTamperedWrongArchAndIncompatibleInputOutcomes",
  "operationResultLatencyAndApplicableLifecycle",
  "localWorkAndZeroFallbackSpawns",
] as const;

const releaseTargets = {
  D: ["darwin/arm64", "darwin/x64", "linux/x64", "win32/x64"],
  N: ["darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64", "win32/arm64", "win32/x64"],
  R: ["linux/arm64", "linux/x64"],
} satisfies Partial<Record<Profile, readonly string[]>>;

const usage =
  "Usage: bun run preflight.ts --artifact <file> --case-json '<JSON>' [--probe-local-ssh]";

function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`${label} has an unexpected field`);
  }
  return record;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new Error(`${label} must be nonempty single-line text`);
  }
  return value.trim();
}

function target(record: Record<string, unknown>, label: string) {
  const os = text(record.os, `${label}.os`);
  const arch = text(record.arch, `${label}.arch`);
  if (!/^[a-z][a-z0-9]*$/.test(os) || !/^[a-z][a-z0-9]*$/.test(arch)) {
    throw new Error(`${label} needs canonical OS/arch names (e.g. darwin/arm64, win32/x64)`);
  }
  return { os, arch };
}

function sshVersion(value: unknown): string {
  const line = text(value, "openSsh.version");
  if (!/^OpenSSH_(?:for_Windows_)?\d+\.\d+(?:p\d+)?(?:[,\s]|$)/.test(line)) {
    throw new Error("openSsh.version must be an OpenSSH version line");
  }
  return line;
}

function measuredPreflight(value: unknown) {
  const record = object(value, "preflight", ["os", "arch", "osVersion", "openSsh"]);
  const platform = target(record, "preflight");
  const ssh = object(record.openSsh, "preflight.openSsh", ["image", "version"]);
  const image = text(ssh.image, "openSsh.image");
  if (!(platform.os === "win32" ? /^[a-z]:[\\/]/i.test(image) : posix.isAbsolute(image))) {
    throw new Error("openSsh.image must be a fully qualified path on the measured OS");
  }
  return {
    ...platform,
    osVersion: text(record.osVersion, "preflight.osVersion"),
    openSsh: { image, version: sshVersion(ssh.version) },
    source: "caller-reported" as const,
  };
}

function localTarget() {
  const hardware = machine();
  const arch = hardware === "x86_64" ? "x64" : hardware === "aarch64" ? "arm64" : hardware;
  return { os: process.platform, arch };
}

async function probeLocalPreflight(platform: { os: string; arch: string }) {
  if (platform.os !== "darwin") {
    throw new Error("Local SSH probing is macOS-only; provide measured preflight metadata instead");
  }
  // Do not allow PATH, caller input, environment hooks, or artifact paths to select a process.
  const image = "/usr/bin/ssh";
  const info = await lstat(image);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error("Local system SSH is not a root-owned, non-group/world-writable regular file");
  }
  const result = spawnSync(image, ["-V"], {
    cwd: "/",
    env: { LC_ALL: "C" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000,
    maxBuffer: 4_096,
  });
  if (result.error || result.status !== 0) throw new Error("Local system ssh -V failed");
  return {
    ...platform,
    osVersion: `Darwin kernel ${release()}`,
    openSsh: { image, version: sshVersion((result.stderr || result.stdout).trim()) },
    source: "local-system-version-only" as const,
  };
}

function parseArguments(args: readonly string[]) {
  let artifact: string | undefined;
  let caseJson: string | undefined;
  let probeLocal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--artifact" && artifact === undefined) artifact = args[++i];
    else if (arg === "--case-json" && caseJson === undefined) caseJson = args[++i];
    else if (arg === "--probe-local-ssh" && !probeLocal) probeLocal = true;
    else throw new Error(usage);
  }
  if (!artifact || !caseJson) throw new Error(usage);
  return { artifact, caseJson, probeLocal };
}

function parseCase(json: string) {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    throw new Error("--case-json must contain valid JSON");
  }
  const record = object(value, "case", [
    "caseId",
    "profile",
    "scenario",
    "artifactId",
    "expectedSha256",
    "target",
    "preflight",
    "trace",
  ]);
  const profile = text(record.profile, "case.profile") as Profile;
  if (!Object.hasOwn(profiles, profile))
    throw new Error("case.profile must be D, V-E, V-B, N, or R");
  const caseTarget = target(object(record.target, "target", ["os", "arch"]), "target");
  if (profile === "D" || profile === "N" || profile === "R") {
    const candidates: readonly string[] = releaseTargets[profile];
    if (!candidates.includes(`${caseTarget.os}/${caseTarget.arch}`)) {
      throw new Error("case.target is outside this profile's documented artifact matrix");
    }
  }
  const expectedSha256 =
    record.expectedSha256 === undefined
      ? undefined
      : text(record.expectedSha256, "case.expectedSha256").toLowerCase();
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("case.expectedSha256 must be a 64-digit SHA-256 hex digest");
  }
  const fields = [...commonTraceFields, ...profiles[profile]];
  const refs = record.trace === undefined ? {} : object(record.trace, "trace", fields);
  const traceReferences = Object.fromEntries(
    Object.entries(refs).map(([key, ref]) => [key, text(ref, `trace.${key}`)]),
  );
  return {
    caseMetadata: {
      caseId: text(record.caseId, "case.caseId"),
      profile,
      scenario: text(record.scenario, "case.scenario"),
      artifactId: text(record.artifactId, "case.artifactId"),
      target: caseTarget,
    },
    expectedSha256,
    reportedPreflight: record.preflight,
    traceReferences,
    missingTraceFields: fields.filter((field) => !Object.hasOwn(traceReferences, field)),
  };
}

async function fingerprint(input: string, expectedSha256: string | undefined) {
  const path = resolve(input);
  const initial = await lstat(path, { bigint: true });
  if (!initial.isFile())
    throw new Error("Artifact must be a regular file, not a symlink or special file");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino) {
      throw new Error("Artifact changed before it could be read");
    }
    const sizeBytes = Number(before.size);
    if (sizeBytes === 0 || !Number.isSafeInteger(sizeBytes))
      throw new Error("Invalid artifact size");
    const hash = createHash("sha256");
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ end: sizeBytes - 1, autoClose: false })) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      bytesRead += bytes.length;
    }
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead !== sizeBytes ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("Artifact changed while hashing");
    }
    const sha256 = hash.digest("hex");
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new Error("Artifact SHA-256 does not match case.expectedSha256");
    }
    return {
      path,
      sizeBytes,
      sha256,
      expectedSha256Matched: expectedSha256 === undefined ? null : true,
    };
  } finally {
    await handle.close();
  }
}

export async function preflight(args: readonly string[]) {
  const { artifact, caseJson, probeLocal } = parseArguments(args);
  const { caseMetadata, expectedSha256, reportedPreflight, traceReferences, missingTraceFields } =
    parseCase(caseJson);
  if (probeLocal && reportedPreflight !== undefined) {
    throw new Error("Use either caller-reported preflight metadata or --probe-local-ssh, not both");
  }
  const reported = probeLocal ? undefined : measuredPreflight(reportedPreflight);
  const platform = reported ?? localTarget();
  if (platform.os !== caseMetadata.target.os || platform.arch !== caseMetadata.target.arch) {
    throw new Error("Preflight OS/arch does not match case.target");
  }
  const artifactFingerprint = await fingerprint(artifact, expectedSha256);
  return {
    schemaVersion: 1,
    status: "preflight-only",
    case: caseMetadata,
    artifact: artifactFingerprint,
    preflight: reported ?? (await probeLocalPreflight(platform)),
    traceReferences,
    missingTraceFields,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
  } else {
    try {
      console.log(JSON.stringify(await preflight(process.argv.slice(2)), null, 2));
    } catch (error) {
      console.error(
        `Preflight failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      process.exitCode = 1;
    }
  }
}
