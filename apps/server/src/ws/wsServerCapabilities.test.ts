import { ServerWorkspaceCapabilities } from "@bigbud/contracts/server/server";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { resolveLocalTerminalHostMode } from "../terminal-host/localTerminalHost.paths.ts";
import { serverWorkspaceCapabilities } from "./wsServerCapabilities.ts";

const stateDir = "/nonexistent/bigbud-state";
const reported = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
  Schema.decodeUnknownSync(ServerWorkspaceCapabilities)(
    serverWorkspaceCapabilities({ remoteAgentEnabled: false, stateDir, environment, platform }),
  ).terminalHost?.enabled;

describe("server config terminal host capability", () => {
  it("reports the host enabled when it is turned on", () => {
    expect(reported({ BIGBUD_TERMINAL_HOST: "1" }, "darwin")).toBe(true);
    expect(reported({ BIGBUD_TERMINAL_HOST: "1" }, "linux")).toBe(true);
  });

  it("reports it off when turned off, and by default only before qualification", () => {
    expect(reported({ BIGBUD_TERMINAL_HOST: "0" }, "darwin")).toBe(false);
    expect(reported({}, "linux")).toBe(resolveLocalTerminalHostMode({}) === "enabled");
  });

  it("reports it off on Windows even when turned on", () => {
    expect(reported({ BIGBUD_TERMINAL_HOST: "1" }, "win32")).toBe(false);
  });

  it("keeps reporting remote-agent capabilities", () => {
    expect(
      serverWorkspaceCapabilities({ remoteAgentEnabled: true, stateDir, platform: "linux" })
        .remoteAgent,
    ).toEqual({ enabled: true, supportsDirectoryWatch: true, supportsPtyReattach: true });
  });
});
