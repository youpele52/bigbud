import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { ToastProvider, toastManager } from "./toast";

const route = vi.hoisted(() => ({ current: "active" as string | null }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => route.current }));

const activeThread = ThreadId.makeUnsafe("active");
const otherThread = ThreadId.makeUnsafe("other");
const focusedCard = () => document.activeElement?.closest<HTMLElement>('[data-slot="toast-popup"]');

function addHiddenToasts() {
  toastManager.add({
    title: "Other thread only",
    timeout: 0,
    data: { threadId: otherThread },
  });
  toastManager.add({
    title: "Hide on this thread",
    timeout: 0,
    data: { threadId: activeThread, hideOnActiveThread: true },
  });
}

afterEach(() => {
  toastManager.close();
  route.current = "active";
});

it("enters the visible stack with F6 and Tab even when newer toasts belong to hidden threads", async () => {
  const screen = await render(
    <ToastProvider>
      <button type="button">Outside</button>
    </ToastProvider>,
  );
  try {
    toastManager.add({ title: "Visible keyboard card", timeout: 0 });
    addHiddenToasts();
    await expect.element(screen.getByText("Visible keyboard card")).toBeVisible();
    await screen.getByRole("button", { name: "Outside" }).click();
    await userEvent.keyboard("{F6}{Tab}");
    expect(focusedCard()?.textContent).toContain("Visible keyboard card");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("skips hidden threads when dismissing by keyboard and restores outside focus after the last visible card", async () => {
  const screen = await render(
    <ToastProvider>
      <button type="button">Outside</button>
    </ToastProvider>,
  );
  try {
    toastManager.add({ title: "Older visible card", timeout: 0 });
    addHiddenToasts();
    toastManager.add({ title: "Newest visible card", timeout: 0 });
    await expect.element(screen.getByText("Newest visible card")).toBeVisible();
    await screen.getByRole("button", { name: "Outside" }).click();
    await userEvent.keyboard("{F6}{Tab}{Tab}{Enter}");
    await expect.poll(() => focusedCard()?.textContent).toContain("Older visible card");
    expect(focusedCard()?.hasAttribute("data-ending-style")).toBe(false);
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    await expect.element(screen.getByText("Older visible card")).not.toBeInTheDocument();
    await userEvent.keyboard("{F6}");
    await expect.element(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    const afterPortal = document.createElement("button");
    afterPortal.textContent = "After the notification portal";
    document.body.append(afterPortal);
    try {
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(afterPortal);
    } finally {
      afterPortal.remove();
    }
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("does not capture F6 or pause hidden-thread timeout budgets when no visible cards exist", async () => {
  const screen = await render(
    <ToastProvider>
      <button type="button">Outside</button>
    </ToastProvider>,
  );
  try {
    const closed = vi.fn();
    toastManager.add({
      title: "Hidden timer",
      timeout: 500,
      onClose: closed,
      data: { threadId: otherThread },
    });
    await screen.getByRole("button", { name: "Outside" }).click();
    await userEvent.keyboard("{F6}");
    await expect.element(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    await expect.poll(() => closed.mock.calls.length).toBe(1);
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("recovers focus when a route change hides the focused toast and keeps thread notifications available", async () => {
  const screen = await render(
    <ToastProvider>
      <button type="button">Outside</button>
    </ToastProvider>,
  );
  try {
    toastManager.add({
      title: "Active thread notification",
      timeout: 0,
      data: { threadId: activeThread },
    });
    toastManager.add({
      title: "Other thread notification",
      timeout: 0,
      data: { threadId: otherThread },
    });
    await expect.element(screen.getByText("Active thread notification")).toBeVisible();
    await screen.getByRole("button", { name: "Outside" }).click();
    await userEvent.keyboard("{F6}{Tab}{Tab}");
    route.current = "other";
    await screen.rerender(
      <ToastProvider position="top-left">
        <button type="button">Outside</button>
      </ToastProvider>,
    );
    await expect.poll(() => focusedCard()?.textContent).toContain("Other thread notification");
    route.current = null;
    await screen.rerender(
      <ToastProvider>
        <button type="button">Outside</button>
      </ToastProvider>,
    );
    await expect.element(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    route.current = "active";
    await screen.rerender(<ToastProvider position="bottom-right" />);
    await expect.element(screen.getByText("Active thread notification")).toBeVisible();
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});
