import { describe, expect, it, vi } from "vitest";

import {
  extractPathFromShellOutput,
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readPathFromLaunchctl,
  readPathFromLoginShell,
} from "./shell";

describe("extractPathFromShellOutput", () => {
  it("extracts the path between capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "__T3CODE_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__T3CODE_PATH_END__\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("ignores shell startup noise around the capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "Welcome to fish\n__T3CODE_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__T3CODE_PATH_END__\nBye\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("returns null when the markers are missing", () => {
    expect(extractPathFromShellOutput("/opt/homebrew/bin /usr/bin")).toBeNull();
  });
});

describe("readPathFromLoginShell", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() => "__T3CODE_ENV_PATH_START__\n/a:/b\n__T3CODE_ENV_PATH_END__\n");

    expect(readPathFromLoginShell("/opt/homebrew/bin/fish", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0] as
      | [string, ReadonlyArray<string>, { encoding: "utf8"; timeout: number }]
      | undefined;
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_START__");
    expect(args?.[1]).toContain("__T3CODE_ENV_PATH_END__");
    expect(options).toEqual({ encoding: "utf8", timeout: 5000 });
  });
});

describe("readEnvironmentFromLoginShell", () => {
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      [
        "__T3CODE_ENV_PATH_START__",
        "/a:/b",
        "__T3CODE_ENV_PATH_END__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_START__",
        "__T3CODE_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<
      (
        file: string,
        args: ReadonlyArray<string>,
        options: { encoding: "utf8"; timeout: number },
      ) => string
    >(() =>
      ["__T3CODE_ENV_CUSTOM_VAR_START__", "  padded value  ", "__T3CODE_ENV_CUSTOM_VAR_END__"].join(
        "\n",
      ),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
    });
  });
});

describe("listLoginShellCandidates", () => {
  it("returns envShell first, then userShell, then platform defaults (macOS)", () => {
    const candidates = listLoginShellCandidates("darwin", "/opt/homebrew/bin/fish", "/bin/bash");
    expect(candidates).toEqual(["/opt/homebrew/bin/fish", "/bin/bash", "/bin/zsh"]);
  });

  it("deduplicates entries", () => {
    const candidates = listLoginShellCandidates("darwin", "/bin/zsh", "/bin/zsh");
    expect(candidates).toEqual(["/bin/zsh", "/bin/bash"]);
  });

  it("returns platform defaults when no shells are specified (macOS)", () => {
    const candidates = listLoginShellCandidates("darwin");
    expect(candidates).toEqual(["/bin/zsh", "/bin/bash"]);
  });

  it("returns platform defaults when no shells are specified (linux)", () => {
    const candidates = listLoginShellCandidates("linux");
    expect(candidates).toEqual(["/bin/bash", "/bin/sh"]);
  });

  it("returns an empty array for unsupported platforms", () => {
    const candidates = listLoginShellCandidates("win32");
    expect(candidates).toEqual([]);
  });
});

describe("mergePathEntries", () => {
  it("places shell entries before env entries", () => {
    expect(mergePathEntries("/a:/b", "/b:/c", "darwin")).toBe("/a:/b:/c");
  });

  it("deduplicates entries preserving first occurrence", () => {
    expect(
      mergePathEntries("/usr/bin:/opt/homebrew/bin", "/opt/homebrew/bin:/usr/local/bin", "darwin"),
    ).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  it("returns shell entries alone when envPath is undefined", () => {
    expect(mergePathEntries("/usr/bin:/opt/homebrew/bin", undefined, "darwin")).toBe(
      "/usr/bin:/opt/homebrew/bin",
    );
  });

  it("filters empty segments", () => {
    expect(mergePathEntries("/a::/b", "/c", "linux")).toBe("/a:/b:/c");
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns the PATH value from launchctl on macOS", () => {
    const execCommand = vi.fn(() => "/usr/bin:/bin:/usr/sbin:/sbin\n");
    expect(readPathFromLaunchctl(execCommand as never)).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(execCommand).toHaveBeenCalledWith("launchctl getenv PATH", {
      encoding: "utf8",
      timeout: 3000,
    });
  });

  it("returns undefined when launchctl returns empty", () => {
    const execCommand = vi.fn(() => "   \n");
    expect(readPathFromLaunchctl(execCommand as never)).toBeUndefined();
  });

  it("returns undefined when launchctl throws", () => {
    const execCommand = vi.fn(() => {
      throw new Error("launchctl not available");
    });
    expect(readPathFromLaunchctl(execCommand as never)).toBeUndefined();
  });
});
