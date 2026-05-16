import { describe, expect, it } from "vitest";

import {
  REMOTE_WORKSPACE_SESSION_STATE_PATH,
  resolveSessionFsPath,
} from "./remoteWorkspaceSessionFsBridge.ts";

describe("remoteWorkspaceSessionFsBridge", () => {
  it("keeps session-state paths relative instead of resolving them against cwd", () => {
    expect(resolveSessionFsPath(REMOTE_WORKSPACE_SESSION_STATE_PATH, "/srv/project")).toEqual({
      kind: "session-state",
      path: ".bigbud/session-state",
    });

    expect(resolveSessionFsPath(".bigbud/session-state/workspace.yaml", "/srv/project")).toEqual({
      kind: "session-state",
      path: ".bigbud/session-state/workspace.yaml",
    });
  });

  it("resolves non-session-state relative paths against the remote cwd", () => {
    expect(resolveSessionFsPath("src/index.ts", "/srv/project")).toEqual({
      kind: "workspace",
      path: "/srv/project/src/index.ts",
    });

    expect(resolveSessionFsPath("/etc/hosts", "/srv/project")).toEqual({
      kind: "workspace",
      path: "/etc/hosts",
    });
  });
});
