import { describe, expect, it, vi } from "vitest";

import {
  makeCliProxyCommandRunner,
  makeCliProxyLifecycle,
  selectCliProxyLaunchStrategy,
} from "./Lifecycle.ts";
import type { CliProxyCommandResult } from "../../Services/CliProxy/Lifecycle.ts";

describe("selectCliProxyLaunchStrategy", () => {
  it("only starts supported installed service types", () => {
    expect(
      selectCliProxyLaunchStrategy({
        platform: "darwin",
        hasHomebrewService: true,
        hasSystemdUserUnit: false,
        hasDirectBinary: true,
      }),
    ).toBe("homebrew");
    expect(
      selectCliProxyLaunchStrategy({
        platform: "linux",
        hasHomebrewService: false,
        hasSystemdUserUnit: true,
        hasDirectBinary: true,
      }),
    ).toBe("systemd-user");
    expect(
      selectCliProxyLaunchStrategy({
        platform: "win32",
        hasHomebrewService: false,
        hasSystemdUserUnit: false,
        hasDirectBinary: true,
      }),
    ).toBe("direct");
  });

  it("does not start unknown macOS or Linux installations", () => {
    expect(
      selectCliProxyLaunchStrategy({
        platform: "darwin",
        hasHomebrewService: false,
        hasSystemdUserUnit: false,
        hasDirectBinary: false,
      }),
    ).toBe("none");
  });
});

describe("makeCliProxyCommandRunner", () => {
  it("classifies timeouts, missing commands, and bounded failures", async () => {
    const timeout = makeCliProxyCommandRunner(async () => ({
      stdout: "",
      stderr: "",
      code: null,
      signal: "SIGTERM",
      timedOut: true,
    }));
    const missing = makeCliProxyCommandRunner(async () => {
      throw new Error("Command not found: cli-proxy-api");
    });
    const failed = makeCliProxyCommandRunner(async () => ({
      stdout: "",
      stderr: "failed detail",
      code: 1,
      signal: null,
      timedOut: false,
    }));

    await expect(timeout("cli-proxy-api", ["--version"])).resolves.toEqual({
      _tag: "timeout",
      command: "cli-proxy-api",
    });
    await expect(missing("cli-proxy-api", ["--version"])).resolves.toEqual({
      _tag: "missing",
      command: "cli-proxy-api",
    });
    await expect(failed("cli-proxy-api", ["--version"])).resolves.toEqual({
      _tag: "failed",
      command: "cli-proxy-api",
      detail: "failed detail",
    });
  });
});

describe("makeCliProxyLifecycle", () => {
  it("single-flights activation and clears the flight after completion", async () => {
    const runner = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "brew" && args[0] === "list") return { _tag: "available" } as const;
      return { _tag: "missing", command } as const;
    });
    const lifecycle = makeCliProxyLifecycle({ commandRunner: runner, platform: "darwin" });

    const first = lifecycle.activate({ configPath: "/tmp/config.yaml" });
    const second = lifecycle.activate({ configPath: "/tmp/config.yaml" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        _tag: "unavailable",
        strategy: "none",
        detail: expect.stringContaining("cannot be verified"),
      },
      {
        _tag: "unavailable",
        strategy: "none",
        detail: expect.stringContaining("cannot be verified"),
      },
    ]);
    expect(runner.mock.calls.filter((call) => call[1][0] === "services")).toHaveLength(0);

    await lifecycle.activate({ configPath: "/tmp/config.yaml" });
    expect(runner.mock.calls.filter((call) => call[1][0] === "services")).toHaveLength(0);
  });

  it("tracks direct child ownership and refuses a second config", async () => {
    const child = {
      exitCode: null,
      pid: undefined,
      once: vi.fn(),
      kill: vi.fn(),
    };
    const runner = vi.fn(
      async (command: string): Promise<CliProxyCommandResult> =>
        command === "cli-proxy-api" ? { _tag: "available" } : { _tag: "missing", command },
    );
    const spawnDirect = vi.fn(() => child as never);
    const lifecycle = makeCliProxyLifecycle({
      commandRunner: runner,
      platform: "darwin",
      spawnDirect,
    });

    await expect(lifecycle.activate({ configPath: "/tmp/one.yaml" })).resolves.toEqual({
      _tag: "started",
      strategy: "direct",
    });
    await expect(lifecycle.activate({ configPath: "/tmp/one.yaml" })).resolves.toEqual({
      _tag: "started",
      strategy: "direct",
    });
    await expect(lifecycle.activate({ configPath: "/tmp/two.yaml" })).resolves.toMatchObject({
      _tag: "unavailable",
      detail: expect.stringContaining("/tmp/one.yaml"),
    });
    expect(spawnDirect).toHaveBeenCalledOnce();
    lifecycle.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not report a direct process that exits immediately as started", async () => {
    const child = {
      exitCode: 1,
      pid: undefined,
      once: vi.fn(),
      kill: vi.fn(),
      stderr: undefined,
      stdout: undefined,
    };
    const runner = vi.fn(
      async (command: string): Promise<CliProxyCommandResult> =>
        command === "cli-proxy-api" ? { _tag: "available" } : { _tag: "missing", command },
    );
    const lifecycle = makeCliProxyLifecycle({
      commandRunner: runner,
      platform: "darwin",
      spawnDirect: vi.fn(() => child as never),
    });

    await expect(lifecycle.activate({ configPath: "/tmp/config.yaml" })).resolves.toMatchObject({
      _tag: "unavailable",
      detail: expect.stringContaining("exited before startup could be verified"),
    });
  });

  it("returns unavailable when closed during direct activation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = vi.fn(async (command: string, args: ReadonlyArray<string>) => {
      if (command === "cli-proxy-api" && args[0] === "--version") {
        await gate;
        return { _tag: "available" } as const;
      }
      return command === "cli-proxy-api"
        ? ({ _tag: "available" } as const)
        : ({ _tag: "missing", command } as const);
    });
    const lifecycle = makeCliProxyLifecycle({ commandRunner: runner, platform: "darwin" });
    const activation = lifecycle.activate({ configPath: "/tmp/config.yaml" });
    lifecycle.close();
    release?.();

    await expect(activation).resolves.toMatchObject({
      _tag: "unavailable",
      detail: expect.stringContaining("closed during activation"),
    });
  });
});
