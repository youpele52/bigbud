import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

import { makeCertificateChallengeManager } from "./certificateChallengeManager";

function makeWebContents(id: number) {
  const handlers = new Map<string, () => void>();
  return {
    id,
    handlers,
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
  };
}

function challenge(
  manager: ReturnType<typeof makeCertificateChallengeManager>,
  guest: WebContents,
) {
  const event = { preventDefault: vi.fn() };
  const callback = vi.fn();
  manager.handleCertificateError(
    event as never,
    guest,
    "https://africa.h2atlas.de/africa",
    "net::ERR_CERT_DATE_INVALID",
    callback,
    true,
  );
  return { callback, event };
}

describe("certificateChallengeManager", () => {
  afterEach(() => vi.useRealTimers());

  it("allows only the exact pending challenge once", () => {
    const manager = makeCertificateChallengeManager({ generateId: () => "challenge-1" });
    const host = makeWebContents(1);
    const guest = makeWebContents(2);
    manager.attachGuest(host as never, guest as never);
    const pending = challenge(manager, guest as never);

    expect(pending.event.preventDefault).toHaveBeenCalledOnce();
    expect(
      manager.resolve(host as never, {
        challengeId: "wrong",
        guestWebContentsId: 2,
        allow: true,
      }),
    ).toBe(false);
    expect(
      manager.resolve(host as never, {
        challengeId: "challenge-1",
        guestWebContentsId: 2,
        allow: true,
      }),
    ).toBe(true);
    expect(pending.callback).toHaveBeenCalledOnce();
    expect(pending.callback).toHaveBeenCalledWith(true);
    expect(
      manager.resolve(host as never, {
        challengeId: "challenge-1",
        guestWebContentsId: 2,
        allow: true,
      }),
    ).toBe(false);
  });

  it("rejects replacement, timeout, guest destruction, and host close", () => {
    vi.useFakeTimers();
    let sequence = 0;
    const manager = makeCertificateChallengeManager({
      generateId: () => `challenge-${++sequence}`,
    });
    const host = makeWebContents(1);
    const guest = makeWebContents(2);
    manager.attachGuest(host as never, guest as never);

    const replaced = challenge(manager, guest as never).callback;
    const timedOut = challenge(manager, guest as never).callback;
    expect(replaced).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(60_000);
    expect(timedOut).toHaveBeenCalledWith(false);

    const destroyed = challenge(manager, guest as never).callback;
    guest.handlers.get("destroyed")?.();
    expect(destroyed).toHaveBeenCalledWith(false);

    const nextGuest = makeWebContents(3);
    manager.attachGuest(host as never, nextGuest as never);
    const closed = challenge(manager, nextGuest as never).callback;
    manager.closeHost(host as never);
    expect(closed).toHaveBeenCalledWith(false);
  });

  it("rejects non-main-frame and untracked certificate errors by default", () => {
    const manager = makeCertificateChallengeManager();
    const callback = vi.fn();
    manager.handleCertificateError(
      { preventDefault: vi.fn() } as never,
      makeWebContents(9) as never,
      "https://example.com",
      "net::ERR_CERT_INVALID",
      callback,
      false,
    );
    expect(callback).toHaveBeenCalledWith(false);
  });
});
