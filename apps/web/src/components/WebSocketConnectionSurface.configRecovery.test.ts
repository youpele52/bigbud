import { describe, expect, it, vi } from "vitest";

import { getServerConfigReadiness } from "../rpc/serverConfigReadiness";
import {
  syncConfigRecoveryToast,
  type ConfigRecoveryToast,
} from "./WebSocketConnectionSurface.configRecovery";

describe("cached config recovery notice", () => {
  it("keeps one warning through explicit retry and closes only when updates are live", () => {
    const manager = {
      add: vi.fn((_toast: ConfigRecoveryToast) => "config-notice"),
      update: vi.fn(),
      close: vi.fn(),
    };
    const retry = vi.fn();
    const readiness = {
      ...getServerConfigReadiness(),
      hasSnapshot: true,
      stream: "exhausted" as const,
    };
    const id = syncConfigRecoveryToast(manager, null, readiness, true, retry);
    expect(manager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Configuration updates paused",
        actionProps: { children: "Retry configuration", onClick: retry },
      }),
    );
    manager.add.mock.calls[0]![0].actionProps.onClick();
    expect(retry).toHaveBeenCalledOnce();
    expect(
      syncConfigRecoveryToast(manager, id, { ...readiness, stream: "pending" }, true, retry),
    ).toBe(id);
    expect(manager.update).toHaveBeenCalledWith(id, expect.objectContaining({ type: "info" }));
    expect(manager.close).not.toHaveBeenCalled();
    expect(
      syncConfigRecoveryToast(manager, id, { ...readiness, stream: "live" }, true, retry),
    ).toBeNull();
    expect(manager.close).toHaveBeenCalledOnce();
    expect(manager.add).toHaveBeenCalledOnce();
  });

  it("offers physical reconnect when disconnected and does not announce initial pending state", () => {
    const manager = {
      add: vi.fn((_toast: ConfigRecoveryToast) => "config-notice"),
      update: vi.fn(),
      close: vi.fn(),
    };
    const readiness = { ...getServerConfigReadiness(), hasSnapshot: true };
    expect(
      syncConfigRecoveryToast(manager, null, { ...readiness, stream: "pending" }, false, vi.fn()),
    ).toBeNull();
    syncConfigRecoveryToast(manager, null, { ...readiness, stream: "exhausted" }, false, vi.fn());
    expect(manager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        actionProps: expect.objectContaining({ children: "Reconnect" }),
      }),
    );
  });
});
