import { describe, expect, it, vi } from "vitest";

import { registerServerLifecycleDiagnostics } from "./serverLifecycleDiagnostics.ts";

describe("registerServerLifecycleDiagnostics", () => {
  it("registers monitor-only exception and exit diagnostics", () => {
    const on = vi.fn();
    const log = vi.fn();
    registerServerLifecycleDiagnostics({ pid: 42, cwd: () => "/workspace", on }, log);
    expect(log).toHaveBeenCalledWith("bigbud server startup", expect.objectContaining({ pid: 42 }));
    expect(on).toHaveBeenCalledWith("uncaughtExceptionMonitor", expect.any(Function));
    expect(on).toHaveBeenCalledWith("exit", expect.any(Function));
  });
});
