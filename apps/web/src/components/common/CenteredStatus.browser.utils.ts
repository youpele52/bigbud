import { expect } from "vitest";

/** Verify centered logos and labels for both loading and static messages. */
export function expectCenteredStatuses(host: Element): void {
  const statuses = host.querySelectorAll('[data-slot="centered-status"]');
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of statuses) {
    const bounds = status.getBoundingClientRect();
    expect(getComputedStyle(status).textAlign).toBe("center");
    expect(getComputedStyle(status).alignItems).toBe("center");
    expect(getComputedStyle(status).justifyContent).toBe("center");
    const logo = status.querySelector("svg");
    if (status.getAttribute("data-loading") === "true") {
      expect(logo).not.toBeNull();
      expect(logo!.getAttribute("aria-hidden")).toBe("true");
      const logoBounds = logo!.getBoundingClientRect();
      expect(logoBounds.height).toBeLessThanOrEqual(20);
      expect((logoBounds.left + logoBounds.right) / 2).toBeCloseTo(
        (bounds.left + bounds.right) / 2,
        0,
      );
      expect(logo!.classList.contains("motion-reduce:animate-none")).toBe(true);
      expect(logo!.classList.contains("text-muted-foreground/40")).toBe(true);
      expect(getComputedStyle(status.lastElementChild!).textTransform).toBe("none");
      expect(status.lastElementChild!.textContent?.trim()).toMatch(/^[A-Z]/);
    } else {
      expect(logo).toBeNull();
    }
    const text = status.lastElementChild!;
    expect(getComputedStyle(text).textAlign).toBe("center");
    if (status.getAttribute("data-loading") === "true")
      expect(text.textContent).not.toMatch(/(?:…|\.{3})/);
    expect(status.scrollWidth).toBeLessThanOrEqual(status.clientWidth);
  }
}
