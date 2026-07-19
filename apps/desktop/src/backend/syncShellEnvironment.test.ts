import { describe, expect, it, vi } from "vitest";

import { syncShellEnvironment, syncShellEnvironmentAsync } from "./syncShellEnvironment";

describe("syncShellEnvironment", () => {
  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith(
      "/bin/zsh",
      expect.arrayContaining([
        "PATH",
        "SSH_AUTH_SOCK",
        "BIGBUD_EXPERIMENTAL_CLIPROXY",
        "BIGBUD_CLIPROXY_BASE_URL",
        "BIGBUD_CLIPROXY_API_KEY",
        "BIGBUD_CLIPROXY_MANAGEMENT_KEY",
      ]),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates missing CLIProxy configuration without replacing inherited values", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      BIGBUD_CLIPROXY_API_KEY: "inherited-api-key",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      BIGBUD_EXPERIMENTAL_CLIPROXY: "1",
      BIGBUD_CLIPROXY_BASE_URL: "http://localhost:8317",
      BIGBUD_CLIPROXY_API_KEY: "shell-api-key",
      BIGBUD_CLIPROXY_MANAGEMENT_KEY: "management-key",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env).toMatchObject({
      BIGBUD_EXPERIMENTAL_CLIPROXY: "1",
      BIGBUD_CLIPROXY_BASE_URL: "http://localhost:8317",
      BIGBUD_CLIPROXY_API_KEY: "inherited-api-key",
      BIGBUD_CLIPROXY_MANAGEMENT_KEY: "management-key",
    });
  });

  it("preserves inherited values when the login shell omits them", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith(
      "/bin/zsh",
      expect.arrayContaining([
        "PATH",
        "SSH_AUTH_SOCK",
        "BIGBUD_EXPERIMENTAL_CLIPROXY",
        "BIGBUD_CLIPROXY_BASE_URL",
        "BIGBUD_CLIPROXY_API_KEY",
        "BIGBUD_CLIPROXY_MANAGEMENT_KEY",
      ]),
    );
    expect(env.PATH).toBe("/home/linuxbrew/.linuxbrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("does nothing outside macOS and linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "win32",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH asynchronously without blocking the caller", async () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(async () => ({
      PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    await syncShellEnvironmentAsync(env, {
      platform: "linux",
      readEnvironment,
    });

    expect(readEnvironment).toHaveBeenCalledWith(
      "/bin/zsh",
      expect.arrayContaining([
        "PATH",
        "SSH_AUTH_SOCK",
        "BIGBUD_EXPERIMENTAL_CLIPROXY",
        "BIGBUD_CLIPROXY_BASE_URL",
        "BIGBUD_CLIPROXY_API_KEY",
        "BIGBUD_CLIPROXY_MANAGEMENT_KEY",
      ]),
    );
    expect(env.PATH).toBe("/home/linuxbrew/.linuxbrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });
});
