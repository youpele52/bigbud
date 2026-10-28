import "~/index.css";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ToastProvider, toastManager } from "./toast";

vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

it("preserves Base UI's live region, priority semantics, and keyboard exclusion of overflow cards", async () => {
  const screen = await render(
    <ToastProvider>
      <button type="button">Outside</button>
    </ToastProvider>,
  );
  try {
    for (let i = 0; i < 8; i++)
      toastManager.add({
        title: `Accessible ${i}`,
        timeout: 0,
        type: "info",
        priority: i === 7 ? "high" : "low",
        actionProps: { children: `Action ${i}` },
      });
    await expect.element(screen.getByText("Accessible 7").first()).toBeVisible();
    const viewport = document.querySelector('[data-slot="toast-viewport"]')!;
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("aria-live")).toBe("polite");
    const cards = Array.from(viewport.querySelectorAll<HTMLElement>('[data-slot="toast-popup"]'));
    expect(cards.filter((card) => card.inert)).toHaveLength(5);
    expect(cards[0]!.getAttribute("role")).toBe("alertdialog");
    expect(cards[0]!.getAttribute("aria-hidden")).toBe("true");
    await screen.getByRole("button", { name: "Outside" }).click();
    await userEvent.keyboard("{F6}{Tab}");
    expect(cards[0]!.contains(document.activeElement)).toBe(true);
    expect(cards[0]!.getAttribute("aria-hidden")).not.toBe("true");
    // Every keyboard-reachable action is in the visible three-card subset.
    for (let i = 0; i < 10; i++) {
      const focusedCard = document.activeElement?.closest<HTMLElement>('[data-slot="toast-popup"]');
      if (focusedCard) expect(focusedCard.inert).toBe(false);
      await userEvent.keyboard("{Tab}");
    }
  } finally {
    toastManager.close();
    await screen.unmount();
  }
});
