import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preflight } from "./preflight.ts";

const bytes = Buffer.from("#!/bin/sh\nexit 73\n");
const digest = createHash("sha256").update(bytes).digest("hex");
const windows = { os: "win32", arch: "x64" };
const metadata = {
  caseId: "F02-win10-login-password",
  profile: "D",
  scenario: "Windows 10 22H2 login password baseline",
  artifactId: "fixture-only",
  target: windows,
  preflight: {
    ...windows,
    osVersion: "Windows 10 22H2",
    openSsh: {
      image: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      version: "OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2",
    },
  },
};

let directory: string;
let artifact: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ssh-owner-preflight-"));
  artifact = join(directory, "untrusted artifact.sh");
  await writeFile(artifact, bytes, { mode: 0o700 });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function args(input: object = metadata, path = artifact) {
  return ["--artifact", path, "--case-json", JSON.stringify(input)];
}

describe("offline SSH release preflight", () => {
  it("hashes only the supplied bytes and separates reported host metadata from product traces", async () => {
    const result = await preflight(args({ ...metadata, expectedSha256: digest.toUpperCase() }));
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "preflight-only",
      case: { caseId: metadata.caseId, target: windows },
      artifact: {
        path: artifact,
        sha256: digest,
        sizeBytes: bytes.length,
        expectedSha256Matched: true,
      },
      preflight: { ...metadata.preflight, source: "caller-reported" },
      traceReferences: {},
    });
    expect(result.missingTraceFields).toContain("productResolvedOpenSshImageAndVersion");
    expect(result.missingTraceFields).toContain("desktopInstallSigningAndRelaunch");
    expect(await readFile(artifact)).toEqual(bytes);
  });

  it.each([
    ["V-E", "electronBackendEntryAndTerminalAdapter"],
    ["V-B", "bunBackendEntryAndTerminalAdapter"],
    ["N", "cleanNodeInstallAndCliDelegation"],
    ["R", "verifiedGraphAccountAndRoleAdmission"],
  ])("reports the %s trace requirement", async (profile, field) => {
    const target = { os: "linux", arch: "arm64" };
    const result = await preflight(
      args({
        ...metadata,
        profile,
        target,
        preflight: {
          ...target,
          osVersion: "Debian 12",
          openSsh: { image: "/usr/bin/ssh", version: "OpenSSH_9.2p1 Debian-2" },
        },
      }),
    );
    expect(result.missingTraceFields).toContain(field);
  });

  it("keeps even a complete reference list preflight-only and never opens references", async () => {
    const baseline = await preflight(args());
    const trace = Object.fromEntries(
      baseline.missingTraceFields.map((field) => [field, `nonexistent.json#${field}`]),
    );
    const result = await preflight(args({ ...metadata, trace }));
    expect(result.missingTraceFields).toEqual([]);
    expect(result.traceReferences).toEqual(trace);
    expect(result.artifact.expectedSha256Matched).toBeNull();
    expect(result.status).toBe("preflight-only");
  });

  it("rejects missing, nonregular and digest-mismatched artifacts", async () => {
    await expect(preflight(args(metadata, join(directory, "missing")))).rejects.toThrow(/ENOENT/);
    await expect(preflight(args(metadata, directory))).rejects.toThrow(/regular file/);
    await expect(preflight(args({ ...metadata, expectedSha256: "0".repeat(64) }))).rejects.toThrow(
      /does not match/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects an artifact symlink without following it",
    async () => {
      const link = join(directory, "artifact-link");
      await symlink(artifact, link);
      await expect(preflight(args(metadata, link))).rejects.toThrow(/not a symlink/);
    },
  );

  it.each([
    [{ caseId: " " }, /caseId/],
    [{ profile: "V" }, /case.profile/],
    [{ profile: "R" }, /artifact matrix/],
    [{ expectedSha256: "abc" }, /64-digit/],
    [{ preflight: undefined }, /preflight must be an object/],
    [{ preflight: { ...metadata.preflight, arch: "arm64" } }, /does not match case.target/],
    [
      {
        preflight: {
          ...metadata.preflight,
          os: "linux",
          openSsh: { image: "/usr/bin/ssh", version: "OpenSSH_9.2" },
        },
      },
      /does not match case.target/,
    ],
    [
      { preflight: { ...metadata.preflight, openSsh: { image: "ssh", version: "OpenSSH_8.1" } } },
      /fully qualified/,
    ],
    [
      {
        preflight: {
          ...metadata.preflight,
          openSsh: { ...metadata.preflight.openSsh, version: "Dropbear" },
        },
      },
      /OpenSSH version line/,
    ],
    [{ trace: { desktopInstallSigningAndRelaunch: true } }, /nonempty single-line/],
    [{ trace: { desktopInstallSigningAndRelaunch: "   " } }, /nonempty single-line/],
    [{ trace: { qualified: "yes" } }, /unexpected field/],
  ])("rejects invalid case data %j", async (input, error) => {
    await expect(preflight(args({ ...metadata, ...input }))).rejects.toThrow(error);
  });

  it("requires exactly one metadata source and refuses unknown CLI flags", async () => {
    await expect(preflight([...args(), "--probe-local-ssh"])).rejects.toThrow(/not both/);
    await expect(preflight([...args(), "--ssh-path", artifact])).rejects.toThrow(/Usage/);
    await expect(preflight([])).rejects.toThrow(/Usage/);
    await expect(preflight(["--artifact", artifact, "--case-json", "{"])).rejects.toThrow(
      /valid JSON/,
    );
  });
});
