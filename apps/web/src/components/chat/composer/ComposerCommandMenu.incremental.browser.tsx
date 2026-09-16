import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const models: ComposerCommandItem[] = Array.from({ length: 32 }, (_, index) => ({
  id: `model:opencode:default:model-${index + 1}`,
  type: "model",
  provider: "opencode",
  model: `model-${index + 1}`,
  subProviderID: "example",
  label: `Model ${index + 1}`,
  description: `OpenCode · model-${index + 1}`,
}));

function Menu({
  activeItemId = null,
  onSelect = vi.fn(),
}: {
  activeItemId?: string | null;
  onSelect?: (item: ComposerCommandItem) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <ComposerCommandMenu
      items={models.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="slash-model"
      discoverySearch={{ command: "model", query, onQueryChange: setQuery }}
      activeItemId={activeItemId}
      onHighlightedItemChange={vi.fn()}
      onSelect={onSelect}
    />
  );
}

function rows() {
  return document.querySelectorAll("[data-composer-item-id]");
}

function viewport() {
  const element = document.querySelector('[data-slot="scroll-area-viewport"]');
  if (!(element instanceof HTMLElement)) throw new Error("Missing scroll viewport");
  return element;
}

async function scrollToBottom() {
  const element = viewport();
  if (element.scrollHeight <= element.clientHeight) {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
  } else {
    element.scrollTop = element.scrollHeight;
  }
}

describe("ComposerCommandMenu incremental models", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts with five and reveals five more per scroll, including the final partial page", async () => {
    const mounted = await render(<Menu />);
    try {
      await vi.waitFor(() => expect(rows()).toHaveLength(5));
      for (const count of [10, 15, 20, 25, 30, 32]) {
        await scrollToBottom();
        await vi.waitFor(() => expect(rows()).toHaveLength(count));
      }
      await scrollToBottom();
      expect(rows()).toHaveLength(32);
    } finally {
      await mounted.unmount();
    }
  });

  it("can load the next page with a wheel gesture when five rows do not overflow", async () => {
    const mounted = await render(<Menu />);
    try {
      await vi.waitFor(() => expect(rows()).toHaveLength(5));
      viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true }));
      await vi.waitFor(() => expect(rows()).toHaveLength(10));
    } finally {
      await mounted.unmount();
    }
  });

  it("searches beyond loaded models and resets to five when clearing search", async () => {
    const onSelect = vi.fn();
    const mounted = await render(<Menu onSelect={onSelect} />);
    try {
      await scrollToBottom();
      await vi.waitFor(() => expect(rows()).toHaveLength(10));
      await page.getByPlaceholder("Search models").fill("Model 32");
      await vi.waitFor(() => {
        expect(rows()).toHaveLength(1);
        expect(rows()[0]?.textContent).toContain("Model 32");
      });
      await page.getByText("Model 32", { exact: true }).click();
      expect(onSelect).toHaveBeenCalledWith(models[31]);
      await page.getByPlaceholder("Search models").fill("");
      await vi.waitFor(() => expect(rows()).toHaveLength(5));
    } finally {
      await mounted.unmount();
    }
  });

  it("reveals the next page when composer keyboard navigation advances the active item", async () => {
    const mounted = await render(<Menu activeItemId={models[0]!.id} />);
    try {
      await vi.waitFor(() => expect(rows()).toHaveLength(5));
      await mounted.rerender(<Menu activeItemId={models[5]!.id} />);
      await vi.waitFor(() => {
        expect(rows()).toHaveLength(10);
        expect(document.querySelector(`[data-composer-item-id="${models[5]!.id}"]`)).not.toBeNull();
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps other command lists fully rendered", async () => {
    const items: ComposerCommandItem[] = Array.from({ length: 12 }, (_, index) => ({
      id: `command-${index}`,
      type: "slash-command",
      command: `command-${index}`,
      label: `Command ${index}`,
      description: "Provider command",
    }));
    const mounted = await render(
      <ComposerCommandMenu
        items={items}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        discoverySearch={null}
        activeItemId={null}
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    try {
      await vi.waitFor(() => expect(rows()).toHaveLength(12));
    } finally {
      await mounted.unmount();
    }
  });

  it("starts at five again after reopening", async () => {
    const mounted = await render(<Menu />);
    await scrollToBottom();
    await vi.waitFor(() => expect(rows()).toHaveLength(10));
    await mounted.unmount();
    const reopened = await render(<Menu />);
    try {
      await vi.waitFor(() => expect(rows()).toHaveLength(5));
    } finally {
      await reopened.unmount();
    }
  });
});
