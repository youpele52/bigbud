import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { settleToastForPointer } from "./toast.browser.utils";
import { render } from "vitest-browser-react";
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
import { AnchoredToastProvider, anchoredToastManager, ToastProvider, toastManager } from "./toast";

afterEach(() => toastManager.close());

it("renders a blue progress spinner and removes it when the connection is restored", async () => {
  const screen = await render(<ToastProvider />);
  const id = toastManager.add({
    title: "Disconnected",
    description: "Reconnecting 4/8",
    type: "loading",
    timeout: 0,
  });
  await expect.element(screen.getByText("Reconnecting 4/8")).toBeVisible();
  const icon = document.querySelector('[data-slot="toast-icon"] svg');
  expect(icon?.classList.contains("lucide-loader-circle")).toBe(true);
  expect(icon?.classList.contains("text-info-foreground")).toBe(true);
  expect(icon && getComputedStyle(icon).animationName).not.toBe("none");
  const title = document.querySelector('[data-slot="toast-title"]');
  const description = document.querySelector('[data-slot="toast-description"]');
  expect(title && description && getComputedStyle(title).fontSize).toBe(
    description && getComputedStyle(description).fontSize,
  );
  expect(title && icon && getComputedStyle(title).color).not.toBe(
    icon && getComputedStyle(icon).color,
  );
  expect(icon?.parentElement?.nextElementSibling?.contains(title)).toBe(true);
  toastManager.update(id, { type: "success", title: "Reconnected", data: {} });
  await expect.element(screen.getByText("Reconnected", { exact: true })).toBeVisible();
  expect(document.querySelector(".lucide-wifi")).toBeNull();
  expect(document.querySelector('[data-slot="toast-icon"]')).toBeNull();
  toastManager.close(id);
  await expect.element(screen.getByText("Reconnected", { exact: true })).not.toBeInTheDocument();
});

it("lets the shared close control dismiss every toast type", async () => {
  const screen = await render(<ToastProvider />);

  for (const type of ["error", "info", "loading", "success", "warning"] as const) {
    const title = `${type} notification`;
    toastManager.add({ title, type, timeout: 0 });

    await expect.element(screen.getByText(title)).toBeVisible();
    const popup = screen
      .getByText(title)
      .element()
      .closest<HTMLElement>('[data-slot="toast-popup"]')!;
    await settleToastForPointer(popup);
    await page
      .elementLocator(
        popup.querySelector<HTMLButtonElement>('button[aria-label="Close notification"]')!,
      )
      .click();
    await expect.element(screen.getByText(title)).not.toBeInTheDocument();
  }
});

it("lets the shared close control dismiss anchored notifications", async () => {
  const screen = await render(
    <>
      <button data-testid="toast-anchor" type="button">
        Anchor
      </button>
      <AnchoredToastProvider />
    </>,
  );
  anchoredToastManager.add({
    title: "Anchored notification",
    type: "info",
    timeout: 0,
    positionerProps: { anchor: document.querySelector('[data-testid="toast-anchor"]') },
  });

  await expect.element(screen.getByText("Anchored notification")).toBeVisible();
  await settleToastForPointer(
    screen
      .getByText("Anchored notification")
      .element()
      .closest<HTMLElement>('[data-slot="toast-popup"]')!,
  );
  await screen.getByRole("button", { name: "Close notification" }).click();
  await expect.element(screen.getByText("Anchored notification")).not.toBeInTheDocument();
});
