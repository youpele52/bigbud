import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CenteredStatus } from "./CenteredStatus";
import { isLoadingStatus } from "./CenteredStatus.logic";

describe("centered activity states", () => {
  it("uses a small decorative breathing logo with reduced-motion support during active work", () => {
    const markup = renderToStaticMarkup(<CenteredStatus loading>Warming up</CenteredStatus>);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("items-center justify-center");
    expect(markup).toContain("text-center");
    expect(markup).toContain("h-4 animate-breathe");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).toContain("text-muted-foreground/40");
    expect(markup).toContain("normal-case");
    expect(markup).not.toContain("text-info");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("bigbud-logo-title");
    expect(markup).toContain("Warming up");
    expect(markup).not.toContain("lowercase");
    expect(markup).not.toContain("text-left");
  });
  it.each([
    ["warming", "Warming"],
    ["waiting for history", "Waiting for history"],
    ["waiting for I/O history", "Waiting for I/O history"],
  ])("uses sentence case for %s without capitalizing each word", (label, expected) => {
    const markup = renderToStaticMarkup(
      <CenteredStatus loading className="capitalize">
        {label}
      </CenteredStatus>,
    );
    expect(markup).toContain(`>${expected}</div>`);
    expect(markup).toContain("normal-case");
  });
  it("keeps failures centered and static", () => {
    const markup = renderToStaticMarkup(
      <CenteredStatus role="alert">Measurements unavailable</CenteredStatus>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("text-center");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("animate-");
  });
  it.each([
    "loading",
    "warming",
    "Warming_up",
    "connecting",
    "retrying",
    "pending",
    "refreshing",
    "building",
    "waiting",
  ])("recognizes %s as active work", (status) => expect(isLoadingStatus(status)).toBe(true));
  it.each(["ready", "unavailable", "unsupported", "failed", "error", "stale", "Loading failed"])(
    "does not animate %s",
    (status) => expect(isLoadingStatus(status)).toBe(false),
  );
});
