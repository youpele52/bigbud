import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SystemMonitorPage } from "./SystemMonitorPage";

vi.mock("~/hooks/usePageTitle", () => ({ usePageTitle: vi.fn() }));
vi.mock("../standalone/StandaloneChatPageShell", () => ({
  StandaloneChatPageShell: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./SystemMonitorHostView", () => ({ SystemMonitorHostView: () => "host-resource-view" }));
vi.mock("./BigbudResourceView", () => ({
  BigbudResourceView: ({ large }: { large: boolean }) =>
    large ? "large-app-resource-view" : "compact-app-resource-view",
}));

describe("SystemMonitorPage scopes", () => {
  it("preserves host details in the System scope", () => {
    const markup = renderToStaticMarkup(
      <SystemMonitorPage scope="system" onScopeChange={() => undefined} />,
    );
    expect(markup).toContain("host-resource-view");
    expect(markup).not.toContain("large-app-resource-view");
    expect(markup).toContain('data-variant="toolbar"');
  });
  it("reuses the app view with larger history charts in the detailed bigbud scope", () => {
    const markup = renderToStaticMarkup(
      <SystemMonitorPage scope="bigbud" onScopeChange={() => undefined} />,
    );
    expect(markup).toContain("large-app-resource-view");
    expect(markup).not.toContain("host-resource-view");
  });
});
