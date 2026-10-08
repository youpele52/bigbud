import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ metrics: vi.fn(), backend: null as ChildProcess | null }));
vi.mock("electron", () => ({ app: { getAppMetrics: mocks.metrics } }));
vi.mock("../backend/backendManager", () => ({
  get backendProcess() {
    return mocks.backend;
  },
}));
import { getDesktopMonitorRoots, ownedChildRoot } from "./ownership";

const child = (pid: number) => ({ pid, exitCode: null, killed: false }) as ChildProcess;
beforeEach(() => {
  mocks.metrics.mockReturnValue([]);
  mocks.backend = null;
});

describe("desktop-owned monitor process registry", () => {
  it("registers Electron identities, backend handles and the native monitor, deduplicated", () => {
    mocks.metrics.mockReturnValue([
      { pid: process.pid, creationTime: 1234000 },
      { pid: 42, creationTime: 5678000 },
    ]);
    mocks.backend = child(81);
    const roots = getDesktopMonitorRoots(child(91));
    expect(roots).toContainEqual({
      pid: 42,
      identity: "electron:42:5678000",
      startTimeSeconds: 5678,
      role: "desktop",
    });
    expect(roots.find((r) => r.pid === 81)?.role).toBe("backend");
    expect(roots.find((r) => r.pid === 91)?.role).toBe("native");
    expect(new Set(roots.map((r) => r.pid)).size).toBe(roots.length);
  });
  it("distinguishes restarted children even when their PIDs are reused", () => {
    const first = child(42);
    expect(ownedChildRoot(first, "backend")?.identity).toBe(
      ownedChildRoot(first, "backend")?.identity,
    );
    expect(ownedChildRoot(child(42), "backend")?.identity).not.toBe(
      ownedChildRoot(first, "backend")?.identity,
    );
    Object.assign(first, { killed: true });
    expect(ownedChildRoot(first, "backend")).toBeNull();
    expect(ownedChildRoot(null, "native")).toBeNull();
  });
  it("bounds the registry rather than silently dropping core processes", () => {
    mocks.metrics.mockReturnValue(
      Array.from({ length: 129 }, (_, index) => ({ pid: index + 1, creationTime: 1000 })),
    );
    expect(() => getDesktopMonitorRoots(null)).toThrow("limit");
  });
});
