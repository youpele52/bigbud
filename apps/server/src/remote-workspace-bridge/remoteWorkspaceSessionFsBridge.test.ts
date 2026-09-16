import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRemoteSessionFsProvider } from "./remoteWorkspaceSessionFsBridge.handler.ts";
import {
  REMOTE_WORKSPACE_SESSION_STATE_PATH,
  remoteWorkspaceSessionFsInvocationId,
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

  it("maps synthetic bridge paths back into the remote workspace", () => {
    expect(
      resolveSessionFsPath(
        "/tmp/bigbud-cursor-bridge/src/index.ts",
        "/srv/project",
        "/tmp/bigbud-cursor-bridge",
      ),
    ).toEqual({
      kind: "workspace",
      path: "/srv/project/src/index.ts",
    });
  });

  it("uses the supported Copilot session identity for filesystem mutations", () => {
    expect(remoteWorkspaceSessionFsInvocationId("session-1", "append", ["/srv/a.txt"], 1)).toBe(
      "copilot-fs:session-1:1:append:%2Fsrv%2Fa.txt",
    );
    expect(
      remoteWorkspaceSessionFsInvocationId("session-1", "rename", ["/srv/a", "/srv/b"], 2),
    ).not.toBe(
      remoteWorkspaceSessionFsInvocationId("session-1", "rename", ["/srv/a", "/srv/b"], 3),
    );
    expect(
      remoteWorkspaceSessionFsInvocationId("session-1", "rename", ["/srv/a", "/srv/b"], 2),
    ).not.toBe(
      remoteWorkspaceSessionFsInvocationId("session-2", "rename", ["/srv/a", "/srv/b"], 2),
    );
  });

  it("assigns a distinct monotonic identity to repeated remote mutations", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "bigbud-session-fs-"));
    try {
      const invocationIds: string[] = [];
      const provider = createRemoteSessionFsProvider({
        sessionId: "session-1",
        initialCwd: "/srv/project",
        bridgeCwd: "/tmp/bridge",
        stateRoot,
        readiness: { os: "linux" },
        runRemoteShell: async (_script, _args, options) => {
          if (options?.invocationId) invocationIds.push(options.invocationId);
          return {
            code: 0,
            stdout: "",
            stderr: "",
            signal: null,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      });

      await provider.writeFile("/srv/project/a.txt", "one");
      await provider.writeFile("/srv/project/a.txt", "two");
      await provider.mkdir("/srv/project/nested", true);

      expect(new Set(invocationIds).size).toBe(3);
      expect(invocationIds.map((value) => value.split(":")[2])).toEqual(["1", "2", "3"]);

      const recreated = createRemoteSessionFsProvider({
        sessionId: "session-1",
        initialCwd: "/srv/project",
        bridgeCwd: "/tmp/bridge",
        stateRoot,
        readiness: { os: "linux" },
        runRemoteShell: async (_script, _args, options) => {
          if (options?.invocationId) invocationIds.push(options.invocationId);
          return {
            code: 0,
            stdout: "",
            stderr: "",
            signal: null,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
      });
      await recreated.readFile("/srv/project/a.txt");
      await expect(recreated.writeFile("/srv/project/a.txt", "three")).rejects.toThrow(
        "COPILOT_FS_MUTATION_OUTCOME_UNKNOWN",
      );
      expect(invocationIds.map((value) => value.split(":")[2])).toEqual(["1", "2", "3", "4", "5"]);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("fails closed after handler recreation when a remote mutation acknowledgement is lost", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "bigbud-session-fs-ambiguous-"));
    try {
      const invocationIds: string[] = [];
      const first = createRemoteSessionFsProvider({
        sessionId: "session-1",
        initialCwd: "/srv/project",
        bridgeCwd: "/tmp/bridge",
        stateRoot,
        readiness: { os: "linux" },
        runRemoteShell: async (_script, _args, options) => {
          if (options?.invocationId) invocationIds.push(options.invocationId);
          throw new Error("lost response");
        },
      });
      await expect(first.writeFile("/srv/project/a.txt", "one")).rejects.toThrow("lost response");

      const recreated = createRemoteSessionFsProvider({
        sessionId: "session-1",
        initialCwd: "/srv/project",
        bridgeCwd: "/tmp/bridge",
        stateRoot,
        readiness: { os: "linux" },
        runRemoteShell: async () => {
          throw new Error("duplicate dispatch");
        },
      });
      await expect(recreated.writeFile("/srv/project/a.txt", "one")).rejects.toThrow(
        "COPILOT_FS_MUTATION_OUTCOME_UNKNOWN",
      );
      expect(invocationIds).toHaveLength(1);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
