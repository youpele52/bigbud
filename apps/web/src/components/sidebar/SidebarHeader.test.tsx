import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

let mockIsElectron = true;

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
  Link: ({ children, ...props }: { children: React.ReactNode; "aria-label"?: string }) => (
    <a aria-label={props["aria-label"]}>{children}</a>
  ),
}));

import { SidebarProvider } from "../ui/sidebar";
import { SidebarAppHeader } from "./SidebarHeader";

const renderHeader = () =>
  renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <SidebarAppHeader />
    </SidebarProvider>,
  );

describe("SidebarAppHeader", () => {
  afterEach(() => {
    mockIsElectron = true;
  });

  it("is only the draggable title bar on desktop; the wordmark lives in the footer", () => {
    const markup = renderHeader();
    expect(markup).toContain("drag-region");
    expect(markup).not.toContain('aria-label="Go to threads"');
  });

  it("keeps the wordmark in the header on the web", () => {
    mockIsElectron = false;
    expect(renderHeader()).toContain('aria-label="Go to threads"');
  });
});
