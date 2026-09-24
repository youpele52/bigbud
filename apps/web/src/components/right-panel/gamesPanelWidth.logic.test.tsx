import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RightPanelShell } from "./RightPanelShell";
import { resolveGamesPanelWidth, resolveRightPanelWidth } from "./gamesPanelWidth.logic";

describe("Games chat and browser split", () => {
  it("allocates a responsive 1:2 split after the sidebar collapses", () => {
    for (const viewportWidth of [1440, 1200]) {
      const width = resolveGamesPanelWidth({
        viewportWidth,
        leftSidebarWidth: 0,
        minimumBrowserWidth: 320,
      });
      expect(width).toBe(Math.floor((viewportWidth * 2) / 3));
      expect(viewportWidth - width).toBe(Math.ceil(viewportWidth / 3));
      const html = renderToStaticMarkup(
        <RightPanelShell open width={width}>
          <div>Game browser</div>
        </RightPanelShell>,
      );
      expect(html).toContain(`data-right-panel-placeholder="true" style="width:${width}px"`);
      expect(html).toContain("Game browser");
    }
  });

  it("uses available content width while the sidebar is open and preserves chat minimum", () => {
    expect(
      resolveGamesPanelWidth({
        viewportWidth: 1440,
        leftSidebarWidth: 240,
        minimumBrowserWidth: 320,
      }),
    ).toBe(800);
    expect(
      resolveGamesPanelWidth({ viewportWidth: 900, leftSidebarWidth: 0, minimumBrowserWidth: 320 }),
    ).toBe(516);
    expect(900 - 516).toBe(384);
  });

  it("leaves ordinary panel widths untouched", () => {
    const html = renderToStaticMarkup(
      <RightPanelShell open width={480}>
        <div>Files</div>
      </RightPanelShell>,
    );
    expect(html).toContain('data-right-panel-placeholder="true" style="width:480px"');
  });

  it("uses the temporary split only while the launched game tab is visible", () => {
    const width = (input: {
      gamesTabId: string | null;
      activeTabId: string | null;
      rightPanelOpen: boolean;
    }) => resolveRightPanelWidth({ normalWidth: 480, gamesWidth: 800, ...input });

    expect(width({ gamesTabId: "game", activeTabId: "game", rightPanelOpen: true })).toBe(800);
    expect(width({ gamesTabId: "game", activeTabId: "files", rightPanelOpen: true })).toBe(480);
    expect(width({ gamesTabId: "game", activeTabId: "game", rightPanelOpen: false })).toBe(480);
    expect(width({ gamesTabId: null, activeTabId: "game", rightPanelOpen: true })).toBe(480);
  });
});
