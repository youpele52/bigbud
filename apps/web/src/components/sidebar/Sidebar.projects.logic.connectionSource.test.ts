import { describe, expect, it } from "vitest";

import {
  createRemoteProjectFieldErrors,
  withoutRemoteProjectFieldError,
} from "./Sidebar.projectAddActions.helpers";
import {
  applyRemoteProjectDraftChange,
  createDefaultRemoteProjectDraft,
  createRemoteProjectExecutionTargetId,
  hasRemoteProjectConnectionOverrides,
  type RemoteProjectDraft,
} from "./Sidebar.projects.logic";

function change<K extends keyof RemoteProjectDraft>(
  draft: RemoteProjectDraft,
  field: K,
  value: RemoteProjectDraft[K],
): RemoteProjectDraft {
  return applyRemoteProjectDraftChange(draft, field, value);
}

describe("remote project connection source", () => {
  it("defaults new projects to Direct SSH in the requested source", () => {
    expect(createDefaultRemoteProjectDraft()).toMatchObject({
      connectionSource: "manual",
      remoteTransport: "direct-ssh",
    });
    expect(createDefaultRemoteProjectDraft("ssh-config").connectionSource).toBe("ssh-config");
  });

  it("keeps every connection field per source and restores them when switching back", () => {
    let draft = createDefaultRemoteProjectDraft();
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
    const draft = createDefaultRemoteProjectDraft();
    expect(change(draft, "connectionSource", "manual")).toBe(draft);
  });

  it("stores only the alias for a config host, even after manual overrides were typed", () => {
    let draft = createDefaultRemoteProjectDraft();
    draft = change(draft, "username", "typed-in-manual");
    draft = change(draft, "port", "2222");
    draft = change(draft, "connectionSource", "ssh-config");
    draft = change(draft, "host", "work-server");

    expect(hasRemoteProjectConnectionOverrides(draft)).toBe(false);
    expect(createRemoteProjectExecutionTargetId(draft)).toBe(
      "ssh:host=work-server&auth=ssh-key&transport=direct-ssh",
    );
  });

  it("asks config mode to pick a host and clears connection errors on a source switch", () => {
    const draft = createDefaultRemoteProjectDraft("ssh-config");
    expect(createRemoteProjectFieldErrors(draft).host).toBe("Pick an SSH config host.");

    const errors = { host: "Enter a host.", port: "Bad port.", workspaceRoot: "Enter a path." };
    expect(withoutRemoteProjectFieldError(errors, "connectionSource")).toEqual({
      workspaceRoot: "Enter a path.",
    });
    expect(withoutRemoteProjectFieldError(errors, "displayName")).toBe(errors);
  });
});
