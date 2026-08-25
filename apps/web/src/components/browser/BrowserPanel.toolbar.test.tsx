import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserToolbar } from "./BrowserPanel.toolbar";

function renderToolbar(options?: {
  inputUrl?: string;
  title?: string;
  faviconUrl?: string | null;
  annotationActive?: boolean;
  loading?: boolean;
  canStopLoading?: boolean;
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
      onStopLoading={() => {}}
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
      loading={options?.loading ?? false}
      canStopLoading={options?.canStopLoading ?? true}
    />,
  );
}

describe("BrowserToolbar page identity", () => {
  it("shows a centered page title without duplicating the tab favicon", () => {
    const markup = renderToolbar();

    expect(markup).toContain("Nairaland Forum");
    expect(markup).not.toContain('src="https://nairaland.com/favicon.ico"');
    expect(markup).toContain("justify-center");
    expect(markup).toContain("text-left");
    expect(markup).toContain("border-transparent bg-transparent");
    expect(markup).toContain("text-transparent");
    expect(markup).toContain("placeholder:text-transparent");
  });

  it("falls back to the hostname when the page title is missing", () => {
    const markup = renderToolbar({ title: "", faviconUrl: null });

    expect(markup).toContain("nairaland.com");
    expect(markup).not.toContain("<img");
  });

  it("hides the external-browser action until the address bar is hovered", () => {
    const markup = renderToolbar();

    expect(markup).not.toContain("Open in default browser");
    expect(markup).not.toContain("absolute right-1 top-1/2");
  });

  it("keeps an empty address bar expanded and ready to edit", () => {
    const markup = renderToolbar({ inputUrl: "", title: "", faviconUrl: null });

    expect(markup).toContain("border-input bg-background");
    expect(markup).toContain('placeholder="Enter a URL or search"');
    expect(markup).not.toContain("text-transparent caret-transparent");
  });

  it("renders the annotation button in its active info state", () => {
    const markup = renderToolbar({ annotationActive: true });

    expect(markup).toContain("text-info-foreground");
    expect(markup).toContain('data-pressed="true"');
  });

  it("replaces reload with stop loading only while a page is loading", () => {
    expect(renderToolbar({ loading: true })).toContain('aria-label="Stop loading"');
    expect(renderToolbar()).toContain('aria-label="Reload"');
  });

  it("keeps reload available when loading cannot be stopped", () => {
    expect(renderToolbar({ loading: true, canStopLoading: false })).toContain(
      'aria-label="Reload"',
    );
  });
});
