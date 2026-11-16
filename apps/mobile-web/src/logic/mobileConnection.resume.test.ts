import { describe, expect, it, vi } from "vitest";

import { installMobileResumeListeners, resolveMobileResumeAction } from "./mobileConnection.resume";

describe("resolveMobileResumeAction", () => {
  it("restarts only a dead transport on a visible page", () => {
    for (const transport of ["closed", "exhausted"] as const) {
      expect(resolveMobileResumeAction({ visible: true, sessionExpired: false, transport })).toBe(
        "restart",
      );
    }
    for (const transport of ["open", "connecting", "retrying", "unpaired"] as const) {
      expect(resolveMobileResumeAction({ visible: true, sessionExpired: false, transport })).toBe(
        "none",
      );
    }
  });

  it("expires a lapsed session instead of reconnecting it", () => {
    expect(
      resolveMobileResumeAction({ visible: true, sessionExpired: true, transport: "closed" }),
    ).toBe("expire");
  });

  it("does nothing while the page is hidden, even with a dead transport", () => {
    expect(
      resolveMobileResumeAction({ visible: false, sessionExpired: true, transport: "closed" }),
    ).toBe("none");
  });
});

describe("installMobileResumeListeners", () => {
  it("routes online, offline, focus and visibility events, and removes every listener", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const handlers = { onOnline: vi.fn(), onOffline: vi.fn(), onResume: vi.fn() };
    const remove = installMobileResumeListeners(
      { window: windowTarget, document: documentTarget },
      handlers,
    );

    windowTarget.dispatchEvent(new Event("online"));
    windowTarget.dispatchEvent(new Event("offline"));
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(handlers.onOnline).toHaveBeenCalledTimes(1);
    expect(handlers.onOffline).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).toHaveBeenCalledTimes(2);

    remove();
    for (const type of ["online", "offline", "focus"]) windowTarget.dispatchEvent(new Event(type));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(handlers.onOnline).toHaveBeenCalledTimes(1);
    expect(handlers.onOffline).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).toHaveBeenCalledTimes(2);
  });
});
