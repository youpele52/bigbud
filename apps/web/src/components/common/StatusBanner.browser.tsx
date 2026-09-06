import "../../index.css";

import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StatusBanner } from "./StatusBanner";

describe("StatusBanner", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("uses the neutral variant by default and always renders its description", async () => {
    await render(<StatusBanner description="A status description" />);

    const alert = page.getByRole("alert");
    await expect.element(alert).toHaveClass("bg-transparent");
    await expect.element(page.getByText("A status description")).toBeInTheDocument();
    await expect.element(page.getByText("Optional title")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button")).not.toBeInTheDocument();
  });

  it("renders an explicit icon, optional title, action, and default dismiss label", async () => {
    const onDismiss = vi.fn();
    await render(
      <StatusBanner
        icon={<TriangleAlertIcon data-testid="status-icon" />}
        title="Optional title"
        description="A status description"
        action={<button type="button">Retry</button>}
        onDismiss={onDismiss}
      />,
    );

    await expect.element(page.getByTestId("status-icon")).toBeInTheDocument();
    await expect.element(page.getByText("Optional title")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    const action = document.querySelector('[data-slot="alert-action"]');
    expect(
      Array.from(action?.querySelectorAll("button") ?? []).map((button) => button.textContent),
    ).toEqual(["Retry", ""]);

    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each([
    ["default", "bg-transparent"],
    ["info", "bg-info/4"],
    ["success", "bg-success/4"],
    ["warning", "bg-warning/4"],
    ["error", "bg-destructive/4"],
  ] as const)("supports the %s variant", async (variant, className) => {
    await render(<StatusBanner variant={variant} description="A status description" />);

    await expect.element(page.getByRole("alert")).toHaveClass(className);
  });

  it("forwards className and supports a custom dismiss label", async () => {
    await render(
      <StatusBanner
        className="custom-status-banner"
        description="A status description"
        dismissLabel="Close status"
        onDismiss={() => {}}
      />,
    );

    await expect.element(page.getByRole("alert")).toHaveClass("custom-status-banner");
    await expect.element(page.getByRole("button", { name: "Close status" })).toBeInTheDocument();
  });

  it.each([
    ["default", "text-muted-foreground/60"],
    ["warning", "text-warning/60"],
    ["error", "text-destructive/60"],
  ] as const)("uses the %s close-button color", async (variant, className) => {
    await render(
      <StatusBanner variant={variant} description="A status description" onDismiss={() => {}} />,
    );

    await expect.element(page.getByRole("button", { name: "Dismiss" })).toHaveClass(className);
  });

  it("accepts a ReactNode description", async () => {
    await render(
      <StatusBanner
        icon={<CircleAlertIcon />}
        description={<span data-testid="description-node">Rich description</span>}
      />,
    );

    await expect.element(page.getByTestId("description-node")).toBeInTheDocument();
  });
});
