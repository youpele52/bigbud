import { describe, expect, it } from "vitest";

import {
  formatMissingOpencodeBinaryDetail,
  makeOpencodeServerManager,
  readManagedServerListeningUrl,
} from "./ServerManager.ts";

describe("OpencodeServerManager lifecycle", () => {
  it("keeps a successfully started server warm until manager shutdown", async () => {
    let starts = 0;
    let closes = 0;
    const manager = makeOpencodeServerManager({
      startServer: async () => {
        starts += 1;
        return {
          url: "http://127.0.0.1:4321",
          close() {
            closes += 1;
          },
        };
      },
    });

    const first = await manager.acquire();
    first.release();
    const second = await manager.acquire();
    second.release();

    expect(starts).toBe(1);
    expect(closes).toBe(0);

    await manager.closeAll();
    expect(closes).toBe(1);
    await expect(manager.acquire()).rejects.toThrow("shutting down");
  });

  it("shares one in-flight start across concurrent acquisitions", async () => {
    let resolveStart: ((server: { readonly url: string; close(): void }) => void) | undefined;
    let starts = 0;
    let closes = 0;
    const manager = makeOpencodeServerManager({
      startServer: async () => {
        starts += 1;
        return await new Promise((resolve) => {
          resolveStart = resolve;
        });
      },
    });

    const firstAcquire = manager.acquire();
    const secondAcquire = manager.acquire();
    await Promise.resolve();
    expect(starts).toBe(1);

    resolveStart?.({
      url: "http://127.0.0.1:4321",
      close() {
        closes += 1;
      },
    });
    const [first, second] = await Promise.all([firstAcquire, secondAcquire]);
    first.release();
    second.release();

    expect(starts).toBe(1);
    expect(closes).toBe(0);
    await manager.closeAll();
    expect(closes).toBe(1);
  });

  it("discards an invalidated server so recovery starts a fresh process", async () => {
    let starts = 0;
    let closes = 0;
    const manager = makeOpencodeServerManager({
      startServer: async () => {
        starts += 1;
        return {
          url: `http://127.0.0.1:${4320 + starts}`,
          close() {
            closes += 1;
          },
        };
      },
    });

    const failedProbe = await manager.acquire();
    failedProbe.invalidate();
    const recoveredProbe = await manager.acquire();

    expect(recoveredProbe.url).not.toBe(failedProbe.url);
    expect(starts).toBe(2);
    expect(closes).toBe(1);
    recoveredProbe.release();
    await manager.closeAll();
    expect(closes).toBe(2);
  });

  it("restarts a warm server whose process exited", async () => {
    let starts = 0;
    let closes = 0;
    let running = true;
    const manager = makeOpencodeServerManager({
      startServer: async () => {
        starts += 1;
        running = true;
        return {
          url: `http://127.0.0.1:${4320 + starts}`,
          isRunning: () => running,
          close() {
            closes += 1;
          },
        };
      },
    });

    const first = await manager.acquire();
    first.release();
    running = false;
    const second = await manager.acquire();

    expect(second.url).not.toBe(first.url);
    expect(starts).toBe(2);
    expect(closes).toBe(1);
    second.release();
    await manager.closeAll();
    expect(closes).toBe(2);
  });

  it("retires the prior warm server when its configured binary changes", async () => {
    let starts = 0;
    let closes = 0;
    const manager = makeOpencodeServerManager({
      startServer: async ({ binaryPath }) => {
        starts += 1;
        return {
          url: `http://127.0.0.1/${binaryPath}`,
          close() {
            closes += 1;
          },
        };
      },
    });

    const original = await manager.acquire({ binaryPath: "opencode-old" });
    const replacement = await manager.acquire({ binaryPath: "opencode-new" });
    expect(starts).toBe(2);
    expect(closes).toBe(0);

    original.release();
    expect(closes).toBe(1);
    replacement.release();
    await manager.closeAll();
    expect(closes).toBe(2);
  });

  it("waits for warm provider processes to close during manager shutdown", async () => {
    let resolveClose: (() => void) | undefined;
    let shutdownCompleted = false;
    const manager = makeOpencodeServerManager({
      startServer: async () => ({
        url: "http://127.0.0.1:4321",
        close: async () =>
          await new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      }),
    });

    const handle = await manager.acquire();
    handle.release();
    const shutdown = manager.closeAll().then(() => {
      shutdownCompleted = true;
    });
    await Promise.resolve();
    expect(shutdownCompleted).toBe(false);

    resolveClose?.();
    await shutdown;
    expect(shutdownCompleted).toBe(true);
  });
});

describe("readManagedServerListeningUrl", () => {
  it("reads OpenCode and KiloCode server startup lines", () => {
    expect(
      readManagedServerListeningUrl("opencode server listening on http://127.0.0.1:4321"),
    ).toBe("http://127.0.0.1:4321");
    expect(readManagedServerListeningUrl("kilo server listening on http://127.0.0.1:4322")).toBe(
      "http://127.0.0.1:4322",
    );
  });

  it("ignores unrelated output", () => {
    expect(readManagedServerListeningUrl("Warning: KILO_SERVER_PASSWORD is not set")).toBeNull();
  });
});

describe("formatMissingOpencodeBinaryDetail", () => {
  it("formats a local PATH-missing OpenCode binary error", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        binaryPath: "opencode",
        executionTargetId: "local",
        detail: "OpenCode server exited with code 127.\nsh: 1: exec: opencode: not found",
      }),
    ).toBe(
      "OpenCode CLI is not installed or not available on PATH. Install 'opencode' locally or set Providers > OpenCode > Binary path to the local executable path.",
    );
  });

  it("formats a remote custom-binary missing error", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        binaryPath: "/opt/opencode/bin/opencode",
        executionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
        detail:
          "OpenCode server exited with code 127.\nsh: 1: exec: /opt/opencode/bin/opencode: not found",
      }),
    ).toBe(
      "Remote OpenCode binary was not found at '/opt/opencode/bin/opencode'. Update Providers > OpenCode > Binary path to the correct remote executable path.",
    );
  });

  it("ignores unrelated startup errors", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        binaryPath: "opencode",
        executionTargetId: "local",
        detail: "OpenCode server exited with code 1.\npermission denied",
      }),
    ).toBeNull();
  });

  it("formats a local PATH-missing KiloCode binary error", () => {
    expect(
      formatMissingOpencodeBinaryDetail({
        provider: "kilocode",
        binaryPath: "kilo",
        executionTargetId: "local",
        detail: "KiloCode server exited with code 127.\nsh: 1: exec: kilo: not found",
      }),
    ).toBe(
      "KiloCode CLI is not installed or not available on PATH. Install 'kilo' locally or set Providers > KiloCode > Binary path to the local executable path.",
    );
  });
});
