import "../../../index.css";
import type { ServerProvider } from "@bigbud/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getCustomModelOptionsByProvider } from "../../../models/provider";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { opencodeV2SnapshotFixture } from "./ProviderModelPicker.opencodeV2.browser.fixtures";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  routesByPath: { "/settings/providers": {} } as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => mocks,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.routesByPath = { "/settings/providers": {} };
});

it.each([null, "opencodeV2"] as const)(
  "keeps unsupported remote V2 unavailable with lock %s rather than advertising local setup",
  async (lockedProvider) => {
    const snapshot: ServerProvider = {
      ...opencodeV2SnapshotFixture(),
      status: "warning",
      models: [],
      supportsLocalRuntimeRemoteWorkspace: false,
    };
    const change = vi.fn();
    const screen = await render(
      <ProviderModelPicker
        provider="codex"
        model="gpt-5.4"
        lockedProvider={lockedProvider}
        workspaceExecutionTargetId="ssh:fixture"
        providers={[snapshot]}
        modelOptionsByProvider={getCustomModelOptionsByProvider(
          DEFAULT_UNIFIED_SETTINGS,
          [snapshot],
          "codex",
          "gpt-5.4",
        )}
        onProviderModelChange={change}
      />,
    );
    try {
      await page.getByRole("button").click();
      if (lockedProvider === "opencodeV2") {
        await expect
          .element(page.getByRole("status"))
          .toHaveTextContent("Provider does not support a remote workspace with a local runtime");
      } else {
        await expect
          .element(page.getByRole("menuitem", { name: /OpenCode Provider does not support/ }))
          .toBeDisabled();
      }
      await expect
        .element(page.getByRole("menuitem", { name: /Set up OpenCode/ }))
        .not.toBeInTheDocument();
      expect(change).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  },
);

it.each([null, "opencodeV2"] as const)(
  "shows the real health reason for capable remote V2 with lock %s",
  async (lockedProvider) => {
    const message = "No native models are available.";
    const snapshot: ServerProvider = {
      ...opencodeV2SnapshotFixture(),
      status: "warning",
      models: [],
      message,
    };
    const options = getCustomModelOptionsByProvider(
      DEFAULT_UNIFIED_SETTINGS,
      [snapshot],
      "codex",
      "gpt-5.4",
    );
    const screen = await render(
      <ProviderModelPicker
        provider="codex"
        model="gpt-5.4"
        lockedProvider={lockedProvider}
        workspaceExecutionTargetId="ssh:fixture"
        providers={[snapshot]}
        modelOptionsByProvider={options}
        onProviderModelChange={vi.fn()}
      />,
    );
    try {
      await page.getByRole("button").click();
      if (lockedProvider === "opencodeV2") {
        await expect.element(page.getByRole("status")).toHaveTextContent(message);
      } else {
        await expect
          .element(page.getByRole("menuitem", { name: /OpenCode No native models/ }))
          .toBeDisabled();
      }
      await expect
        .element(page.getByText(/does not support a remote workspace/))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  },
);
