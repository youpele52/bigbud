import "../../../index.css";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Menu, MenuPopup, MenuTrigger } from "../../ui/menu";
import { parseExpandedProvidersSearch } from "../../../routes/-settings.providers.search";
import { OpenCodeSetupMenuItem } from "./ProviderModelPicker.setup";

function SetupRouteFixture() {
  return (
    <Menu>
      <MenuTrigger>Providers</MenuTrigger>
      <MenuPopup>
        <OpenCodeSetupMenuItem message="Native service trust consent required" />
      </MenuPopup>
    </Menu>
  );
}

it("uses the real router search parser to target the expanded OpenCode settings", async () => {
  const root = createRootRoute({ component: SetupRouteFixture });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const providers = createRoute({
    getParentRoute: () => root,
    path: "/settings/providers",
    validateSearch: (search: unknown) => ({ providers: parseExpandedProvidersSearch(search) }),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([index, providers]),
  });
  await router.load();
  const screen = await render(<RouterProvider router={router} />);
  try {
    await page.getByRole("button", { name: "Providers" }).click();
    await page.getByRole("menuitem", { name: /Set up OpenCode/ }).click();
    await expect.poll(() => router.state.location.pathname).toBe("/settings/providers");
    expect(router.state.location.search).toEqual({ providers: ["opencodeV2"] });
  } finally {
    await screen.unmount();
  }
});
