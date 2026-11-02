import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../sidebar/SidebarDownloads", () => ({
  SidebarDownloads: () => <div>Shared download jobs</div>,
}));
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

it("keeps shared app/Copilot downloads in the settings footer above Back", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <SettingsSidebarNav pathname="/settings/providers" />
    </SidebarProvider>,
  );
  expect(html).toContain("Shared download jobs");
  expect(html.indexOf("Shared download jobs")).toBeLessThan(html.indexOf(">Back<"));
});
