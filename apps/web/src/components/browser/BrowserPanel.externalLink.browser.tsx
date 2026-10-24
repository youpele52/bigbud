import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import { BrowserExternalLink } from "./BrowserPanel.externalLink";
import { BrowserPanelNavigationErrorPage } from "./BrowserPanel.navigationErrorPage";

const originalBridge = window.desktopBridge;
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
});

describe("external browser fallback", () => {
  it.each(["javascript:alert(1)", "file:///secret", "bad-url"])(
    "never renders an unsafe link for %s",
    async (url) => {
      const host = document.createElement("div");
      document.body.append(host);
      const screen = await render(<BrowserExternalLink url={url} />, { container: host });
      try {
        expect(host.querySelector("a")).toBeNull();
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );

  it("uses the desktop bridge only on an explicit click and reports failure", async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error("no browser"));
    window.desktopBridge = { openExternal } as unknown as DesktopBridge;
    const screen = await render(<BrowserExternalLink url="https://site.example/login" />);
    try {
      expect(openExternal).not.toHaveBeenCalled();
      await screen.getByRole("link", { name: "Open in default browser" }).click();
      expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://site.example/login");
      await expect.element(screen.getByRole("alert")).toHaveTextContent("Copy the address");
    } finally {
      await screen.unmount();
    }
  });

  it("provides a noopener web link and exposes the failing URL, not the current tab URL", async () => {
    delete window.desktopBridge;
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <BrowserPanelNavigationErrorPage
        failure={{
          errorCode: -105,
          errorDescription: "ERR_NAME_NOT_RESOLVED",
          validatedURL: "https://failed.example/",
        }}
        certificateChallenge={null}
        agentControlled={false}
        onReload={() => undefined}
      />,
      { container: host },
    );
    try {
      const link = host.querySelector("a");
      expect(link?.href).toBe("https://failed.example/");
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toBe("noopener noreferrer");
      await screen.rerender(
        <BrowserPanelNavigationErrorPage
          failure={{
            errorCode: -105,
            errorDescription: "ERR_NAME_NOT_RESOLVED",
            validatedURL: "https://failed.example/",
          }}
          certificateChallenge={null}
          agentControlled={true}
          onReload={() => undefined}
        />,
      );
      expect(host.querySelector("a")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
