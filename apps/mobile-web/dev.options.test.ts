import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseMobileDevOptions } from "./dev.options.ts";

describe("mobile development CLI compatibility", () => {
  it("preserves direct PORT fallback and runner MOBILE_WEB_PORT precedence", () => {
    expect(parseMobileDevOptions([], {}).port).toBe(5740);
    expect(parseMobileDevOptions([], { PORT: "6000" }).port).toBe(6000);
    expect(parseMobileDevOptions([], { PORT: "6000", MOBILE_WEB_PORT: "5752" }).port).toBe(5752);
    expect(parseMobileDevOptions(["--port", "6100"], { MOBILE_WEB_PORT: "5752" }).port).toBe(6100);
  });

  it("forwards host and mode overrides to Vite", () => {
    expect(
      parseMobileDevOptions(["--port=6100", "--host", "127.0.0.1", "--mode", "staging"], {}),
    ).toEqual({
      port: 6100,
      config: { server: { host: "127.0.0.1" }, mode: "staging" },
      help: false,
    });
    expect(parseMobileDevOptions(["--host", "-m", "development"], {}).config).toEqual({
      server: { host: "0.0.0.0" },
      mode: "development",
    });
    expect(parseMobileDevOptions(["--host=::1"], {}).config).toEqual({ server: { host: "::1" } });
  });

  it("preserves nonconflicting browser, optimizer, logging, and config flags", () => {
    expect(
      parseMobileDevOptions(
        [
          "--open",
          "--force",
          "--cors",
          "--no-clearScreen",
          "-l",
          "warn",
          "--base",
          "/mobile/",
          "-c",
          "alternate.config.ts",
        ],
        {},
      ).config,
    ).toEqual({
      server: { open: true, cors: true },
      forceOptimizeDeps: true,
      logLevel: "warn",
      clearScreen: false,
      base: "/mobile/",
      configFile: "alternate.config.ts",
    });
    expect(parseMobileDevOptions(["--open", "/mobile"], {}).config.server?.open).toBe("/mobile");
    expect(() => parseMobileDevOptions(["--logLevel", "invalid"], {})).toThrow("--logLevel");
  });

  it.each([["--unknown"], ["some-root"], ["--port"], ["--host="], ["--mode="]])(
    "rejects unsupported or incomplete arguments %j",
    (...args) => expect(() => parseMobileDevOptions(args, {})).toThrow(),
  );

  it("actual launcher prints help or rejects unsupported flags before starting Vite", () => {
    const launcher = fileURLToPath(new URL("./dev.ts", import.meta.url));
    const help = spawnSync(process.execPath, [launcher, "--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: bun run dev");
    const unknown = spawnSync(process.execPath, [launcher, "--unknown"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown option '--unknown'");
  });
});
