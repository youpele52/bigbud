import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { closeOwnedChild } from "./ServerManager.child.ts";
import { V2_NATIVE_ISOLATION_APPROVALS } from "./SharedService.native.isolation.approvals.ts";

export interface V2NativeIsolationApproval {
  readonly id: string;
  readonly machineId: string;
  readonly imageDigest: string;
  readonly environmentEvidenceDigest: string;
  readonly fixtureRoot: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly nativeVersion: string;
  readonly platform: "darwin";
  readonly arch: "arm64";
  readonly controlledPath: string;
  readonly cleanSystemAndManagedPolicy: true;
  readonly noHostMountsAccountsOrKeychain: true;
  readonly loopbackOnlyEgress: true;
}

const hex = /^[a-f0-9]{64}$/;
const inside = (root: string, candidate: string) =>
  candidate.startsWith(`${root}${path.sep}`) && path.resolve(candidate) === candidate;

/** Validate evidence structure without treating its assertions as machine attestation. */
export function validateV2NativeIsolationApproval(value: V2NativeIsolationApproval) {
  if (
    Object.keys(value).length !== 14 ||
    !/^[a-z0-9-]{1,100}$/.test(value.id) ||
    !/^[a-z0-9-]{1,100}$/.test(value.machineId) ||
    ![value.imageDigest, value.environmentEvidenceDigest, value.executableSha256].every((v) =>
      hex.test(v),
    ) ||
    !/^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.nativeVersion) ||
    value.platform !== "darwin" ||
    value.arch !== "arm64" ||
    !path.isAbsolute(value.fixtureRoot) ||
    path.resolve(value.fixtureRoot) !== value.fixtureRoot ||
    value.fixtureRoot === "/" ||
    !inside(value.fixtureRoot, value.executablePath) ||
    !value.controlledPath ||
    value.controlledPath.length > 4096 ||
    value.controlledPath.split(path.delimiter).some((p) => !path.isAbsolute(p)) ||
    value.cleanSystemAndManagedPolicy !== true ||
    value.noHostMountsAccountsOrKeychain !== true ||
    value.loopbackOnlyEgress !== true
  )
    throw new Error(
      "V2 native isolation provenance is incomplete; no retail executable may launch.",
    );
}

/** Refuse before even inspecting an executable when there is no independently approved machine. */
export async function requireV2NativeIsolation(
  binary: string,
  approvalId = process.env.BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID,
) {
  const approval = V2_NATIVE_ISOLATION_APPROVALS.find((entry) => entry.id === approvalId);
  if (!approval)
    throw new Error(
      "V2 native qualification requires an approved clean macOS ARM64 environment before any retail launch (including --version); HOME/XDG alone is not isolation.",
    );
  validateV2NativeIsolationApproval(approval);
  if (
    process.platform !== approval.platform ||
    process.arch !== approval.arch ||
    process.env.BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID !== approval.machineId ||
    (process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION !== undefined &&
      process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION !== approval.nativeVersion) ||
    binary !== approval.executablePath
  )
    throw new Error("V2 native qualification machine/image identity changed; launch refused.");
  await verifyV2NativeFixtureImage(approval);
  return approval;
}

/** Version execution itself requires the same approval/image gate as serving, never private HOME alone. */
export async function assertV2NativeFixtureVersion(
  approval: V2NativeIsolationApproval,
  env: NodeJS.ProcessEnv,
  profile: string,
) {
  const approved = await requireV2NativeIsolation(approval.executablePath, approval.id);
  const child = spawn(approval.executablePath, ["--version"], {
    cwd: profile,
    env: v2NativeFixtureEnvironment(approved, profile, profile, env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  try {
    const version = await runWithAbortableDeadline({
      operation: "V2 approved retail version",
      timeoutMs: 5000,
      run: () =>
        new Promise<string>((resolve, reject) => {
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            if (Buffer.byteLength(output) + chunk.length > 1024)
              reject(new Error("V2 retail version output bound."));
            else output += chunk.toString("utf8");
          });
          child.once("error", () =>
            reject(new Error("V2 approved retail version could not start.")),
          );
          child.once("exit", (code) =>
            code === 0
              ? resolve(output.trim())
              : reject(new Error("V2 approved retail version exited unsuccessfully.")),
          );
        }),
    });
    if (version !== approval.nativeVersion)
      throw new Error(
        "V2 retail version differs from the frozen approved image; candidate was not relabeled.",
      );
    await verifyV2NativeFixtureImage(approval);
  } finally {
    await closeOwnedChild(child);
  }
}

/** Owned immutable retail bytes only; source/tag association is recorded separately. */
export async function verifyV2NativeFixtureImage(approval: V2NativeIsolationApproval) {
  const file = await lstat(approval.executablePath);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    (process.getuid && file.uid !== process.getuid()) ||
    file.nlink !== 1 ||
    (file.mode & 0o222) !== 0 ||
    (await realpath(approval.executablePath)) !== approval.executablePath ||
    createHash("sha256")
      .update(await readFile(approval.executablePath))
      .digest("hex") !== approval.executableSha256
  )
    throw new Error(
      "V2 native qualification retail image bytes/ownership changed; launch refused.",
    );
}

/** Replace inherited PATH/temp locations; approval is prerequisite, not a native isolation switch. */
export function v2NativeFixtureEnvironment(
  approval: V2NativeIsolationApproval,
  profile: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!inside(approval.fixtureRoot, profile) || !inside(approval.fixtureRoot, workspace))
    throw new Error("V2 native fixture escaped the approved disposable machine root.");
  const databases = path.join(profile, "data", "opencode"),
    database = env.OPENCODE_DB ?? path.join(databases, "opencode.db");
  if (path.dirname(database) !== databases || path.resolve(database) !== database)
    throw new Error("V2 native fixture database escaped its approved owned profile.");
  // Scope-derived values replace inherited/caller-provided credential/config roots entirely.
  return {
    HOME: profile,
    USERPROFILE: profile,
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    XDG_STATE_HOME: path.join(profile, "state"),
    OPENCODE_CONFIG_DIR: path.join(profile, "config", "opencode"),
    OPENCODE_DB: database,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    PATH: approval.controlledPath,
    TMPDIR: profile,
    TMP: profile,
    TEMP: profile,
  };
}
