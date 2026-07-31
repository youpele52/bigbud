import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserContextMenu } from "./BrowserPanel.contextMenu";
import { browserContextMenuAnchorFromHostPoint } from "./BrowserPanel.contextMenu.hook";

describe("BrowserContextMenu positioning", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("converts host coordinates and positions the menu at the click", async () => {
    const x = 34;
    const y = 56;
    const screen = await render(
      <div style={{ position: "fixed", top: 40, left: 70, transform: "translateX(0)" }}>
        <div style={{ height: 80 }} />
        <div data-testid="viewport" style={{ position: "relative", width: 400, height: 300 }}>
          <BrowserContextMenu
            anchor={browserContextMenuAnchorFromHostPoint(
              { left: 70, top: 120 },
              { x: 70 + x, y: 120 + y },
            )}
            items={[{ id: "inspect", label: "Inspect", onClick: () => {} }]}
            onClose={() => {}}
          />
        </div>
      </div>,
    );

    const viewport = screen.getByTestId("viewport").element();
    const menu = screen.getByRole("menu").element();
    const viewportRect = viewport.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    expect(menuRect.left - viewportRect.left).toBe(x);
    expect(menuRect.top - viewportRect.top).toBe(y);
  });

  it("keeps point-anchored menus inside the viewport", async () => {
    const screen = await render(
      <div data-testid="viewport" style={{ position: "relative", width: 400, height: 300 }}>
        <BrowserContextMenu
          anchor={{ kind: "point", x: 399, y: 299 }}
          items={[{ id: "inspect", label: "Inspect", onClick: () => {} }]}
          onClose={() => {}}
        />
      </div>,
    );

    const viewportRect = screen.getByTestId("viewport").element().getBoundingClientRect();
    const menuRect = screen.getByRole("menu").element().getBoundingClientRect();

    expect(menuRect.right).toBeLessThanOrEqual(viewportRect.right - 4);
    expect(menuRect.bottom).toBeLessThanOrEqual(viewportRect.bottom - 4);
  });

  it("clamps negative point anchors to the viewport inset", async () => {
    const screen = await render(
      <div data-testid="viewport" style={{ position: "relative", width: 400, height: 300 }}>
        <BrowserContextMenu
          anchor={{ kind: "point", x: -20, y: -30 }}
          items={[{ id: "inspect", label: "Inspect", onClick: () => {} }]}
          onClose={() => {}}
        />
      </div>,
    );

    const viewportRect = screen.getByTestId("viewport").element().getBoundingClientRect();
    const menuRect = screen.getByRole("menu").element().getBoundingClientRect();

    expect(menuRect.left).toBe(viewportRect.left + 4);
    expect(menuRect.top).toBe(viewportRect.top + 4);
  });

  it("centers menus opened from the keyboard", async () => {
    const screen = await render(
      <div data-testid="viewport" style={{ position: "relative", width: 400, height: 300 }}>
        <BrowserContextMenu
          anchor={{ kind: "center" }}
          items={[{ id: "inspect", label: "Inspect", onClick: () => {} }]}
          onClose={() => {}}
        />
      </div>,
    );

    const viewportRect = screen.getByTestId("viewport").element().getBoundingClientRect();
    const menuRect = screen.getByRole("menu").element().getBoundingClientRect();

    expect(menuRect.left + menuRect.width / 2).toBe(viewportRect.left + viewportRect.width / 2);
    expect(menuRect.top + menuRect.height / 2).toBe(viewportRect.top + viewportRect.height / 2);
  });
});
