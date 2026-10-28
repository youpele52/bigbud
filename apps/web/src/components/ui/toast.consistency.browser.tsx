import "~/index.css";
import { expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import type { CDPSession } from "@vitest/browser-playwright";
import { render } from "vitest-browser-react";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { AnchoredToastProvider, anchoredToastManager, ToastProvider, toastManager } from "./toast";
import { TOAST_DISMISS_ALL_HOLD_MS } from "./toast.dismissAll";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-popup"]'));
const activeCards = () => cards().filter((card) => !card.hasAttribute("data-ending-style"));
const closeButton = () => page.getByRole("button", { name: "Close notification" }).first();

it("physically swipes every severity, including legacy anchored/tooltip payloads", async () => {
  const screen = await render(
    <ToastProvider>
      <AnchoredToastProvider />
    </ToastProvider>,
  );
  try {
    for (const [legacy, manager] of [toastManager, anchoredToastManager].entries()) {
      for (const type of ["error", "info", "loading", "success", "warning"] as const) {
        const title = `${type} swipe notification`;
        manager.add({
          title,
          type,
          timeout: 0,
          data: { tooltipStyle: true },
          positionerProps: legacy ? { anchor: document.body } : undefined,
        });
        await expect.element(screen.getByText(title)).toBeVisible();
        await settle();
        const card = activeCards()[0]!;
        await page.elementLocator(card).hover();
        await settle();
        const bounds = card.getBoundingClientRect();
        const frame = window.frameElement?.getBoundingClientRect();
        const x = bounds.left + 40 + (frame?.left ?? 0);
        const y = bounds.top + 20 + (frame?.top ?? 0);
        const input: CDPSession = cdp();
        if (legacy) {
          // Trusted Chromium touch input exercises touch capture and movement,
          // not just synthetic pointer events or a direct manager.close call.
          await input.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y }],
          });
          for (let step = 1; step <= 10; step++) {
            await input.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: x + step * 12, y }],
            });
          }
          await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await input.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
          for (let step = 1; step <= 10; step++) {
            await input.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: x + step * 12,
              y,
              buttons: 1,
            });
          }
          await input.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: x + 120,
            y,
            button: "left",
            clickCount: 1,
          });
        }
        await expect.element(screen.getByText(title)).not.toBeInTheDocument();
      }
    }
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("shares a bounded stack across both APIs, exposes queued cards, and preserves actions", async () => {
  const action = vi.fn();
  const screen = await render(
    <ToastProvider>
      <AnchoredToastProvider />
    </ToastProvider>,
  );
  try {
    for (let i = 0; i < 12; i++) {
      (i % 2 ? anchoredToastManager : toastManager).add({
        title: `Stack ${i}`,
        timeout: 0,
        type: i % 2 ? "warning" : "info",
        actionProps: { children: "Keep action", onClick: action },
      });
    }
    await expect.element(screen.getByText("Stack 11")).toBeVisible();
    expect(document.querySelectorAll('[data-slot="toast-viewport"]')).toHaveLength(1);
    await screen.getByText("Stack 11").hover();
    await settle();
    const visible = activeCards().filter((card) => !card.hasAttribute("data-limited"));
    expect(visible).toHaveLength(3);
    for (let i = 1; i < visible.length; i++) {
      expect(visible[i]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        visible[i - 1]!.getBoundingClientRect().bottom + 10,
      );
    }
    await page.elementLocator(visible[0]!).getByRole("button", { name: "Keep action" }).click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(activeCards()).toHaveLength(12);
    for (let i = 11; i >= 0; i--) {
      await expect.element(screen.getByText(`Stack ${i}`, { exact: true })).toBeVisible();
      await closeButton().click();
      await expect.element(screen.getByText(`Stack ${i}`, { exact: true })).not.toBeInTheDocument();
    }
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("holds X to close the snapshot across APIs and hidden threads, not new arrivals or callback toasts", async () => {
  const screen = await render(
    <ToastProvider>
      <AnchoredToastProvider />
    </ToastProvider>,
  );
  try {
    const hiddenClosed = vi.fn();
    const hiddenRemoved = vi.fn();
    toastManager.add({
      title: "Hidden thread",
      timeout: 0,
      onClose: hiddenClosed,
      onRemove: hiddenRemoved,
      data: { threadId: ThreadId.makeUnsafe("other") },
    });
    const queuedClosed = vi.fn();
    for (let i = 0; i < 8; i++) {
      toastManager.add({ title: `Queued ${i}`, timeout: 0, onClose: queuedClosed });
    }
    toastManager.add({ title: "Old normal", timeout: 0 });
    anchoredToastManager.add({
      title: "Hold me",
      timeout: 0,
      onClose: () => toastManager.add({ title: "From callback", timeout: 0 }),
    });
    await expect.element(screen.getByText("Hold me")).toBeVisible();
    await settle();
    const button = closeButton().element();
    expect(button.getAttribute("title")).toContain("Hold to close all");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Shift+Delete");
    button.addEventListener(
      "pointerdown",
      () => {
        setTimeout(() => toastManager.add({ title: "New arrival", timeout: 0 }), 100);
      },
      { once: true },
    );
    await closeButton().click({ delay: TOAST_DISMISS_ALL_HOLD_MS + 100 });
    await expect.element(screen.getByText("Old normal")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Hold me")).not.toBeInTheDocument();
    await expect.element(screen.getByText("New arrival")).toBeVisible();
    await expect.element(screen.getByText("From callback")).toBeVisible();
    expect(queuedClosed).toHaveBeenCalledTimes(8);
    expect(hiddenClosed).toHaveBeenCalledOnce();
    await expect.poll(() => hiddenRemoved.mock.calls.length).toBe(1);
    expect(activeCards()).toHaveLength(2);
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("offers Shift+Delete without changing ordinary keyboard activation", async () => {
  const screen = await render(<ToastProvider />);
  try {
    toastManager.add({ title: "Keyboard one", timeout: 0 });
    toastManager.add({ title: "Keyboard two", timeout: 0 });
    await expect.element(screen.getByText("Keyboard two")).toBeVisible();
    (closeButton().element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByText("Keyboard two")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Keyboard one")).toBeVisible();
    (closeButton().element() as HTMLElement).focus();
    await userEvent.keyboard("{Shift>}{Delete}{/Shift}");
    await expect.element(screen.getByText("Keyboard one")).not.toBeInTheDocument();
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("cancels a hold on pointer cancellation, movement, blur, and unmount", async () => {
  const screen = await render(<ToastProvider />);
  try {
    for (const reason of [
      "pointercancel",
      "pointermove",
      "pointerout",
      "lostpointercapture",
      "blur",
      "windowblur",
      "unmount",
    ]) {
      const otherClosed = vi.fn();
      toastManager.add({ title: "Do not close", timeout: 0, onClose: otherClosed });
      const heldClosed = vi.fn();
      toastManager.add({ title: "Cancel hold", timeout: 0, onClose: heldClosed });
      await expect.element(screen.getByText("Cancel hold")).toBeVisible();
      await settle();
      const button = closeButton().element() as HTMLButtonElement;
      button.addEventListener(
        "pointerdown",
        (event) => {
          setTimeout(() => {
            if (reason === "unmount") void screen.unmount();
            else if (reason === "windowblur") window.dispatchEvent(new Event("blur"));
            else if (reason === "blur")
              button.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
            else
              button.dispatchEvent(
                new PointerEvent(reason, {
                  bubbles: true,
                  pointerId: event.pointerId,
                  clientX: event.clientX + 30,
                  clientY: event.clientY,
                }),
              );
          }, 100);
        },
        { once: true },
      );
      // Unmount during a physical click may detach the target, but should never close other cards.
      await closeButton().click({ delay: TOAST_DISMISS_ALL_HOLD_MS + 100 });
      expect(otherClosed).not.toHaveBeenCalled();
      expect(heldClosed).not.toHaveBeenCalled();
      if (reason !== "unmount") {
        (closeButton().element() as HTMLElement).focus();
        await userEvent.keyboard("{Enter}");
        expect(heldClosed).toHaveBeenCalledOnce();
      }
      toastManager.close();
      if (reason !== "unmount") await settle();
    }
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("does not let hidden-thread notifications consume visible stack slots", async () => {
  const screen = await render(<ToastProvider />);
  try {
    toastManager.add({ title: "Visible card", type: "warning", timeout: 0 });
    for (let i = 0; i < 5; i++)
      toastManager.add({
        title: `Hidden ${i}`,
        timeout: 0,
        data: { threadId: ThreadId.makeUnsafe("other") },
      });
    await expect.element(screen.getByText("Visible card")).toBeVisible();
    const card = activeCards()[0]!;
    expect(card.hasAttribute("data-limited")).toBe(false);
    expect(card.inert).toBe(false);
    expect(card.style.getPropertyValue("--toast-index")).toBe("0");
    await closeButton().click();
    await expect.element(screen.getByText("Visible card")).not.toBeInTheDocument();
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});
