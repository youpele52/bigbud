import { describe, expect, it, vi } from "vitest";
import { terminalPidIsOnBackendHost } from "./OwnedPtyRuntime.identity.ts";

describe("terminal PID inspection namespace", () => {
  it("keeps normal local processes local and refuses to infer a remote PID's host from the UI label", () => {
    expect(terminalPidIsOnBackendHost(undefined, "local")).toBe(true);
    expect(terminalPidIsOnBackendHost(undefined, "local", { pidDomain: "remote" })).toBe(false);
    expect(terminalPidIsOnBackendHost(undefined, "ssh:host=example", { pidDomain: "remote" })).toBe(
      false,
    );
  });

  it("permits local Rust PID inspection only through positive backend-host runtime evidence", () => {
    const resolve = vi.fn((target: string) =>
      target === "local" ? { pidNamespace: "backend-host" as const } : undefined,
    );
    expect(
      terminalPidIsOnBackendHost({ ownedRuntimeForTarget: resolve }, "local", {
        pidDomain: "remote",
      }),
    ).toBe(true);
    expect(resolve).toHaveBeenCalledExactlyOnceWith("local");
    expect(
      terminalPidIsOnBackendHost(
        { ownedRuntimeForTarget: () => ({ pidNamespace: "ssh-host" }) },
        "local",
        { pidDomain: "remote" },
      ),
    ).toBe(false);
  });
});
