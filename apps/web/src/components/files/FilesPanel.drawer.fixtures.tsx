import { useState } from "react";

import { FilesPanelLayout } from "./FilesPanel.layout";
import { renderFilesPanelTree } from "./FilesPanel.tree";
import { FilePreviewHeader } from "./FilePreviewHeader";

export interface DrawerHarnessProps {
  readonly initialPreview?: string | null;
  readonly contextMenuOpen?: boolean;
  readonly workspaceKey?: string;
  readonly width?: number;
  readonly onContextMenu?: () => void;
  readonly visible?: boolean;
}

export function DrawerHarness(props: DrawerHarnessProps) {
  const [preview, setPreview] = useState(props.initialPreview ?? null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ docs: true });
  const tree = renderFilesPanelTree({
    entries: [
      { path: "docs", kind: "directory" },
      ...Array.from({ length: 50 }, (_, index) => ({
        path: `file-${index}.ts`,
        kind: "file" as const,
      })),
    ],
    depth: 0,
    workspaceRoot: "/project",
    previewPath: preview,
    resolvedTheme: "dark",
    expandedDirectories: expanded,
    directoryStateByPath: {
      docs: { entries: [{ path: "docs/readme.md", kind: "file" }], loading: false, error: null },
    },
    onToggleDirectory: (entry) =>
      setExpanded((current) => ({ ...current, [entry.path]: !current[entry.path] })),
    onOpenFile: (entry) => setPreview(entry.path),
    onOpenContextMenu: () => props.onContextMenu?.(),
  });
  return (
    <div
      style={{ width: props.width ?? 900, height: 500 }}
      className={props.visible === false ? "invisible pointer-events-none" : undefined}
      inert={props.visible === false ? true : undefined}
    >
      <FilesPanelLayout
        hasPreview={preview !== null}
        workspaceKey={props.workspaceKey ?? "project"}
        contextMenuOpen={props.contextMenuOpen ?? false}
        visible={props.visible ?? true}
        treeBody={tree}
        preview={
          preview ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0" data-preview-toolbar>
                <FilePreviewHeader
                  breadcrumb={preview
                    .split("/")
                    .map((label, index) => ({ id: `${index}:${label}`, label }))}
                  absolutePath={`/project/${preview}`}
                  canNavigateBack={false}
                  canNavigateForward={false}
                  onNavigateBack={() => {}}
                  onNavigateForward={() => {}}
                  onClose={() => setPreview(null)}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto" data-preview-content>
                <div>{preview}</div>
                <div style={{ height: 1500 }}>Preview content</div>
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
}

export function treeRegion() {
  return document.querySelector<HTMLDivElement>('[aria-label="Files tree"]')!;
}

export function treeScroll() {
  return document.querySelector<HTMLDivElement>("[data-files-tree-scroll]")!;
}

export function previewRegion() {
  return document.querySelector<HTMLDivElement>("[data-files-preview]")!;
}

export function filesHandle() {
  return document.querySelector<HTMLButtonElement>("[data-files-tree-toggle]")!;
}

export function button(label: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

export function hover(element: Element, entering: boolean) {
  element.dispatchEvent(
    new PointerEvent(entering ? "pointerover" : "pointerout", {
      bubbles: true,
      pointerType: "mouse",
      relatedTarget: document.body,
    }),
  );
}

export function escape(element: Element) {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}
