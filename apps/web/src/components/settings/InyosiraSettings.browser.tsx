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
  Link: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a
      href="/settings/general#inyosira"
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
const introductionTitle = "Room for every idea. Breathing room for your attention.";
const introductionCopy =
  "Inyosira organises your threads around what needs you, what you’re working on, and what can wait. It aims for 7 threads in Present, moving inactive threads to Later as the list grows. Working threads always stay visible, and you can adjust the target anytime.";
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
it.each(["new", "existing"])(
  "%s installations acknowledge the default target once across views",
  async (installation) => {
    fixture.status.installation = installation;
    const screen = await render(<InyosiraStatus key="client-a" />);
    await expect.element(screen.getByRole("dialog", { name: introductionTitle })).toBeVisible();
    await expect.element(screen.getByText(introductionCopy)).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Change target" }))
      .toHaveAttribute("href", "/settings/general#inyosira");
    await screen.getByRole("button", { name: "Use default" }).click();
    expect(fixture.save).toHaveBeenCalledWith({ inyosiraIntroductionDismissed: true });
    expect(fixture.settings.inyosiraPresentTargetEnabled).toBeNull();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
    await screen.rerender(<InyosiraStatus key="client-b" />);
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  },
);
it("shows and keeps the configured target without resetting it to seven", async () => {
  fixture.settings = { ...fixture.settings, inyosiraPresentTarget: 12 };
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByText(/It aims for 12 threads in Present/)).toBeVisible();
  await screen.getByRole("button", { name: "Keep current target" }).click();
  expect(fixture.save).toHaveBeenCalledWith({
    inyosiraIntroductionDismissed: true,
  });
  expect(fixture.settings.inyosiraPresentTarget).toBe(12);
  expect(fixture.settings.inyosiraPresentTargetEnabled).toBeNull();
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
});
it("an explicit off in Settings is respected: no target introduction", async () => {
  fixture.settings = { ...fixture.settings, inyosiraPresentTargetEnabled: false };
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
});
it("Change target opens the settings link and remembers the introduction without changing the target", async () => {
  fixture.settings = { ...fixture.settings, inyosiraPresentTarget: 12 };
  const screen = await render(<InyosiraStatus />);
  await screen.getByRole("link", { name: "Change target" }).click();
  expect(fixture.save).toHaveBeenCalledWith({ inyosiraIntroductionDismissed: true });
  expect(fixture.settings.inyosiraPresentTarget).toBe(12);
  expect(fixture.settings.inyosiraPresentTargetEnabled).toBeNull();
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
});
it("keeps the introduction focused on the target even when automation is paused", async () => {
  fixture.status.state = "paused";
  const screen = await render(
    <div data-testid="sidebar-status">
      <InyosiraStatus />
    </div>,
  );
  const dialog = screen.getByRole("dialog", { name: introductionTitle });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByRole("status")).not.toBeInTheDocument();
  await expect.element(dialog.getByText(/Automatic organisation/)).not.toBeInTheDocument();
  await expect.element(dialog.getByText(introductionCopy)).toBeVisible();
  await expect
    .element(dialog.getByRole("link", { name: "Change target" }))
    .toHaveAttribute("href", "/settings/general#inyosira");
  expect(screen.getByTestId("sidebar-status").element().textContent).toBe("");
  await dialog.getByRole("button", { name: "Use default" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(fixture.settings.inyosiraPresentTargetEnabled).toBeNull();
});
it("paused status changes do not reopen an acknowledged introduction", async () => {
  fixture.settings = { ...fixture.settings, inyosiraIntroductionDismissed: true };
  fixture.status.state = "paused";
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  fixture.status = { ...fixture.status };
  await screen.rerender(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.save).not.toHaveBeenCalled();
  fixture.status.reason = "capture-time";
  await screen.rerender(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
});
it("Escape acknowledges the introduction without changing the default target", async () => {
  const screen = await render(<InyosiraStatus />);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  expect(fixture.save).toHaveBeenCalledWith({ inyosiraIntroductionDismissed: true });
});
it("keeps the dialog available after a failed preference save", async () => {
  fixture.save.mockRejectedValueOnce(new Error("save failed"));
  const screen = await render(<InyosiraStatus />);
  await screen.getByRole("button", { name: "Use default" }).click();
  await expect.poll(() => fixture.toast.mock.calls.length).toBe(1);
  await expect.element(screen.getByRole("dialog")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Use default" })).toBeEnabled();
});
it("settings show the target enabled by default and retain values after save failure", async () => {
  const screen = await render(<InyosiraIdleSettingsSection />);
  await expect
    .element(screen.getByRole("heading", { name: "Inyosira", exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("switch", { name: "Keep Present focused" })).toBeChecked();
  fixture.save.mockRejectedValueOnce(new Error("save failed"));
  await screen.getByRole("switch", { name: "Keep Present focused" }).click();
  await expect.poll(() => fixture.toast.mock.calls.length).toBe(1);
  await expect.element(screen.getByRole("switch", { name: "Keep Present focused" })).toBeChecked();
  const grace = screen.getByRole("spinbutton", { name: "Inyosira grace in minutes" });
  await grace.fill("1");
  await grace.element().blur();
  await expect.element(grace).toHaveValue(5);
  await grace.fill("8");
  await grace.element().blur();
  await expect.poll(() => fixture.settings.inyosiraGraceMinutes).toBe(8);
});
