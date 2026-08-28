import { describe, expect, it, vi } from "vitest";

import { makeRemoteWorkspaceReadinessProbe } from "./remoteWorkspaceReadiness.ts";

const target = {
  location: "remote" as const,
  executionTargetId: "ssh:host=devbox&user=root&port=22",
  cwd: "/srv/project",
};

function result(stdout: string) {
  return { stdout, stderr: "", code: 0, signal: null, timedOut: false };
}

describe("remote workspace readiness", () => {
  it.each([
    ["Linux", "x86_64", "linux"],
    ["Darwin", "arm64", "darwin"],
  ] as const)("accepts %s hosts", async (reportedOs, architecture, os) => {
    const run = vi.fn(async () => result(`${reportedOs}\n${architecture}\n`));
    const probe = makeRemoteWorkspaceReadinessProbe(run);

    await expect(probe(target)).resolves.toEqual({ os, architecture });
    expect(run).toHaveBeenCalledWith({ workspaceTarget: target, timeoutMs: 10_000 });
  });

  it("rejects Windows hosts explicitly instead of claiming POSIX bridge support", async () => {
    const probe = makeRemoteWorkspaceReadinessProbe(async () => result("Windows_NT\nAMD64\n"));
    await expect(probe(target)).rejects.toThrow(/Linux or macOS with a POSIX shell/u);
  });

  it("rejects unsupported remote architectures explicitly", async () => {
    const probe = makeRemoteWorkspaceReadinessProbe(async () => result("Linux\nsparc64\n"));
    await expect(probe(target)).rejects.toThrow("architecture 'sparc64' is unsupported");
  });

  it("rejects missing workspace configuration before transport launch", async () => {
    const run = vi.fn(async () => result("Linux\nx86_64\n"));
    const probe = makeRemoteWorkspaceReadinessProbe(run);
    await expect(probe({ ...target, cwd: undefined })).rejects.toThrow(/explicit workspace root/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("propagates missing binary, credentials, and timeout transport errors", async () => {
    for (const detail of [
      "Command not found: ssh",
      "Permission denied (publickey)",
      "sh -lc readiness timed out",
    ]) {
      const probe = makeRemoteWorkspaceReadinessProbe(async () => {
        throw new Error(detail);
      });
      await expect(probe(target)).rejects.toThrow(detail);
    }
  });
});
