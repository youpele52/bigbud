import { describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionTypedSshToolCapability } from "./toolTransport.ssh.owner.production.ts";
import { runTypedSshToolCommand } from "./toolTransport.ssh.owner.ts";

const target = "ssh:prod-box";

function live() {
  const bound = {
    listProofWorkspaceDirectory: vi.fn(async () => ({
      entries: [{ name: "a.txt", directory: false }],
      truncated: false,
    })),
    createProofWorkspaceDirectory: vi.fn(async () => "created" as const),
  };
  const value = {
    handle: { target: vi.fn(() => bound), state: () => "open" },
    descriptorFor: vi.fn(async () => ({ targetId: "prod-box", kind: "alias" })),
  } as unknown as SshOwnerProductionRegistration;
  return { value, bound };
}

describe("production typed SSH tool transport", () => {
  it("runs the closed verbs on the exact target with the caller's root", async () => {
    const { value, bound } = live();
    const capability = makeProductionTypedSshToolCapability(target, "/srv/work", () => value);
    const listing = await runTypedSshToolCommand({
      capability,
      command: { kind: "directory.list", relativeDir: "" },
      executionTargetId: target,
    });
    expect(listing).toMatchObject({ kind: "directory", truncated: false });
    expect(bound.listProofWorkspaceDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ executionTargetId: target, workspaceRoot: "/srv/work" }),
      undefined,
    );
    await runTypedSshToolCommand({
      capability,
      command: { kind: "directory.create", relativePath: "made" },
    });
    expect(bound.createProofWorkspaceDirectory).toHaveBeenCalledOnce();
  });

  it("refuses without a live owner, a foreign target or a root of /", async () => {
    const capability = makeProductionTypedSshToolCapability(target, "/srv/work", () => undefined);
    await expect(
      runTypedSshToolCommand({ capability, command: { kind: "directory.list", relativeDir: "" } }),
    ).rejects.toMatchObject({ code: "ownerUnavailable" });
    await expect(
      runTypedSshToolCommand({
        capability,
        command: { kind: "directory.list", relativeDir: "" },
        executionTargetId: "ssh:other",
      }),
    ).rejects.toThrow();
    expect(() => makeProductionTypedSshToolCapability(target, "/")).toThrow();
    expect(() => makeProductionTypedSshToolCapability("local", "/srv")).toThrow();
  });
});
