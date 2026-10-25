import "../../../index.css";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { OPENCODE_RETAINED_HISTORY_ADVISORY } from "@bigbud/shared/opencodeAdvisory";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  createRetainedHistoryAdvisoryState,
  RETAINED_HISTORY_DISMISSAL_KEY,
} from "./ProviderStatusBanner.advisory.state";

const mocks = vi.hoisted(() => ({
  state: null as ReturnType<
    typeof import("./ProviderStatusBanner.advisory.state").createRetainedHistoryAdvisoryState
  > | null,
  providers: [] as ServerProvider[],
  add: vi.fn(),
}));

vi.mock("./ProviderStatusBanner.advisory.state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProviderStatusBanner.advisory.state")>()),
  retainedHistoryAdvisoryState: {
    getSnapshot: () => mocks.state!.getSnapshot(),
    subscribe: (listener: () => void) => mocks.state!.subscribe(listener),
    dismiss: () => mocks.state!.dismiss(),
    claimStartupToast: () => mocks.state!.claimStartupToast(),
  },
}));
vi.mock("../../../rpc/serverState", () => ({ useServerProviders: () => mocks.providers }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../ui/toast", () => ({ toastManager: { add: mocks.add } }));

import { ProviderStatusBanner } from "./ProviderStatusBanner";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { ProviderRecoveryToastCoordinator } from "../../ProviderRecoveryToastCoordinator";

const nativeMessage = `Connected to your native OpenCode service. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`;

function nativeStatus(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "1.17.18",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-13T12:00:00.000Z",
    initialProbeComplete: true,
    models: [],
    slashCommands: [],
    skills: [],
    message: nativeMessage,
    ...overrides,
  };
}

describe("OpenCode retained-history advisory dismissal", () => {
  beforeEach(() => {
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
    localStorage.removeItem(RETAINED_HISTORY_DISMISSAL_KEY);
    mocks.state = createRetainedHistoryAdvisoryState();
    mocks.providers = [nativeStatus()];
    mocks.add.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(RETAINED_HISTORY_DISMISSAL_KEY);
  });

  it("dismisses for this thread without changing the legacy advisory preference or generating a toast", async () => {
    await render(<ProviderRecoveryToastCoordinator />);
    const firstChat = await render(
      <ProviderStatusBanner threadId="first-thread" status={nativeStatus()} />,
    );
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(OPENCODE_RETAINED_HISTORY_ADVISORY);
    await page.getByLabelText("Dismiss provider status").click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(localStorage.getItem(RETAINED_HISTORY_DISMISSAL_KEY)).toBeNull();
    expect(mocks.add).not.toHaveBeenCalled();
    await firstChat.unmount();

    const remount = await render(
      <ProviderStatusBanner threadId="first-thread" status={nativeStatus()} />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await remount.rerender(
      <ProviderStatusBanner threadId="another-thread" status={nativeStatus()} />,
    );
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("keeps the banner hidden on a fresh boot and toasts once globally across reconnects and remounts", async () => {
    localStorage.setItem(RETAINED_HISTORY_DISMISSAL_KEY, "true");
    // A new state factory represents a fresh JS app runtime, retaining only browser storage.
    mocks.state = createRetainedHistoryAdvisoryState();
    mocks.providers = [];
    const coordinator = await render(<ProviderRecoveryToastCoordinator />);
    expect(mocks.add).not.toHaveBeenCalled();
    mocks.providers = [nativeStatus()];
    await coordinator.rerender(<ProviderRecoveryToastCoordinator />);
    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledOnce());
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: OPENCODE_RETAINED_HISTORY_ADVISORY,
      }),
    );
    await render(<ProviderStatusBanner status={nativeStatus()} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    mocks.providers = [nativeStatus({ version: "1.18.0", checkedAt: "2026-10-13T13:00:00.000Z" })];
    await coordinator.rerender(<ProviderRecoveryToastCoordinator />);
    await coordinator.unmount();
    await render(<ProviderRecoveryToastCoordinator />);
    expect(mocks.add).toHaveBeenCalledOnce();
  });

  it("removes only the advisory suffix and preserves new setup warnings, actual errors and other providers", async () => {
    mocks.state!.dismiss();
    const screen = await render(<ProviderStatusBanner status={nativeStatus()} />);
    for (const status of [
      nativeStatus({
        message: `Required thread tools bridge is missing. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
      }),
      nativeStatus({
        status: "error",
        message: `Native service connection failed. ${OPENCODE_RETAINED_HISTORY_ADVISORY}`,
      }),
      nativeStatus({ message: "A different new warning." }),
    ]) {
      await screen.rerender(<ProviderStatusBanner status={status} />);
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(status.message!.split(" Logical native")[0]!);
      await expect
        .element(page.getByRole("alert"))
        .not.toHaveTextContent(OPENCODE_RETAINED_HISTORY_ADVISORY);
    }
    await screen.rerender(
      <ProviderStatusBanner
        status={nativeStatus({ status: "error", message: OPENCODE_RETAINED_HISTORY_ADVISORY })}
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("provider is unavailable");
    await screen.rerender(<ProviderStatusBanner status={nativeStatus({ provider: "opencode" })} />);
    await expect.element(page.getByRole("alert")).toHaveTextContent(nativeMessage);
    await page.getByLabelText("Dismiss provider status").click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await screen.rerender(
      <ProviderStatusBanner
        status={nativeStatus({ provider: "opencode", message: "New legacy provider warning." })}
      />,
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });

  it("does not match a partial advisory or an advisory quoted inside a longer primary message", async () => {
    mocks.state!.dismiss();
    const message = `Native readiness failed: ${OPENCODE_RETAINED_HISTORY_ADVISORY} Check required setup.`;
    const screen = await render(<ProviderStatusBanner status={nativeStatus({ message })} />);
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    await screen.rerender(
      <ProviderStatusBanner
        status={nativeStatus({ message: "Logical native history is retained. A new setup error." })}
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveTextContent("A new setup error.");
  });

  it("syncs dismissal from another tab without generating a toast in the current runtime", async () => {
    await render(<ProviderRecoveryToastCoordinator />);
    await render(<ProviderStatusBanner status={nativeStatus()} />);
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    localStorage.setItem(RETAINED_HISTORY_DISMISSAL_KEY, "true");
    window.dispatchEvent(
      new StorageEvent("storage", { key: RETAINED_HISTORY_DISMISSAL_KEY, newValue: "true" }),
    );
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("retains dismissal across mounted chats and remounts when storage reads/writes fail", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const first = await render(<ProviderStatusBanner status={nativeStatus()} />);
    const second = await render(<ProviderStatusBanner status={nativeStatus()} />);
    await page.getByLabelText("Dismiss provider status").first().click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await first.unmount();
    await second.unmount();
    await render(<ProviderStatusBanner status={nativeStatus()} />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
});
