import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeRemoteAgentPtyAdapter, type RemoteAgentPtyResolver } from "./remoteAgentPtyAdapter.ts";
import type { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import type { PtyAdapterShape, PtyProcess } from "../terminal/Services/PTY";

const fakeProcess: PtyProcess = {
  pid: 12,
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
  onData: () => () => undefined,
  onExit: () => () => undefined,
};

describe("remote-agent PTY adapter", () => {
  it("keeps local PTYs on the existing adapter", async () => {
    const calls: string[] = [];
    const base: PtyAdapterShape = {
      spawn: () =>
        Effect.sync(() => {
          calls.push("local");
          return fakeProcess;
        }),
    };
    const resolver = {} as RemoteAgentPtyResolver;
    const adapter = makeRemoteAgentPtyAdapter(base, resolver);

    await Effect.runPromise(
      adapter.spawn({
        shell: "sh",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        env: {},
        executionTargetId: "local",
      }),
    );

    expect(calls).toEqual(["local"]);
  });

  it("opens the remote root and sends only terminal environment values", async () => {
    const opened: Array<{ handle: string; root: string }> = [];
    const created: Array<Record<string, unknown>> = [];
    const resolver: RemoteAgentPtyResolver = {
      resolveWorkspace: async () =>
        ({
          openWorkspace: async (workspaceHandle: string, root: string) => {
            opened.push({ handle: workspaceHandle, root });
            return {
              requestId: "request",
              workspaceHandle,
              accepted: true,
              errorCode: "",
              errorMessage: "",
            };
          },
        }) as never,
      resolvePty: async () =>
        ({
          create: async (input: Parameters<NonNullable<RemoteAgentPtyClient["create"]>>[0]) => {
            created.push(input as unknown as Record<string, unknown>);
            return fakeProcess;
          },
        }) as never,
    };
    const base: PtyAdapterShape = { spawn: () => Effect.succeed(fakeProcess) };
    const adapter = makeRemoteAgentPtyAdapter(base, resolver);

    await Effect.runPromise(
      adapter.spawn({
        shell: "ssh",
        args: ["ignored"],
        cwd: "/tmp",
        remoteCwd: "/srv/project",
        cols: 120,
        rows: 30,
        env: {
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: "en_US.UTF-8",
          LC_MESSAGES: "en_US.UTF-8",
          SECRET_KEY: "must-not-forward",
        },
        executionTargetId: "ssh:host=devbox",
      }),
    );

    expect(opened).toHaveLength(1);
    expect(opened[0]?.root).toBe("/srv/project");
    expect(created[0]?.environment).toEqual([
      { name: "TERM", value: "xterm-256color" },
      { name: "COLORTERM", value: "truecolor" },
      { name: "LANG", value: "en_US.UTF-8" },
      { name: "LC_MESSAGES", value: "en_US.UTF-8" },
    ]);
    expect(created[0]?.cwd).toBe("");
    expect(created[0]?.shell).toBe("/bin/sh");
  });
});
