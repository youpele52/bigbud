import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CenteredStatus } from "./CenteredStatus";
import { expectCenteredStatuses } from "./CenteredStatus.browser.utils";

it.each([false, true])("centers compact loading and static states (dark: %s)", async (dark) => {
  document.documentElement.classList.toggle("dark", dark);
  const screen = await render(
    <div className="bg-background p-4 text-foreground" style={{ width: 280 }} data-testid="surface">
      <CenteredStatus loading className="h-28 capitalize">
        waiting for history
      </CenteredStatus>
      <CenteredStatus>Measurements unavailable</CenteredStatus>
    </div>,
  );
  try {
    const surface = screen.getByTestId("surface").element();
    expectCenteredStatuses(surface);
    const status = surface.querySelector('[data-loading="true"]')!;
    const bounds = status.getBoundingClientRect();
    const logo = status.querySelector("svg")!;
    const logoBounds = logo.getBoundingClientRect();
    const textBounds = status.lastElementChild!.getBoundingClientRect();
    expect(status.lastElementChild!.textContent).toBe("Waiting for history");
    expect((logoBounds.top + textBounds.bottom) / 2).toBeCloseTo(
      (bounds.top + bounds.bottom) / 2,
      0,
    );
    expect(getComputedStyle(logo).animationName).toBe(
      matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : "breathe",
    );
  } finally {
    await screen.unmount();
    document.documentElement.classList.remove("dark");
  }
});
