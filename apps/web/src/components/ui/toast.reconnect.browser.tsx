import "~/index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
import { AnchoredToastProvider, anchoredToastManager, ToastProvider, toastManager } from "./toast";

it("renders a leading amber Wi-Fi icon with neutral text and restores the severity icon on update", async () => {
  const screen = await render(<ToastProvider />);
  const id = toastManager.add({
    title: "Disconnected",
    description: "Reconnecting 4/8",
    type: "loading",
    timeout: 0,
    data: { icon: "wifi" },
  });
  await expect.element(screen.getByText("Reconnecting 4/8")).toBeVisible();
  const icon = document.querySelector('[data-slot="toast-icon"] svg');
  expect(icon?.classList.contains("lucide-wifi")).toBe(true);
  expect(icon?.classList.contains("text-warning")).toBe(true);
  expect(icon && getComputedStyle(icon).animationName).toBe("none");
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
  expect(document.querySelector(".lucide-circle-check")).not.toBeNull();
  toastManager.close(id);
});

it("lets the shared close control dismiss every toast type", async () => {
  const screen = await render(<ToastProvider />);

  for (const type of ["error", "info", "loading", "success", "warning"] as const) {
    const title = `${type} notification`;
    toastManager.add({ title, type, timeout: 0 });

    await expect.element(screen.getByText(title)).toBeVisible();
    await screen.getByRole("button", { name: "Close notification" }).click();
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
  await screen.getByRole("button", { name: "Close notification" }).click();
  await expect.element(screen.getByText("Anchored notification")).not.toBeInTheDocument();
});
