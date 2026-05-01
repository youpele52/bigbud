import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserToolbar } from "./BrowserPanel.toolbar";

function renderToolbar(options?: {
  inputUrl?: string;
  title?: string;
  faviconUrl?: string | null;
}) {
  return renderToStaticMarkup(
    <BrowserToolbar
      inputUrl={options?.inputUrl ?? "https://nairaland.com/"}
      setInputUrl={() => {}}
      onNavigate={() => {}}
      onSelectHistoryUrl={() => {}}
      onCancelEmptyUrlEdit={() => {}}
      onClose={() => {}}
      canGoBack={false}
      canGoForward={false}
      onGoBack={() => {}}
      onGoForward={() => {}}
      onReload={() => {}}
      onAnnotate={() => {}}
      pageMetadata={{
        title: options?.title ?? "Nairaland Forum",
        faviconUrl:
          options && "faviconUrl" in options
            ? (options.faviconUrl ?? null)
            : "https://nairaland.com/favicon.ico",
      }}
      historyUrls={[]}
    />,
  );
}

describe("BrowserToolbar page identity", () => {
  it("shows favicon and page title in the idle address bar", () => {
    const markup = renderToolbar();

    expect(markup).toContain("Nairaland Forum");
    expect(markup).toContain('src="https://nairaland.com/favicon.ico"');
    expect(markup).toContain("text-transparent");
    expect(markup).toContain("placeholder:text-transparent");
  });

  it("falls back to the hostname when the page title is missing", () => {
    const markup = renderToolbar({ title: "", faviconUrl: null });

    expect(markup).toContain("nairaland.com");
    expect(markup).not.toContain("<img");
  });
});
