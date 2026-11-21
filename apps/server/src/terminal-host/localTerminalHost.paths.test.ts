import { describe, expect, it } from "vitest";

import { localTerminalHostSelection } from "./localTerminalHost.layer.ts";
import {
  LOCAL_TERMINAL_HOST_TARGET_ID,
  localTerminalHostGenerationPaths,
  localTerminalHostPaths,
  localTerminalHostRuntimeSegment,
  localTerminalHostSocketPathTooLong,
  parseLocalTerminalHostGeneration,
  resolveLocalTerminalHostMode,
} from "./localTerminalHost.paths.ts";

describe("local terminal host flag rule", () => {
  it("is opt-in before Q1: only BIGBUD_TERMINAL_HOST === '1' enables it", () => {
    expect(resolveLocalTerminalHostMode({}, false)).toBe("adopt-only");
    expect(resolveLocalTerminalHostMode({ BIGBUD_TERMINAL_HOST: "true" }, false)).toBe(
      "adopt-only",
    );
    expect(resolveLocalTerminalHostMode({ BIGBUD_TERMINAL_HOST: "0" }, false)).toBe("adopt-only");
    expect(resolveLocalTerminalHostMode({ BIGBUD_TERMINAL_HOST: "1" }, false)).toBe("enabled");
  });

  it("is opt-out after Q1: only BIGBUD_TERMINAL_HOST === '0' is the kill switch", () => {
    expect(resolveLocalTerminalHostMode({}, true)).toBe("enabled");
    expect(resolveLocalTerminalHostMode({ BIGBUD_TERMINAL_HOST: "0" }, true)).toBe("adopt-only");
  });

  it("changes nothing when the flag is unset and no host root exists", () => {
    expect(
      localTerminalHostSelection({ stateDir: "/s", environment: {}, rootExists: () => false }),
    ).toBeUndefined();
  });

  it("adopts an existing host under the kill switch but never on Windows", () => {
    expect(
      localTerminalHostSelection({ stateDir: "/s", environment: {}, rootExists: () => true }),
    ).toBe("adopt-only");
    expect(
      localTerminalHostSelection({
        stateDir: "/s",
        environment: { BIGBUD_TERMINAL_HOST: "1" },
        platform: "linux",
        rootExists: () => false,
      }),
    ).toBe("enabled");
    expect(
      localTerminalHostSelection({
        stateDir: "/s",
        environment: { BIGBUD_TERMINAL_HOST: "1" },
        platform: "win32",
      }),
    ).toBeUndefined();
  });
});

describe("local terminal host paths", () => {
  it("lays out state generations with their sockets and the shared target id", () => {
    const paths = localTerminalHostPaths("/tmp/bbth-x");
    expect(paths.hostsFile).toBe("/tmp/bbth-x/terminal-host/hosts.json");
    const generation = localTerminalHostGenerationPaths(paths.root, 3);
    expect(generation).toMatchObject({
      name: "state-3",
      statePath: "/tmp/bbth-x/terminal-host/state-3",
      socketPath: "/tmp/bbth-x/terminal-host/state-3/supervisor.sock",
    });
    expect(LOCAL_TERMINAL_HOST_TARGET_ID).toBe("local-terminal-host");
  });

  it("parses only canonical generation names", () => {
    expect(parseLocalTerminalHostGeneration("state-12")).toBe(12);
    expect(parseLocalTerminalHostGeneration("state-0")).toBeUndefined();
    expect(parseLocalTerminalHostGeneration("state-01")).toBeUndefined();
    expect(parseLocalTerminalHostGeneration("runtimes")).toBeUndefined();
  });

  it("refuses socket paths over 100 bytes", () => {
    expect(localTerminalHostSocketPathTooLong(`/${"a".repeat(99)}`)).toBe(false);
    expect(localTerminalHostSocketPathTooLong(`/${"a".repeat(100)}`)).toBe(true);
  });

  it("hashes unusual build digests into a safe runtime directory name", () => {
    expect(localTerminalHostRuntimeSegment("abc123-dirty")).toBe("abc123-dirty");
    expect(localTerminalHostRuntimeSegment("../escape")).toMatch(/^h-[a-f0-9]{64}$/);
    expect(localTerminalHostRuntimeSegment("a/b")).toMatch(/^h-[a-f0-9]{64}$/);
  });
});
