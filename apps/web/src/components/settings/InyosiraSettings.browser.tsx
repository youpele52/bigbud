import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { InyosiraIdleSettingsSection } from "./InyosiraIdleSettingsSection";
import { InyosiraStatus } from "../sidebar/Sidebar.inyosiraStatus";
const fixture = vi.hoisted(() => ({
  settings: {
    inyosiraPresentTargetEnabled: null as boolean | null,
    inyosiraPresentTarget: 7,
    inyosiraGraceMinutes: 5,
    inyosiraIntroductionDismissed: false,
    inyosiraIdleCleanupEnabled: true,
    inyosiraIdleTimeoutMinutes: 10,
    inyosiraIdleDestination: "later",
    inyosiraOlderThreadsEnabled: true,
    inyosiraOlderThreadsDays: 1,
  },
  status: {
    state: "healthy" as "healthy" | "paused",
    installation: "existing",
    reason: undefined as "thread-limit" | "capture-time" | undefined,
  },
  listeners: new Set<() => void>(),
  save: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../../hooks/useOrganizationStatus", () => ({
  useOrganizationStatus: () => fixture.status,
}));
vi.mock("../../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSettings: (selector: (value: typeof fixture.settings) => unknown) =>
      selector(
        useSyncExternalStore(
          (listener) => {
            fixture.listeners.add(listener);
            return () => {
              fixture.listeners.delete(listener);
            };
          },
          () => fixture.settings,
        ),
      ),
    persistServerSettings: fixture.save,
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: fixture.toast } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/settings/general#inyosira">{children}</a>
  ),
}));
beforeEach(() => {
  fixture.settings = {
    ...fixture.settings,
    inyosiraPresentTargetEnabled: null,
    inyosiraPresentTarget: 7,
    inyosiraGraceMinutes: 5,
    inyosiraIntroductionDismissed: false,
  };
  fixture.status = { state: "healthy", installation: "existing", reason: undefined };
  fixture.save.mockReset().mockImplementation(async (patch: Partial<typeof fixture.settings>) => {
    fixture.settings = { ...fixture.settings, ...patch };
    for (const listener of fixture.listeners) listener();
  });
  fixture.toast.mockReset();
});
it("existing installations stay off until explicit Enable; Not now stays dismissed in another view", async () => {
  const screen = await render(<InyosiraStatus key="client-a" />);
  await expect
    .element(
      screen.getByText(
        "Keep Present focused with a soft target of 7 threads. Working threads always stay visible.",
      ),
    )
    .toBeVisible();
  await screen.getByRole("button", { name: "Not now" }).click();
  expect(fixture.settings.inyosiraPresentTargetEnabled).toBeNull();
  await expect.element(screen.getByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  await screen.rerender(<InyosiraStatus key="client-b" />);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
});
it("Enable keeps the configured target and dismisses once; new installations never get the opt-in dialog", async () => {
  fixture.settings = { ...fixture.settings, inyosiraPresentTarget: 12 };
  const screen = await render(<InyosiraStatus />);
  await screen.getByRole("button", { name: "Enable" }).click();
  expect(fixture.save).toHaveBeenCalledWith({
    inyosiraIntroductionDismissed: true,
    inyosiraPresentTargetEnabled: true,
  });
  expect(fixture.settings.inyosiraPresentTarget).toBe(12);
  fixture.status.installation = "new";
  await screen.rerender(<InyosiraStatus />);
  await expect.element(screen.getByRole("button", { name: "Enable" })).not.toBeInTheDocument();
});
it("an explicit off in Settings is respected: no opt-in dialog", async () => {
  fixture.settings = { ...fixture.settings, inyosiraPresentTargetEnabled: false };
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByRole("button", { name: "Enable" })).not.toBeInTheDocument();
});
it("shows both messages in a dialog and dismisses them together without enabling automation", async () => {
  fixture.status.state = "paused";
  const screen = await render(
    <div data-testid="sidebar-status">
      <InyosiraStatus />
    </div>,
  );
  const dialog = screen.getByRole("dialog", { name: "Inyosira" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByRole("status"))
    .toHaveTextContent(
      "Automatic organisation is paused. You can still move threads. It retries on its own, or right away when you move a thread or change Inyosira settings.",
    );
  await expect
    .element(
      dialog.getByText(
        "Keep Present focused with a soft target of 7 threads. Working threads always stay visible.",
      ),
    )
    .toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "Settings" }))
    .toHaveAttribute("href", "/settings/general#inyosira");
  expect(screen.getByTestId("sidebar-status").element().textContent).toBe("");
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(fixture.settings.inyosiraPresentTargetEnabled).toBeNull();
});
it("allows closing a paused-only dialog without saving preferences or reopening on the same status", async () => {
  fixture.settings = { ...fixture.settings, inyosiraIntroductionDismissed: true };
  fixture.status.state = "paused";
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog", { name: "Inyosira" })).toBeVisible();
  await screen.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  fixture.status = { ...fixture.status };
  await screen.rerender(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.save).not.toHaveBeenCalled();
  fixture.status.reason = "capture-time";
  await screen.rerender(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Automatic organisation stopped: reading your threads took too long.");
});
it("Escape dismisses the introduction using the same saved choice as Not now", async () => {
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.save).toHaveBeenCalledWith({ inyosiraIntroductionDismissed: true });
});
it("keeps the dialog available after a failed preference save", async () => {
  fixture.save.mockRejectedValueOnce(new Error("save failed"));
  const screen = await render(<InyosiraStatus />);
  await screen.getByRole("button", { name: "Not now" }).click();
  await expect.poll(() => fixture.toast.mock.calls.length).toBe(1);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
});
it("settings expose target/grace and truthfully retain values after save failure", async () => {
  const screen = await render(<InyosiraIdleSettingsSection />);
  await expect
    .element(screen.getByRole("heading", { name: "Inyosira", exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("switch", { name: "Keep Present focused" }))
    .not.toBeChecked();
  fixture.save.mockRejectedValueOnce(new Error("save failed"));
  await screen.getByRole("switch", { name: "Keep Present focused" }).click();
  await expect.poll(() => fixture.toast.mock.calls.length).toBe(1);
  await expect
    .element(screen.getByRole("switch", { name: "Keep Present focused" }))
    .not.toBeChecked();
  const grace = screen.getByRole("spinbutton", { name: "Inyosira grace in minutes" });
  await grace.fill("1");
  await grace.element().blur();
  await expect.element(grace).toHaveValue(5);
  await grace.fill("8");
  await grace.element().blur();
  await expect.poll(() => fixture.settings.inyosiraGraceMinutes).toBe(8);
});
