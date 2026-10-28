import "~/index.css";
import { expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ToastProvider, toastManager } from "./toast";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

const longDescription = Array.from({ length: 30 }, (_, index) => `Message line ${index + 1}`).join(
  "\n",
);
const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-popup"]'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

function expectInside(card: HTMLElement, element: Element) {
  const outer = card.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  expect(inner.top).toBeGreaterThanOrEqual(outer.top);
  expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
}

it("bounds short and long cards while keeping close, copy, and action controls accessible", async () => {
  const action = vi.fn();
  const screen = await render(<ToastProvider />);
  try {
    toastManager.add({ title: "Short notification", timeout: 0 });
    await expect.element(screen.getByText("Short notification")).toBeVisible();
    await settle();
    expect(cards()[0]!.offsetHeight).toBe(48);
    await screen.getByRole("button", { name: "Close notification" }).click();
    await expect.element(screen.getByText("Short notification")).not.toBeInTheDocument();
    toastManager.add({
      title: "Long notification",
      description: longDescription,
      type: "error",
      timeout: 0,
      actionProps: { children: "View details", onClick: action },
    });
    await expect.element(screen.getByText("Long notification")).toBeVisible();
    await settle();
    const card = cards()[0]!;
    expect(card.offsetHeight).toBe(120);
    expectInside(card, screen.getByRole("button", { name: "Close notification" }).element());
    expectInside(card, screen.getByRole("button", { name: "View details" }).element());
    const message = card.querySelector<HTMLElement>('[data-slot="toast-message"]')!;
    expect(message.scrollHeight).toBeGreaterThan(message.clientHeight);
    message.focus();
    await userEvent.keyboard("{End}");
    await expect.poll(() => message.scrollTop).toBeGreaterThan(0);
    const copy = card.querySelector<HTMLButtonElement>('[title="Copy error"]')!;
    copy.focus();
    expectInside(card, copy);
    await screen.getByRole("button", { name: "View details" }).click();
    expect(action).toHaveBeenCalledOnce();
    await screen.getByRole("button", { name: "Close notification" }).click();
    await expect.element(screen.getByText("Long notification")).not.toBeInTheDocument();
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("uses bounded heights for stack spacing, including content updates", async () => {
  const screen = await render(<ToastProvider />);
  try {
    const id = toastManager.add({ title: "Older short card", timeout: 0 });
    toastManager.add({ title: "Newer long card", description: longDescription, timeout: 0 });
    await expect.element(screen.getByText("Newer long card")).toBeVisible();
    await screen.getByText("Newer long card").hover();
    await settle();
    const checkStack = () => {
      const stack = cards();
      for (const card of stack) {
        expect(card.offsetHeight).toBeGreaterThanOrEqual(48);
        expect(card.offsetHeight).toBeLessThanOrEqual(120);
      }
      expect(stack[1]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        stack[0]!.getBoundingClientRect().bottom + 10,
      );
    };
    checkStack();
    toastManager.update(id, { description: longDescription });
    await expect.poll(() => cards()[1]!.offsetHeight).toBe(120);
    await settle();
    checkStack();
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});

it("allows touch scrolling inside a long message without dismissing the toast", async () => {
  const screen = await render(<ToastProvider />);
  try {
    toastManager.add({ title: "Scrollable message", description: longDescription, timeout: 0 });
    await expect.element(screen.getByText("Scrollable message")).toBeVisible();
    await settle();
    const message = cards()[0]!.querySelector<HTMLElement>('[data-slot="toast-message"]')!;
    expect(message).not.toBeNull();
    const bounds = message.getBoundingClientRect();
    const frame = window.frameElement?.getBoundingClientRect();
    const scaleX = frame ? frame.width / window.innerWidth : 1;
    const scaleY = frame ? frame.height / window.innerHeight : 1;
    const x = (bounds.left + bounds.width / 2) * scaleX + (frame?.left ?? 0);
    const y = (bounds.bottom - 5) * scaleY + (frame?.top ?? 0);
    const input = cdp();
    expect(message.scrollHeight).toBeGreaterThan(message.clientHeight);
    await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    expect(message.hasAttribute("data-base-ui-swipe-ignore")).toBe(true);
    for (let step = 1; step <= 8; step++) {
      await input.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y - step * 12 }],
      });
    }
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => message.scrollTop).toBeGreaterThan(0);
    await expect.element(screen.getByText("Scrollable message")).toBeInTheDocument();
    expect(cards()[0]!.hasAttribute("data-ending-style")).toBe(false);
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});
