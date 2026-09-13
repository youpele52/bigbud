import "~/index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));
import { ToastProvider, toastManager } from "./toast";

afterEach(() => {
  document.body.innerHTML = "";
});

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
