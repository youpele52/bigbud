import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import {
  assertV2NativeFixtureVersion,
  type V2NativeIsolationApproval,
} from "./SharedService.native.isolation.fixture.ts";
import { startOwnedV2SshProcess } from "./ServerManager.ssh.ts";

const spawn = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Observed unauthorized retail spawn");
  }),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn,
}));

it.each(["private", "shared", "version-helper", "ssh"] as const)(
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
            : kind === "version-helper"
              ? assertV2NativeFixtureVersion(
                  {
                    executablePath: binary,
                    id: "caller-asserted-not-approved",
                  } as V2NativeIsolationApproval,
                  process.env,
                  root,
                )
              : startOwnedV2SshProcess(
                  {
                    binaryPath: binary,
                    profileRoot: root,
                    runtimeTargetId: "ssh:host=synthetic.invalid&user=fixture&auth=ssh-key",
                  },
                  { protectedBootstrapConformance: true },
                );
      await expect(result).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
