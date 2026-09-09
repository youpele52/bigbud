import { describe, expect, it } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyClient, RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

describe("remote PTY ownership release", () => {
  it.each(["transport", "rejected", "acknowledged"])(
    "does not report exit from %s close",
    async (kind) => {
      let listener: ((frame: RemoteAgentFrame) => unknown) | undefined;
      const connection = {
        onFrame: (callback: typeof listener) => {
          listener = callback;
          return () => undefined;
        },
        onFailure: () => () => undefined,
        request: async () => {
          if (kind === "transport") throw new Error("socket lost");
          return {
            type: "ptyCloseResponse",
            value: {
              ptyId: "pty",
              requestId: "r",
              accepted: kind === "acknowledged",
              errorCode: "PTY_CLOSE_ERROR",
              errorMessage: "unknown PTY",
            },
          };
        },
      } as unknown as RemoteAgentConnection;
      const process = new RemoteAgentPtyProcess(connection, "pty", undefined);
      let exits = 0;
      process.onExit(() => {
        exits++;
      });
      if (kind === "acknowledged") await process.close();
      else await expect(process.close()).rejects.toThrow();
      expect(exits).toBe(0);
      listener?.({
        type: "ptyExited",
        value: { ptyId: "pty", hasExitCode: true, exitCode: 0, hasSignal: false, signal: 0 },
      });
      expect(exits).toBe(1);
    },
  );

  it("reports a rejected create as definitive before returning the error", async () => {
    const connection = {
      onFrame: () => () => undefined,
      onFailure: () => () => undefined,
      request: async () => ({
        type: "ptyCreateResponse",
        value: {
          requestId: "request",
          ptyId: "pty",
          accepted: false,
          pid: 0,
          errorCode: "WORKSPACE_REJECTED",
          errorMessage: "workspace denied",
        },
      }),
    } as unknown as RemoteAgentConnection;
    let released = 0;
    await expect(
      new RemoteAgentPtyClient(connection).create({
        workspaceHandle: "workspace",
        cwd: "",
        shell: "/bin/sh",
        cols: 80,
        rows: 24,
        onRejected: async () => {
          released++;
        },
      }),
    ).rejects.toThrow("workspace denied");
    expect(released).toBe(1);
  });

  it("settles an active PTY with an explicit restart interruption", () => {
    const connection = {
      onFrame: () => () => undefined,
      onFailure: () => () => undefined,
    } as unknown as RemoteAgentConnection;
    const process = new RemoteAgentPtyProcess(connection, "pty", undefined);
    const errors: Error[] = [];
    let exitCode: number | undefined;
    process.onError((error) => errors.push(error));
    process.onExit((event) => {
      exitCode = event.exitCode;
    });

    process.interrupt("remote-service-restarted");

    expect(exitCode).toBe(1);
    expect(process.interruptionReason).toBe("remote-service-restarted");
    expect(errors[0]?.message).toContain("Remote service restarted");
  });
});
