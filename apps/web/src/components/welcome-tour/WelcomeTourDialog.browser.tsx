import "../../index.css";

import type { ServerProvider } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@bigbud/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { StoreApi, UseBoundStore } from "zustand";

const mocks = vi.hoisted(() => ({
  saveServer: vi.fn(),
  apply: vi.fn(),
  toast: vi.fn(),
  updateServerSettings: vi.fn(),
  fileAccessRequest: vi.fn(async () => ({ denied: [] })),
  newChat: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  providers: [] as ServerProvider[],
}));

vi.mock("../../hooks/useSettings", async () => {
  const { create } = await import("zustand");
  const contracts = await import("@bigbud/contracts/settings");
  const settingsStore = create<UnifiedSettings>(() => ({ ...contracts.DEFAULT_UNIFIED_SETTINGS }));
  return {
    settingsStore,
    useSettings: (selector?: (settings: UnifiedSettings) => unknown) =>
      settingsStore((settings) => (selector ? selector(settings) : settings)),
    useUpdateSettings: () => ({
      updateSettings: (patch: Partial<UnifiedSettings>) => settingsStore.setState(patch),
    }),
    updateServerSettings: mocks.updateServerSettings,
  };
});
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { updateSettings: mocks.saveServer } }),
  readNativeApi: () => ({ fileAccess: { request: mocks.fileAccessRequest } }),
}));
vi.mock("../../rpc/serverState", async (original) => ({
  ...(await original<typeof import("../../rpc/serverState")>()),
  applySettingsUpdated: mocks.apply,
  useServerProviders: () => mocks.providers,
  useServerConfig: () => ({}),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useHandleNewThread: () => ({}) }));
