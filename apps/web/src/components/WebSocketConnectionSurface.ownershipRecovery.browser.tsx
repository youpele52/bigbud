import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";
import { OwnershipRecovery } from "./WebSocketConnectionSurface.ownershipRecovery";

const original = window.desktopBridge;
afterEach(() => {
  if (original) window.desktopBridge = original;
  else delete window.desktopBridge;
});
const startup: DesktopBackendStartupState = {
  generation: 7,
  startedAt: 0,
  status: "failed",
  failureReason: "state_directory_in_use",
};

describe("ownership recovery action", () => {
  it("checks eligibility and only offers an available action with an interruption warning", async () => {
    const check = vi.fn(async () => {});
    const recover = vi.fn(async () => {});
    window.desktopBridge = {
      checkBackendOwnership: check,
      recoverBackendOwnership: recover,
    } as unknown as DesktopBridge;
    const screen = await render(
      <OwnershipRecovery startup={{ ...startup, ownershipRecovery: { phase: "available" } }} />,
    );
    await expect.element(screen.getByText(/will interrupt its active work/)).toBeVisible();
    await screen.getByRole("button", { name: "Stop other backend and retry" }).click();
    expect(recover).toHaveBeenCalledExactlyOnceWith(7);
    expect(check).toHaveBeenCalledExactlyOnceWith(7);
  });
  it("disables the action during main-owned progress", async () => {
    window.desktopBridge = { recoverBackendOwnership: vi.fn() } as unknown as DesktopBridge;
    const screen = await render(
      <OwnershipRecovery startup={{ ...startup, ownershipRecovery: { phase: "stopping" } }} />,
    );
    await expect.element(screen.getByText("Stopping other backend…")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Please wait…" })).toBeDisabled();
  });
  it.each(["owner_unverified", "unsupported_platform", "shutdown_timed_out"] as const)(
    "shows manual instructions without a destructive action for %s",
    async (error) => {
      window.desktopBridge = { recoverBackendOwnership: vi.fn() } as unknown as DesktopBridge;
      const screen = await render(
        <OwnershipRecovery
          startup={{ ...startup, ownershipRecovery: { phase: "failed", error } }}
        />,
      );
      await expect.element(screen.getByText(/Close the other bigbud app or backend/)).toBeVisible();
      await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
    },
  );
  it("never offers immediate takeover to the yielding desktop", async () => {
    const check = vi.fn(async () => {});
    window.desktopBridge = {
      checkBackendOwnership: check,
      recoverBackendOwnership: vi.fn(),
    } as unknown as DesktopBridge;
    const screen = await render(
      <OwnershipRecovery startup={{ ...startup, ownershipRecovery: { phase: "yielded" } }} />,
    );
    await expect.element(screen.getByText(/another bigbud window could use/)).toBeVisible();
    await expect
      .element(screen.getByText(/backend may still be running or stopping/))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("This backend was stopped");
    expect(check).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  });
});
