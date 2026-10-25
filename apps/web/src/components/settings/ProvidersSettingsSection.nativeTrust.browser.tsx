import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  trust: null as "host-user-v1" | "managed-thread-tools-v2" | null,
  update: vi.fn(),
  persist: vi.fn(),
  get: vi.fn(async () => ({
    status: "required",
    directory: "/context",
    message: "Detected required setup.",
    severity: "warning",
  })),
}));
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
  ensureNativeApi: () => ({
    server: {
      refreshProviders: vi.fn(async () => {}),
      updateSettings: mocks.persist,
      getOpencodeV2ThreadToolsSetup: mocks.get,
    },
  }),
}));
vi.mock("../../hooks/useCliProxyActivation", () => ({
  useCliProxyActivation: () => ({ isActivatingCliProxy: false, activateCliProxy: vi.fn() }),
}));
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";

afterEach(() => {
  vi.clearAllMocks();
  mocks.trust = null;
  mocks.persist.mockReset();
  document.body.innerHTML = "";
});

it("old acknowledgement grants no setup; expanded acknowledgement persists before automatic setup and saves revocation", async () => {
  mocks.trust = "host-user-v1";
  mocks.persist.mockImplementation(async (patch) => {
    mocks.trust = patch.providers.opencodeV2.nativeServiceTrust;
    return {
      ...DEFAULT_UNIFIED_SETTINGS,
      providers: {
        ...DEFAULT_UNIFIED_SETTINGS.providers,
        opencodeV2: {
          ...DEFAULT_UNIFIED_SETTINGS.providers.opencodeV2,
          enabled: true,
          nativeServiceTrust: mocks.trust,
        },
      },
    };
  });
  const screen = await render(<ProvidersSettingsSection expandedProviders={["opencodeV2"]} />);
  const trust = screen.getByRole("switch", { name: "Allow native tools" });
  await expect.element(trust).not.toBeChecked();
  await expect
    .element(screen.getByText(/Native tools run as your user, not in a sandbox/))
    .toBeVisible();
  expect(mocks.get).not.toHaveBeenCalled();
  await screen.getByText("What this allows", { exact: true }).click();
  await expect
    .element(screen.getByText(/Activating a workspace may load or install/))
    .toBeVisible();
  await trust.click();
  expect(mocks.persist).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ nativeServiceTrust: "managed-thread-tools-v2" }),
      }),
    }),
  );
  mocks.trust = "managed-thread-tools-v2";
  await screen.rerender(<ProvidersSettingsSection expandedProviders={["opencodeV2"]} />);
  await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
  await trust.click();
  expect(mocks.persist).toHaveBeenLastCalledWith(
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
  await screen.getByText("Connection settings", { exact: true }).click();
  await screen
    .getByRole("textbox", { name: "Connection file (optional)" })
    .fill("/fixture/service.json");
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ nativeServiceTrust: null }),
        codex: DEFAULT_UNIFIED_SETTINGS.providers.codex,
      }),
    }),
  );
  await expect
    .element(screen.getByRole("combobox", { name: "OpenCode connection mode" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Reset OpenCode provider settings to default" }).click();
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providers: expect.objectContaining({
        opencodeV2: expect.objectContaining({ nativeServiceTrust: null }),
      }),
    }),
  );
});
