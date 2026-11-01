import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";

vi.mock("~/config/env", async () => {
  const actual = await vi.importActual<typeof import("~/config/env")>("~/config/env");
  return { ...actual, isElectron: true };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../sidebar/Sidebar", () => ({ default: () => <nav data-thread-sidebar /> }));
vi.mock("../../rpc/serverState", async () => {
  const actual =
    await vi.importActual<typeof import("../../rpc/serverState")>("../../rpc/serverState");
  return { ...actual, useServerKeybindings: () => DEFAULT_BINDINGS };
});

import { AppSidebarLayout } from "./AppSidebarLayout";

describe("AppSidebarLayout on desktop", () => {
  it("renders the window sidebar toggle after the page so its drag region cannot cover it", () => {
    const markup = renderToStaticMarkup(
      <AppSidebarLayout>
        <header className="drag-region" data-page-header />
      </AppSidebarLayout>,
    );
    const toggleAt = markup.indexOf('aria-label="Toggle sidebar"');
    expect(toggleAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeGreaterThan(markup.indexOf("data-page-header"));
  });
});
