import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserToolbar } from "./BrowserPanel.toolbar";

function renderToolbar(options?: {
  inputUrl?: string;
  title?: string;
  faviconUrl?: string | null;
  annotationActive?: boolean;
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
      onOpenInExternalBrowser={() => {}}
      onAnnotate={() => {}}
      annotationActive={options?.annotationActive ?? false}
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

  it("renders the external-browser action inside the address bar", () => {
    const markup = renderToolbar();

    expect(markup).toContain("Open in default browser");
    expect(markup).toContain("absolute right-1 top-1/2");
  });

  it("renders the annotation button in its active info state", () => {
    const markup = renderToolbar({ annotationActive: true });

    expect(markup).toContain("text-info-foreground");
    expect(markup).toContain('data-pressed="true"');
  });
});
