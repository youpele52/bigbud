import { KanbanCardId } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BIGBUD_KANBAN_CARD_DRAG_MIME,
  createKanbanCardDragImage,
  KANBAN_CARD_SURFACE_CLASS,
  prepareKanbanCardDragStart,
} from "./kanban.dnd";

function createGhostElement(label: { textContent: string }) {
  const style: Record<string, string> = {};
  const ghost = {
    style: new Proxy({} as CSSStyleDeclaration, {
      set(_target, property, value) {
        if (typeof property === "string") {
          style[property] = String(value);
        }
        return true;
      },
      get(_target, property) {
        if (typeof property === "string") {
          return style[property] ?? "";
        }
        return undefined;
      },
    }),
    className: KANBAN_CARD_SURFACE_CLASS,
    classList: {
      add(className: string) {
        ghost.className = `${ghost.className} ${className}`.trim();
      },
    },
    querySelector: () => label,
    textContent: label.textContent,
    remove: vi.fn(),
  };

  return ghost;
}

function createSourceElement(title: string): HTMLElement {
  const label = { textContent: title };
  const element = {
    className: KANBAN_CARD_SURFACE_CLASS,
    innerHTML: `<span>${title}</span>`,
    querySelector: () => label,
    getBoundingClientRect: () => ({ width: 240 }),
    cloneNode: () => createGhostElement(label),
  };

  return element as unknown as HTMLElement;
}

describe("kanban.dnd", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defines pill-shaped card surfaces", () => {
    expect(KANBAN_CARD_SURFACE_CLASS).toContain("rounded-2xl");
  });

  it("keeps pill styling on the drag ghost", () => {
    const source = createSourceElement("sleep earlier than 12am");
    const ghost = createKanbanCardDragImage(source, "sleep earlier than 12am");

    expect(ghost.className).toContain("rounded-2xl");
    expect(ghost.style.borderRadius).toBe("1rem");
    expect(ghost.textContent).toContain("sleep earlier than 12am");
  });

  it("sets board and composer drag payloads with a custom drag image", () => {
    const source = createSourceElement("What does feel like");
    const appended: HTMLElement[] = [];
    const setDragImage = vi.fn();
    const setData = vi.fn();

    vi.stubGlobal("document", {
      body: {
        appendChild: (node: HTMLElement) => {
          appended.push(node);
        },
      },
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
      },
    });

    const event = {
      currentTarget: source,
      nativeEvent: { offsetX: 18, offsetY: 20 },
      dataTransfer: {
        effectAllowed: "",
        setData,
        setDragImage,
      },
    } as unknown as React.DragEvent<HTMLElement>;

    const cardId = KanbanCardId.makeUnsafe("kanban/global/task-1.md");
    prepareKanbanCardDragStart(event, {
      cardId,
      title: "What does feel like",
      absolutePath: "/tmp/kanban/global/task-1.md",
    });

    expect(setData).toHaveBeenCalledWith(BIGBUD_KANBAN_CARD_DRAG_MIME, cardId);
    expect(setData).toHaveBeenCalledWith("text/plain", "What does feel like");
    expect(setDragImage).toHaveBeenCalledTimes(1);
    expect(appended[0]?.className).toContain("rounded-2xl");
    expect(appended[0]?.style.borderRadius).toBe("1rem");
    expect(setDragImage.mock.calls[0]?.[1]).toBe(18);
    expect(setDragImage.mock.calls[0]?.[2]).toBe(20);
  });
});
