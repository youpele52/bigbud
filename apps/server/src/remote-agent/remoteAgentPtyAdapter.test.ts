import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { makeRemoteAgentPtyAdapter, type RemoteAgentPtyResolver } from "./remoteAgentPtyAdapter.ts";
import type { RemoteAgentPtyClient } from "./remoteAgentPtyClient.ts";
import type { PtyAdapterShape, PtyProcess } from "../terminal/Services/PTY";
import { profileLaunch, spawnInput } from "./remoteAgentOwnedPty.profile.testUtils.ts";

const fakeProcess: PtyProcess = {
  pid: 12,
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
  onData: () => () => undefined,
  onExit: () => () => undefined,
};

describe("remote-agent PTY adapter", () => {
  it("refuses to silently downgrade explicit profiles on the nonowned path", async () => {
    const calls: string[] = [];
    const resolver: RemoteAgentPtyResolver = {
      resolvePty: async () => {
        calls.push("create");
        throw new Error("must not run");
      },
      resolveWorkspace: async () => {
        throw new Error("must not run");
      },
    };
    const adapter = makeRemoteAgentPtyAdapter(
      { spawn: () => Effect.succeed(fakeProcess) },
      resolver,
    );
    const error = await Effect.runPromise(Effect.flip(adapter.spawn(spawnInput(profileLaunch()))));
    expect(error.message).toContain("durable terminal ownership");
    expect(calls).toEqual([]);
  });

  it("forwards exact-profile intent to the durable lane without changing it", async () => {
    const input = spawnInput(profileLaunch());
    const adapter = makeRemoteAgentPtyAdapter(
      { spawn: () => Effect.succeed(fakeProcess) },
      {
        restoreOrCreate: async (received) => {
          expect(received).toBe(input);
          return fakeProcess;
        },
        resolvePty: async () => {
          throw new Error("must not run");
        },
        resolveWorkspace: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(await Effect.runPromise(adapter.spawn(input))).toBe(fakeProcess);
  });

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
      // Custom-binary composition declines ownership for fresh implicit terminals.
      restoreOrCreate: async () => undefined,
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
            return { ...fakeProcess };
          },
        }) as never,
    };
    const base: PtyAdapterShape = { spawn: () => Effect.succeed(fakeProcess) };
    const adapter = makeRemoteAgentPtyAdapter(base, resolver);

    const remote = await Effect.runPromise(
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
          HOME: "/desktop/home",
          PATH: "/desktop/bin",
          SHELL: "/desktop/shell",
          LC_invalid: "must-not-forward",
        },
        executionTargetId: "ssh:host=devbox",
      }),
    );

    expect(remote.pidDomain).toBe("remote");
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
    expect(created[0]?.args).toEqual(["-lc", 'exec "${SHELL:-/bin/sh}" -l']);
  });

  it("keeps an explicit Direct SSH target on the base PTY adapter", async () => {
    const calls: string[] = [];
    const base: PtyAdapterShape = {
      spawn: () =>
        Effect.sync(() => {
          calls.push("ssh");
          return fakeProcess;
        }),
    };
    const resolver = {} as RemoteAgentPtyResolver;
    const adapter = makeRemoteAgentPtyAdapter(
      base,
      resolver,
      (executionTargetId) => executionTargetId?.includes("transport=agent") === true,
    );

    await Effect.runPromise(
      adapter.spawn({
        shell: "sh",
        cwd: "/srv/project",
        remoteCwd: "/srv/project",
        cols: 80,
        rows: 24,
        env: {},
        executionTargetId: "ssh:host=devbox&transport=direct-ssh",
      }),
    );

    expect(calls).toEqual(["ssh"]);
    expect(fakeProcess.pidDomain).toBeUndefined();
  });
});
