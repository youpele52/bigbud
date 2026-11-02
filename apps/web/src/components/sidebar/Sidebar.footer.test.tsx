import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockIsElectron = true;
let mockStageLabel: string | null = "Dev";

vi.mock("../../config/branding", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/branding")>("../../config/branding");
  return {
    ...actual,
    get APP_STAGE_LABEL() {
      return mockStageLabel;
    },
  };
});

vi.mock("../../config/env", async () => {
  const actual = await vi.importActual<typeof import("../../config/env")>("../../config/env");
  return {
    ...actual,
    get isElectron() {
      return mockIsElectron;
    },
  };
});
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
  Link: ({ children, ...props }: { children: React.ReactNode; "aria-label"?: string }) => (
    <a aria-label={props["aria-label"]}>{children}</a>
  ),
}));
vi.mock("./SidebarUpdatePill", () => ({ SidebarUpdatePill: () => null }));
vi.mock("./SidebarCopilotRuntime", () => ({ SidebarCopilotRuntime: () => null }));
vi.mock("./SidebarHelpMenu", () => ({ SidebarHelpMenu: () => <button aria-label="Help" /> }));

import { SidebarProvider } from "../ui/sidebar";
import { SidebarFooterBar } from "./Sidebar.footer";

const renderFooter = () =>
  renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <SidebarFooterBar />
    </SidebarProvider>,
  );

describe("SidebarFooterBar", () => {
  afterEach(() => {
    mockIsElectron = true;
    mockStageLabel = "Dev";
  });

  it("centres a smaller wordmark between Settings and Help on desktop", () => {
    const markup = renderFooter();
    const brand = markup.indexOf('aria-label="Go to threads"');
    expect(markup.indexOf("Settings")).toBeLessThan(brand);
    expect(brand).toBeLessThan(markup.indexOf('aria-label="Help"'));
    expect(markup).toContain("grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]");
    expect(markup).toContain("w-auto shrink-0 h-3");
  });

  it("shows neither wordmark nor badge in a stable desktop release", () => {
    mockStageLabel = null;
    const markup = renderFooter();
    expect(markup).not.toContain('aria-label="Go to threads"');
    expect(markup).not.toContain("grid-cols-[minmax(max-content,1fr)");
    expect(markup).toContain("Settings");
    expect(markup).toContain('aria-label="Help"');
  });

  it("leaves the wordmark to the header on the web", () => {
    mockIsElectron = false;
    const markup = renderFooter();
    expect(markup).not.toContain('aria-label="Go to threads"');
    expect(markup).toContain("Settings");
  });
});
