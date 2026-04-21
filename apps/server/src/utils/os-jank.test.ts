import { describe, expect, it, vi } from "vitest";

import { fixPath } from "./os-jank";

describe("fixPath", () => {
  it("hydrates PATH on linux using the resolved login shell", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");

    fixPath({
      env,
      platform: "linux",
      readPath,
    });

    expect(readPath).toHaveBeenCalledWith("/bin/zsh");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("does nothing outside macOS and linux even when SHELL is set", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
    };
    const readPath = vi.fn(() => "/usr/local/bin:/usr/bin");

    fixPath({
      env,
      platform: "win32",
      readPath,
    });

    expect(readPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });

  it("merges shell PATH with env PATH, shell entries first", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/usr/local/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");

    fixPath({
      env,
      platform: "darwin",
      readPath,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  });

  it("tries multiple shell candidates before falling back to launchctl", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
    };
    const readPath = vi.fn(() => {
      throw new Error("shell not found");
    });
    const readLaunchctlPath = vi.fn(() => "/usr/bin:/bin:/usr/sbin:/sbin");
    const warnings: string[] = [];

    fixPath({
      env,
      platform: "darwin",
      readPath,
      readLaunchctlPath,
      logWarning: (msg) => warnings.push(msg),
    });

    expect(readLaunchctlPath).toHaveBeenCalled();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("falls back to launchctl on macOS when all shell reads fail", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
    };
    const readPath = vi.fn(() => {
      throw new Error("shell not found");
    });
    const readLaunchctlPath = vi.fn(() => "/usr/bin:/bin:/usr/sbin:/sbin");

    fixPath({
      env,
      platform: "darwin",
      readPath,
      readLaunchctlPath,
    });

    expect(readLaunchctlPath).toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("does not attempt launchctl on linux", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
    };
    const readPath = vi.fn(() => {
      throw new Error("shell not found");
    });
    const readLaunchctlPath = vi.fn(() => "/launchctl/path");

    fixPath({
      env,
      platform: "linux",
      readPath,
      readLaunchctlPath,
    });

    expect(readLaunchctlPath).not.toHaveBeenCalled();
  });
});
