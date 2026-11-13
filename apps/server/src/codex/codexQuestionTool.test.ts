import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ version: "0.167.0" as string | undefined, spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("./codexVersionCheck.ts", () => ({
  assertSupportedCodexCliVersion: () => mocks.version,
}));

import { startCodexAppServerProcess } from "./codexAppServerManager.process.ts";
import {
  codexQuestionToolConfigArgs,
  supportsCodexDefaultModeUserInput,
} from "./codexQuestionTool.ts";

describe("Codex Default-mode questions", () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation(() =>
      Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }),
    );
  });

  it("enables the feature only on verified versions and fails closed otherwise", () => {
    expect(supportsCodexDefaultModeUserInput("0.167.0")).toBe(true);
    expect(supportsCodexDefaultModeUserInput("0.168.2")).toBe(true);
    expect(supportsCodexDefaultModeUserInput("1.0.0")).toBe(true);
    expect(supportsCodexDefaultModeUserInput("0.166.0")).toBe(false);
    expect(supportsCodexDefaultModeUserInput("0.167.0-alpha.1")).toBe(false);
    expect(supportsCodexDefaultModeUserInput(undefined)).toBe(false);
    expect(supportsCodexDefaultModeUserInput("zzz")).toBe(false);
    expect(codexQuestionToolConfigArgs("0.167.0")).toEqual([
      "-c",
      "features.default_mode_request_user_input=true",
    ]);
    expect(codexQuestionToolConfigArgs("0.166.0")).toEqual([]);
  });

  it.each([
    ["0.167.0", ["app-server", "-c", "x=1", "-c", "features.default_mode_request_user_input=true"]],
    ["0.166.0", ["app-server", "-c", "x=1"]],
  ])("spawns the local app-server for Codex %s with the right overrides", (version, args) => {
    mocks.version = version;
    startCodexAppServerProcess(
      {
        threadId: "thread-1",
        provider: "codex",
        binaryPath: "codex",
        runtimeMode: "full-access",
        configArgs: ["-c", "x=1"],
      } as never,
      "/tmp",
    );
    expect(mocks.spawn).toHaveBeenCalledWith("codex", args, expect.anything());
  });
});