vi.mock("../sidebar/Sidebar.state.newChat", () => ({
  useSidebarNewChatActions: () => ({ handleNewChats: mocks.newChat }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));

import * as settingsModule from "../../hooks/useSettings";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../stores/main/main.store";
import { useWelcomeTourStore } from "../../stores/ui/welcomeTour.store";
import { ChatGreetingHarness } from "../chat/common/ChatGreeting.browser.harness";
import { WelcomeTourDialog } from "./WelcomeTourDialog";
import { useFirstLaunchWelcomeTour } from "./WelcomeTourDialog.firstLaunch";

const settingsStore = (
  settingsModule as unknown as { settingsStore: UseBoundStore<StoreApi<UnifiedSettings>> }
).settingsStore;
const landing = ThreadId.makeUnsafe("welcome-landing");

function FirstLaunch() {
  const settings = useSettings();
  useFirstLaunchWelcomeTour({
    bootstrapComplete: true,
    hasLoadedServerConfig: true,
    hasSeenFileAccessPrompt: settings.hasSeenFileAccessPrompt,
    hasSeenWelcomeTour: settings.hasSeenWelcomeTour,
  });
  return <WelcomeTourDialog />;
}

function LandingChat() {
  const name = useSettings((settings) => settings.greetingName);
  return <ChatGreetingHarness identity={landing} name={name} />;
}

const tourDialog = () => page.getByRole("dialog");

describe("first-launch welcome tour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    settingsStore.setState({ ...DEFAULT_UNIFIED_SETTINGS }, true);
    useWelcomeTourStore.setState({
      open: false,
      mode: "tour",
      welcomeGreetingPending: false,
      welcomeGreetingThreadId: null,
    });
    useStore.setState({ bootstrapComplete: true, threadHydrationById: {} });
    mocks.providers = [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-20T10:00:00.000Z",
        models: [],
      } as unknown as ServerProvider,
    ];
    mocks.saveServer.mockImplementation(async ({ greetingName }: { greetingName: string }) => ({
      ...DEFAULT_UNIFIED_SETTINGS,
      greetingName,
    }));
    mocks.apply.mockImplementation((settings: UnifiedSettings) =>
      settingsStore.setState({ greetingName: settings.greetingName }),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useStore.setState({ bootstrapComplete: false, threadHydrationById: {} });
  });

  it("shows once to a new install; Skip tour records it without choosing a File Access level", async () => {
    const screen = await render(<FirstLaunch />);
    await expect.element(page.getByText("Step 1 of 3", { exact: false })).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "What should bigbud call you?" }))
      .toHaveFocus();
    await page.getByRole("button", { name: "Skip tour" }).click();
    await expect.element(tourDialog()).not.toBeInTheDocument();
    expect(settingsStore.getState()).toMatchObject({
      hasSeenWelcomeTour: true,
      hasSeenFileAccessPrompt: true,
      fileAccessPermissionLevel: "none",
    });
    expect(mocks.fileAccessRequest).not.toHaveBeenCalled();
    await screen.unmount();
    await render(<FirstLaunch />);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("never opens for existing users who already answered File Access", async () => {
    settingsStore.setState({ hasSeenFileAccessPrompt: true });
    await render(<FirstLaunch />);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Escape skips the tour and keeps a typed name", async () => {
    await render(<FirstLaunch />);
    const input = page.getByRole("textbox", { name: "What should bigbud call you?" });
    await input.fill("  Ada ");
    await userEvent.keyboard("{Escape}");
    await expect.element(tourDialog()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(mocks.saveServer).toHaveBeenCalledWith({ greetingName: "Ada" }));
    expect(settingsStore.getState()).toMatchObject({
      greetingName: "Ada",
      hasSeenWelcomeTour: true,
      fileAccessPermissionLevel: "none",
    });
    expect(mocks.newChat).not.toHaveBeenCalled();
  });

  it("saves the name, lists discovered providers, applies and probes File Access, then lands on a greeting", async () => {
    await render(<FirstLaunch />);
    await page.getByRole("textbox", { name: "What should bigbud call you?" }).fill("Ada");
    await page.getByRole("button", { name: "Next" }).click();
    await vi.waitFor(() => expect(mocks.saveServer).toHaveBeenCalledWith({ greetingName: "Ada" }));

    await expect.element(page.getByRole("heading", { name: "Connect AI" })).toBeVisible();
    await expect
      .element(page.getByText("bigbud found 1 AI provider on this computer."))
      .toBeVisible();
    const providers = page.getByRole("list", { name: "AI providers" });
    await expect.element(providers.getByText("Codex", { exact: true })).toBeVisible();
    await expect.element(providers.getByText("Authenticated")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();

    await expect
      .element(page.getByRole("heading", { name: "Allow bigbud to access your files" }))
      .toBeVisible();
    await page.getByRole("button", { name: /Commonly used folders only/ }).click();
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.element(tourDialog()).not.toBeInTheDocument();

    expect(settingsStore.getState()).toMatchObject({
      fileAccessPermissionLevel: "common-folders",
      hasSeenFileAccessPrompt: true,
      hasSeenWelcomeTour: true,
    });
    expect(mocks.updateServerSettings).toHaveBeenCalledWith({
      search: { fileAccessLevel: "common-folders" },
    });
    expect(mocks.fileAccessRequest).toHaveBeenCalledWith("common-folders");
    await vi.waitFor(() => expect(mocks.newChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(useWelcomeTourStore.getState().welcomeGreetingPending).toBe(true),
    );

    await render(<LandingChat />);
    await expect.element(page.getByText("Welcome to bigbud, Ada.")).toBeVisible();
  });

  it("reopens from Settings with every step skippable, keeping the canvas copy without a name", async () => {
    settingsStore.setState({ hasSeenFileAccessPrompt: true, hasSeenWelcomeTour: true });
    await render(<WelcomeTourDialog />);
    useWelcomeTourStore.getState().openTour("tour");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Not now" }).click();
    await expect.element(tourDialog()).not.toBeInTheDocument();
    expect(mocks.saveServer).not.toHaveBeenCalled();
    expect(mocks.fileAccessRequest).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.newChat).toHaveBeenCalledTimes(1));
    await render(<LandingChat />);
    await expect.element(page.getByText("A blank canvas for whatever’s next.")).toBeVisible();
  });

  it("asks only the File Access question after Reset permissions, still probing the level", async () => {
    settingsStore.setState({ hasSeenWelcomeTour: true });
    await render(<FirstLaunch />);
    await expect
      .element(page.getByRole("heading", { name: "Allow bigbud to access your files" }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Step 1 of");
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.element(tourDialog()).not.toBeInTheDocument();
    expect(settingsStore.getState().fileAccessPermissionLevel).toBe("unrestricted");
    expect(mocks.fileAccessRequest).toHaveBeenCalledWith("unrestricted");
    expect(mocks.newChat).not.toHaveBeenCalled();
  });

  it("the providers CTA keeps File Access in the flow and opens Settings → Providers at the end", async () => {
    await render(<WelcomeTourDialog />);
    useWelcomeTourStore.getState().openTour("tour");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByRole("button", { name: "Add more providers after the tour" }).click();
    await expect
      .element(page.getByText("Settings → Providers opens when you finish."))
      .toBeVisible();
    await page.getByRole("button", { name: "Not now" }).click();
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/settings/providers",
        search: { providers: [] },
      }),
    );
    expect(mocks.newChat).not.toHaveBeenCalled();
  });
});
