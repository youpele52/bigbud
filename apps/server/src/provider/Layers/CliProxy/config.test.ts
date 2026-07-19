import { describe, expect, it } from "vitest";

import { CLI_PROXY_HEALTH_PATH, cliProxyHarnessEnvironment, readCliProxyConfig } from "./config.ts";

describe("CLIProxy configuration", () => {
  it("uses the unauthenticated CLIProxyAPI healthz endpoint", () => {
    expect(CLI_PROXY_HEALTH_PATH).toBe("/healthz");
  });

  it("is absent unless explicitly enabled with loopback-only environment secrets", () => {
    expect(readCliProxyConfig({ BIGBUD_EXPERIMENTAL_CLIPROXY: "1" })).toBeUndefined();
    expect(
      readCliProxyConfig({
        BIGBUD_EXPERIMENTAL_CLIPROXY: "1",
        BIGBUD_CLIPROXY_BASE_URL: "https://proxy.example.test",
        BIGBUD_CLIPROXY_API_KEY: "api",
        BIGBUD_CLIPROXY_MANAGEMENT_KEY: "management",
      }),
    ).toBeUndefined();
  });

  it("accepts every documented loopback hostname", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        readCliProxyConfig({
          BIGBUD_EXPERIMENTAL_CLIPROXY: "1",
          BIGBUD_CLIPROXY_BASE_URL: `http://${hostname}:8317`,
          BIGBUD_CLIPROXY_API_KEY: "api",
          BIGBUD_CLIPROXY_MANAGEMENT_KEY: "management",
        }),
      ).toBeDefined();
    }
  });

  it("creates an isolated harness environment without mutating its source", () => {
    const env = {
      BIGBUD_EXPERIMENTAL_CLIPROXY: "1",
      BIGBUD_CLIPROXY_BASE_URL: "http://127.0.0.1:8317/",
      BIGBUD_CLIPROXY_API_KEY: "api",
      BIGBUD_CLIPROXY_MANAGEMENT_KEY: "management",
      ANTHROPIC_API_KEY: "native-secret",
      HOME: "/Users/test",
      PATH: "/opt/homebrew/bin:/usr/bin",
      USERPROFILE: "C:\\Users\\test",
    };
    const config = readCliProxyConfig(env);
    expect(config).toBeDefined();
    expect(cliProxyHarnessEnvironment(config!, env)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/test",
      USERPROFILE: "C:\\Users\\test",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "api",
      ANTHROPIC_API_KEY: "",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("native-secret");
  });
});
