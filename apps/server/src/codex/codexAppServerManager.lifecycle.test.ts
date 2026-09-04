import { describe, expect, it, vi } from "vitest";

import { buildCodexInitializeParams, CodexAppServerManager } from "./codexAppServerManager";
import { asThreadId } from "./codexAppServerManager.test.helpers";

vi.mock("./codexVersionCheck", () => ({
  assertSupportedCodexCliVersion: vi.fn(),
}));

describe("startSession", () => {
  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "bigcode_desktop",
        title: "bigbud Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it("emits session/startFailed when resolving cwd throws before process launch", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });
    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        method: "session/startFailed",
        kind: "error",
        message: "cwd missing",
      });
    } finally {
      processCwd.mockRestore();
      manager.stopAll();
    }
  });

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const { assertSupportedCodexCliVersion } = await import("./codexVersionCheck");
    const versionCheck = vi.mocked(assertSupportedCodexCliVersion);

    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    versionCheck.mockImplementationOnce(() => {
      throw new Error(
        "Codex CLI v0.99.0 is too old for bigbud. Upgrade to v0.100.0 or newer and restart bigbud.",
      );
    });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.99.0 is too old for bigbud. Upgrade to v0.100.0 or newer and restart bigbud.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.99.0 is too old for bigbud. Upgrade to v0.100.0 or newer and restart bigbud.",
        },
      ]);
    } finally {
      versionCheck.mockReset();
      manager.stopAll();
    }
  });
});
