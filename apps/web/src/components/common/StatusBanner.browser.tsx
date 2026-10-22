import "../../index.css";

import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useBannerDismissalStore } from "../../stores/ui/bannerDismissal.store";
import { StatusBanner } from "./StatusBanner";

describe("StatusBanner", () => {
  afterEach(() => {
    useBannerDismissalStore.setState({ dismissed: new Set() });
    document.body.innerHTML = "";
  });

  it("uses the neutral variant by default and always renders its description", async () => {
    await render(
      <StatusBanner dismissalKey={["status-test"]} description="A status description" />,
    );

    const alert = page.getByRole("alert");
    await expect.element(alert).toHaveClass("bg-transparent");
    await expect.element(page.getByText("A status description")).toBeInTheDocument();
    await expect.element(page.getByText("Optional title")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  it("supports nonurgent status semantics without changing the default alert role", async () => {
    const screen = await render(
      <StatusBanner
        dismissalKey={["status-test"]}
        role="status"
        description="Nonurgent information"
      />,
    );
    await expect.element(page.getByRole("status")).toHaveClass("bg-transparent");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await screen.rerender(
      <StatusBanner
        dismissalKey={["status-test"]}
        variant="warning"
        description="Actual warning"
      />,
    );
    await expect.element(page.getByRole("alert")).toHaveClass("bg-warning/4");
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();

    await screen.rerender(
      <StatusBanner dismissalKey={["status-test"]} variant="error" description="Actual error" />,
    );
    await expect.element(page.getByRole("alert")).toHaveClass("bg-destructive/4");
  });

  it("renders an explicit icon, optional title, action, and default dismiss label", async () => {
    const onDismiss = vi.fn();
    await render(
      <StatusBanner
        dismissalKey={["status-test"]}
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
    await render(
      <StatusBanner
        dismissalKey={["status-test"]}
        variant={variant}
        description="A status description"
      />,
    );

    await expect.element(page.getByRole("alert")).toHaveClass(className);
  });

  it("forwards className and supports a custom dismiss label", async () => {
    await render(
      <StatusBanner
        dismissalKey={["status-test"]}
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
      <StatusBanner
        dismissalKey={["status-test"]}
        variant={variant}
        description="A status description"
        onDismiss={() => {}}
      />,
    );

    await expect.element(page.getByRole("button", { name: "Dismiss" })).toHaveClass(className);
  });

  it("accepts a ReactNode description", async () => {
    await render(
      <StatusBanner
        dismissalKey={["status-test"]}
        icon={<CircleAlertIcon />}
        description={<span data-testid="description-node">Rich description</span>}
      />,
    );

    await expect.element(page.getByTestId("description-node")).toBeInTheDocument();
  });

  it("centers optional status content without blocking dismissal", async () => {
    const dismiss = vi.fn();
    await render(
      <div style={{ width: 280 }}>
        <StatusBanner
          dismissalKey={["status-test"]}
          centered
          variant="warning"
          icon={<TriangleAlertIcon />}
          title="Unavailable"
          description="Usage unavailable for this provider."
          onDismiss={dismiss}
        />
      </div>,
    );
    const alert = page.getByRole("alert").element();
    const bounds = alert.getBoundingClientRect();
    const title = page.getByText("Unavailable", { exact: true }).element();
    expect(getComputedStyle(title).textAlign).toBe("center");
    const titleBounds = title.getBoundingClientRect();
    expect((titleBounds.left + titleBounds.right) / 2).toBeCloseTo(
      (bounds.left + bounds.right) / 2,
      0,
    );
    expect(alert.scrollWidth).toBeLessThanOrEqual(alert.clientWidth);
    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

it("synchronizes matching mounted banners, survives remount/copy changes, and resets on a new run", async () => {
  useBannerDismissalStore.setState({ serverRunId: "run-one", dismissed: new Set() });
  const screen = await render(
    <>
      <StatusBanner
        dismissalKey={["shared-notice"]}
        description="First presentation"
        dismissLabel="Close first"
      />
      <StatusBanner
        dismissalKey={["shared-notice"]}
        description="Second presentation"
        dismissLabel="Close second"
      />
      <StatusBanner dismissalKey={["independent-notice"]} description="Independent notice" />
    </>,
  );
  await page.getByRole("button", { name: "Close first" }).click();
  await expect.element(page.getByText("First presentation")).not.toBeInTheDocument();
  await expect.element(page.getByText("Second presentation")).not.toBeInTheDocument();
  await expect.element(page.getByText("Independent notice")).toBeVisible();
  await screen.unmount();
  await render(<StatusBanner dismissalKey={["shared-notice"]} description="Updated copy" />);
  await expect.element(page.getByText("Updated copy")).not.toBeInTheDocument();
  useBannerDismissalStore.getState().observeRun("run-two");
  await expect.element(page.getByText("Updated copy")).toBeVisible();
  useBannerDismissalStore.setState({ serverRunId: null, dismissed: new Set() });
  document.body.innerHTML = "";
});
