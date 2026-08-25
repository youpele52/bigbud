import { beforeEach, describe, expect, it, vi } from "vitest";

const fromPartitionMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  session: {
    fromPartition: fromPartitionMock,
  },
}));

let browserSessionModule: typeof import("./browserSession");

beforeEach(async () => {
  fromPartitionMock.mockReset();
  vi.resetModules();
  browserSessionModule = await import("./browserSession");
});

describe("browser session", () => {
  it("initializes the dedicated persistent browser partition", () => {
    const { BROWSER_SESSION_PARTITION, initializeBrowserSession } = browserSessionModule;
    const browserSession = {
      id: "browser-session",
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    fromPartitionMock.mockReturnValue(browserSession);

    expect(initializeBrowserSession()).toBe(browserSession);
    expect(fromPartitionMock).toHaveBeenCalledWith(BROWSER_SESSION_PARTITION);
    expect(browserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
  });

  it("initializes the dedicated persistent browser partition only once", () => {
    const { BROWSER_SESSION_PARTITION, initializeBrowserSession } = browserSessionModule;
    const browserSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    fromPartitionMock.mockReturnValue(browserSession);

    expect(initializeBrowserSession()).toBe(browserSession);
    expect(initializeBrowserSession()).toBe(browserSession);

    expect(fromPartitionMock).toHaveBeenCalledOnce();
    expect(fromPartitionMock).toHaveBeenCalledWith(BROWSER_SESSION_PARTITION);
    expect(browserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
  });

  it("denies remote media permission requests in the isolated browser session", () => {
    const { initializeBrowserSession } = browserSessionModule;
    const browserSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    fromPartitionMock.mockReturnValue(browserSession);
    initializeBrowserSession();
    const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
    const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
    const audio = vi.fn();
    const video = vi.fn();
    const audioVideo = vi.fn();

    requestHandler?.({}, "media", audio, { mediaTypes: ["audio"] });
    requestHandler?.({}, "media", video, { mediaTypes: ["video"] });
    requestHandler?.({}, "media", audioVideo, { mediaTypes: ["audio", "video"] });

    expect(audio).toHaveBeenCalledWith(false);
    expect(video).toHaveBeenCalledWith(false);
    expect(audioVideo).toHaveBeenCalledWith(false);
    expect(checkHandler?.({}, "media", "https://example.com", { mediaType: "audio" })).toBe(false);
    expect(checkHandler?.({}, "media", "https://example.com", { mediaType: "video" })).toBe(false);
  });

  it("identifies only guests in the dedicated browser partition", () => {
    const { initializeBrowserSession, isBrowserGuest } = browserSessionModule;
    const browserSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    };
    fromPartitionMock.mockReturnValue(browserSession);
    initializeBrowserSession();

    expect(isBrowserGuest({ session: browserSession } as any)).toBe(true);
    expect(isBrowserGuest({ session: {} } as any)).toBe(false);
  });
});
