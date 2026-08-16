import { describe, expect, it } from "vitest";

import { createRemoteProjectDraft, isSshExecutionTargetId } from "./Sidebar.projects.logic";

describe("remote project SSH editing", () => {
  it("identifies only SSH execution targets", () => {
    expect(isSshExecutionTargetId("ssh:devbox")).toBe(true);
    expect(isSshExecutionTargetId("ssh:host=devbox&auth=password")).toBe(true);
    expect(isSshExecutionTargetId("local")).toBe(false);
    expect(isSshExecutionTargetId("container:devbox")).toBe(false);
    expect(isSshExecutionTargetId("ssh:")).toBe(false);
  });

  it("prefills canonical SSH project settings", () => {
    expect(
      createRemoteProjectDraft({
        id: "project-1" as never,
        name: "Remote project",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId:
          "ssh:host=devbox&user=alice&port=2222&auth=ssh-key&keyPath=~%2F.ssh%2Fid_ed25519",
        cwd: "~/workspace/project",
        defaultModelSelection: null,
        scripts: [],
      }),
    ).toEqual({
      displayName: "Remote project",
      host: "devbox",
      username: "alice",
      port: "2222",
      workspaceRoot: "~/workspace/project",
      sshKeyPath: "~/.ssh/id_ed25519",
      authMode: "ssh-key",
      providerRuntimeLocation: "local",
    });
  });

  it("prefills legacy SSH targets without inventing a secret", () => {
    expect(
      createRemoteProjectDraft({
        id: "project-1" as never,
        name: "Legacy",
        providerRuntimeExecutionTargetId: "ssh:devbox",
        workspaceExecutionTargetId: "ssh:devbox",
        cwd: "/srv/project",
        defaultModelSelection: null,
        scripts: [],
      }),
    ).toMatchObject({
      host: "devbox",
      authMode: "ssh-key",
      sshKeyPath: "",
      providerRuntimeLocation: "remote",
    });
  });
});
