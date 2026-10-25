import "../../index.css";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { GamesPage } from "./GamesPage";

const { loadMetadata } = vi.hoisted(() => ({ loadMetadata: vi.fn(() => new Promise(() => {})) }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../ui/sidebar", () => ({ useSidebar: () => ({ setOpen: vi.fn() }) }));
vi.mock("./games.metadata", async (original) => ({
  ...(await original<typeof import("./games.metadata")>()),
  loadGameMetadata: loadMetadata,
}));
vi.mock("../standalone/StandaloneChatPageShell", () => ({
  StandaloneChatPageShell: ({ header, children }: { header: ReactNode; children: ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock("../layout/ContentPanelHeaderBar", () => ({
  ContentPanelHeaderBar: ({ title, center }: { title: ReactNode; center: ReactNode }) => (
    <header>
      {title}
      {center}
    </header>
  ),
}));

let screen: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
});

it("renders the bundled catalog immediately even when every metadata request is pending", async () => {
  screen = await render(<GamesPage />);
  await expect.element(screen.getByText("PAC-MAN", { exact: true })).toBeVisible();
  expect(loadMetadata).toHaveBeenCalled();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
  await screen.getByRole("searchbox", { name: "Search games" }).fill("not-a-game");
  await expect.element(screen.getByText("No games found.")).toBeVisible();
  expect(document.querySelector(".animate-pulse-slow")).toBeNull();
});
