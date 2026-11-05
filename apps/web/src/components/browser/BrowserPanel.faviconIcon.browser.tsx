import "../../index.css";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { BrowserFaviconIcon } from "./BrowserPanel.faviconIcon";

describe("browser favicon fallback", () => {
  it("shows a globe until load succeeds, falls back on failure, and recovers for a new source", async () => {
    const iconUrl = `${window.location.origin}/favicon-16x16.png`;
    const screen = await render(<BrowserFaviconIcon faviconUrl={iconUrl} />);
    try {
      const image = document.querySelector("img")!;
      expect(image.referrerPolicy).toBe("no-referrer");
      image.dispatchEvent(new Event("load"));
      await expect.poll(() => document.querySelector(".lucide-globe")).toBeNull();
      image.dispatchEvent(new Event("error"));
      await expect.poll(() => document.querySelector(".lucide-globe")).not.toBeNull();
      expect(document.querySelector("img")).toBeNull();
      await screen.rerender(<BrowserFaviconIcon faviconUrl={`${iconUrl}?new-source`} />);
      const nextImage = document.querySelector("img")!;
      expect(nextImage).not.toBe(image);
      nextImage.dispatchEvent(new Event("load"));
      await expect.poll(() => document.querySelector(".lucide-globe")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("never renders an unsafe image source", async () => {
    const screen = await render(<BrowserFaviconIcon faviconUrl="javascript:alert(1)" />);
    try {
      expect(document.querySelector("img")).toBeNull();
      expect(document.querySelector(".lucide-globe")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
