import { describe, expect, it } from "vitest";

import {
  createRemoteWorkspaceFieldErrors,
  withoutRemoteWorkspaceFieldError,
} from "./Sidebar.projectAddActions.helpers";
import {
  applyRemoteWorkspaceDraftChange,
  createDefaultRemoteWorkspaceDraft,
  createRemoteWorkspaceExecutionTargetId,
  hasRemoteWorkspaceConnectionOverrides,
  type RemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";

function change<K extends keyof RemoteWorkspaceDraft>(
  draft: RemoteWorkspaceDraft,
  field: K,
  value: RemoteWorkspaceDraft[K],
): RemoteWorkspaceDraft {
  return applyRemoteWorkspaceDraftChange(draft, field, value);
}

describe("remote workspace connection source", () => {
  it("defaults new projects to Direct SSH in the requested source", () => {
    expect(createDefaultRemoteWorkspaceDraft()).toMatchObject({
      connectionSource: "manual",
      remoteTransport: "direct-ssh",
    });
    expect(createDefaultRemoteWorkspaceDraft("ssh-config").connectionSource).toBe("ssh-config");
  });

  it("keeps every connection field per source and restores them when switching back", () => {
    let draft = createDefaultRemoteWorkspaceDraft();
    draft = change(draft, "host", "10.0.0.5");
    draft = change(draft, "username", "alice");
    draft = change(draft, "port", "2200");
    draft = change(draft, "sshKeyPath", "~/.ssh/id");
    draft = change(draft, "authMode", "password");
    draft = change(draft, "workspaceRoot", "/srv/app");

    const config = change(draft, "connectionSource", "ssh-config");
    expect(config).toMatchObject({
      connectionSource: "ssh-config",
      host: "",
      username: "",
      port: "",
      sshKeyPath: "",
      authMode: "ssh-key",
      workspaceRoot: "/srv/app",
    });

    const manual = change(change(config, "host", "work-server"), "connectionSource", "manual");
    expect(manual).toMatchObject({
      host: "10.0.0.5",
      username: "alice",
      port: "2200",
      sshKeyPath: "~/.ssh/id",
      authMode: "password",
    });
    expect(change(manual, "connectionSource", "ssh-config").host).toBe("work-server");
  });

  it("returns the same draft when the source does not change", () => {
    const draft = createDefaultRemoteWorkspaceDraft();
    expect(change(draft, "connectionSource", "manual")).toBe(draft);
  });

  it("stores only the alias for a config host, even after manual overrides were typed", () => {
    let draft = createDefaultRemoteWorkspaceDraft();
    draft = change(draft, "username", "typed-in-manual");
    draft = change(draft, "port", "2222");
    draft = change(draft, "connectionSource", "ssh-config");
    draft = change(draft, "host", "work-server");

    expect(hasRemoteWorkspaceConnectionOverrides(draft)).toBe(false);
    expect(createRemoteWorkspaceExecutionTargetId(draft)).toBe(
      "ssh:host=work-server&auth=ssh-key&transport=direct-ssh",
    );
  });

  it("asks config mode to pick a host and clears connection errors on a source switch", () => {
    const draft = createDefaultRemoteWorkspaceDraft("ssh-config");
    expect(createRemoteWorkspaceFieldErrors(draft).host).toBe("Pick an SSH config host.");

    const errors = { host: "Enter a host.", port: "Bad port.", workspaceRoot: "Enter a path." };
    expect(withoutRemoteWorkspaceFieldError(errors, "connectionSource")).toEqual({
      workspaceRoot: "Enter a path.",
    });
    expect(withoutRemoteWorkspaceFieldError(errors, "displayName")).toBe(errors);
  });
});
