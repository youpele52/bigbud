import "../../index.css";

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { renderFilesPanelTreeBody } from "../files/FilesPanel.body";
import { WorkspaceRequestStatus } from "./WorkspaceRequestStatus";

function expectCenteredLogo(container: Element) {
  const bounds = container.getBoundingClientRect();
  const logo = container.querySelector("svg")!.getBoundingClientRect();
  expect(Math.abs(logo.left + logo.width / 2 - bounds.left - bounds.width / 2)).toBeLessThan(1);
  expect(Math.abs(logo.top + logo.height / 2 - bounds.top - bounds.height / 2)).toBeLessThan(1);
  const label = container.querySelector("span")!;
  expect(label.classList.contains("sr-only")).toBe(true);
  expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  expect(label.getBoundingClientRect().height).toBeLessThanOrEqual(1);
}

describe("workspace logo-only loading", () => {
  it("centers the compact logo and keeps the recovery label screen-reader-only", async () => {
    await render(
      <div style={{ width: 300 }}>
        <WorkspaceRequestStatus recovering />
      </div>,
    );
    const status = page.getByRole("status");
    await expect.element(status).toHaveTextContent("Reconnecting to workspace…");
    await expect.element(status).toHaveAttribute("aria-live", "polite");
    expectCenteredLogo(status.element());
  });

  it("centers the logo in both dimensions of the empty files panel", async () => {
    await render(
      <div style={{ width: 300, height: 240 }}>
        {renderFilesPanelTreeBody({
          remote: true,
          showLoading: true,
          recovering: true,
          error: null,
          entries: [],
          workspaceRoot: "/srv/project",
          previewPath: null,
          resolvedTheme: "dark",
          expandedDirectories: {},
          directoryStateByPath: {},
          onToggleDirectory: () => undefined,
          onOpenFile: () => undefined,
          onOpenContextMenu: () => undefined,
        })}
      </div>,
    );
    const status = page.getByRole("status");
    await expect.element(status).toHaveTextContent("Reconnecting to workspace…");
    expect(status.element().getBoundingClientRect().height).toBe(240);
    expectCenteredLogo(status.element());
  });
});
