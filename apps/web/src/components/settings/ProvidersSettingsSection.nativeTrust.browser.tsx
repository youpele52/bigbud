import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ trust: null as "host-user-v1" | null, update: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    providers: {
      ...DEFAULT_UNIFIED_SETTINGS.providers,
      opencodeV2: {
        ...DEFAULT_UNIFIED_SETTINGS.providers.opencodeV2,
        enabled: true,
        connectionMode: "shared",
        nativeServiceTrust: mocks.trust,
      },
    },
  }),
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
vi.mock("../../rpc/serverState", () => ({ useServerProviders: () => [] }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { refreshProviders: vi.fn(async () => {}) } }),
}));
vi.mock("../../hooks/useCliProxyActivation", () => ({
  useCliProxyActivation: () => ({ isActivatingCliProxy: false, activateCliProxy: vi.fn() }),
}));
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";

afterEach(() => {
  vi.clearAllMocks();
  mocks.trust = null;
  document.body.innerHTML = "";
});

it("requires explicit acknowledgement independent of enable, explains host/plugin trust, and saves revocation", async () => {
  const screen = await render(<ProvidersSettingsSection expandedProviders={["opencodeV2"]} />);
  const trust = screen.getByRole("switch", { name: "Trust native service execution" });
  await expect.element(trust).not.toBeChecked();
  await expect
    .element(screen.getByText(/Activating a workspace may load or install/))
    .toBeVisible();
  await trust.click();
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ enabled: true, nativeServiceTrust: "host-user-v1" }),
      }),
    }),
  );
  mocks.trust = "host-user-v1";
  await screen.rerender(<ProvidersSettingsSection expandedProviders={["opencodeV2"]} />);
  await trust.click();
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ nativeServiceTrust: null }),
      }),
    }),
  );
});

it("mode/service-file edits and provider reset clear acknowledgement, preserving independent providers", async () => {
  mocks.trust = "host-user-v1";
  const screen = await render(<ProvidersSettingsSection expandedProviders={["opencodeV2"]} />);
  await screen
    .getByRole("textbox", { name: "Native service registration file" })
    .fill("/fixture/service.json");
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ nativeServiceTrust: null }),
        codex: DEFAULT_UNIFIED_SETTINGS.providers.codex,
      }),
    }),
  );
  await screen
    .getByRole("combobox", { name: "OpenCode connection mode" })
    .selectOptions("isolated");
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({
          connectionMode: "isolated",
          nativeServiceTrust: null,
        }),
      }),
    }),
  );
  await screen.getByRole("button", { name: "Reset OpenCode provider settings to default" }).click();
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ nativeServiceTrust: null }),
      }),
    }),
  );
});
