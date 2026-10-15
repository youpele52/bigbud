import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import {
  assertV2NativeFixtureVersion,
  requireV2NativeIsolation,
  type V2NativeIsolationApproval,
} from "./SharedService.native.isolation.fixture.ts";

const spawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Observed unauthorized retail spawn");
  }),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));
// Synthetic approvals only through the catalog seam; the real catalog is never edited by tests.
const catalog = vi.hoisted(() => ({ approvals: [] as unknown[] }));
vi.mock("./SharedService.native.isolation.approvals.ts", () => ({
  V2_NATIVE_ISOLATION_APPROVALS: catalog.approvals,
}));

async function syntheticApproval(root: string, executableBytes?: Buffer) {
  const executablePath = path.join(root, "fixture", "package", "bin", "opencode");
  if (executableBytes) {
    await mkdir(path.dirname(executablePath), { recursive: true });
    await writeFile(executablePath, executableBytes);
    await chmod(executablePath, 0o555);
  }
  return {
    id: "synthetic-inert-approval",
    machineId: "synthetic-approved-machine",
    imageDigest: "a".repeat(64),
    environmentEvidenceDigest: "b".repeat(64),
    fixtureRoot: root,
    executablePath,
    executableSha256: executableBytes
      ? createHash("sha256").update(executableBytes).digest("hex")
      : "c".repeat(64),
    nativeVersion: "2.0.29",
    platform: "darwin",
    arch: "arm64",
    controlledPath: "/usr/bin:/bin:/usr/sbin:/sbin",
    cleanSystemAndManagedPolicy: true,
    noHostMountsAccountsOrKeychain: true,
    loopbackOnlyEgress: true,
  } satisfies V2NativeIsolationApproval;
}

it.each(["private", "shared", "version-helper"] as const)(
  "%s fixture refuses before even retail --version without approved provenance",
  async (kind) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-retail-refusal-")));
    spawn.mockClear();
    try {
      const binary = path.join(root, "unapproved-retail-image");
      vi.stubEnv("BIGBUD_OPENCODE_V2_TEST_BINARY", binary);
      vi.stubEnv("BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY", binary);
      vi.stubEnv("BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID", "caller-asserted-not-approved");
      const result =
        kind === "private"
          ? startOwnedV2Process({
              binaryPath: binary,
              profileRoot: path.join(root, "profile"),
              runtimeTargetId: "local",
            })
          : kind === "shared"
            ? sharedServiceNativeFixture(binary)
            : assertV2NativeFixtureVersion(
                {
                  executablePath: binary,
                  id: "caller-asserted-not-approved",
                } as V2NativeIsolationApproval,
                process.env,
                root,
              );
      await expect(result).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["private", "shared", "approval-gate"] as const)(
  "a committed approval record stays inert (%s) when BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID is unset",
  async (kind) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-inert-approval-")));
    spawn.mockClear();
    const approval = await syntheticApproval(root);
    catalog.approvals.push(approval);
    try {
      vi.stubEnv("BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID", approval.id);
      vi.stubEnv("BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID", undefined);
      vi.stubEnv("BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION", approval.nativeVersion);
      const result =
        kind === "private"
          ? startOwnedV2Process({
              binaryPath: approval.executablePath,
              profileRoot: path.join(root, "profile"),
              runtimeTargetId: "local",
            })
          : kind === "shared"
            ? sharedServiceNativeFixture(approval.executablePath)
            : requireV2NativeIsolation(approval.executablePath, approval.id);
      // The executable does not exist: refusal happens at the machine-identity gate, before any read.
      await expect(result).rejects.toThrow("machine/image identity changed; launch refused");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      catalog.approvals.length = 0;
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "positive control: the same synthetic record admits its exact image only with the approved machine id",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-approval-control-")));
    const approval = await syntheticApproval(root, Buffer.from("synthetic retail image bytes"));
    catalog.approvals.push(approval);
    try {
      vi.stubEnv("BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION", approval.nativeVersion);
      vi.stubEnv("BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID", undefined);
      await expect(requireV2NativeIsolation(approval.executablePath, approval.id)).rejects.toThrow(
        "machine/image identity changed",
      );
      vi.stubEnv("BIGBUD_OPENCODE_V2_NATIVE_MACHINE_ID", approval.machineId);
      await expect(requireV2NativeIsolation(approval.executablePath, approval.id)).resolves.toBe(
        approval,
      );
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      catalog.approvals.length = 0;
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
