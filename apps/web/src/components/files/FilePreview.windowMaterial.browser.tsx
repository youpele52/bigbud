import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  theme: { resolvedTheme: "dark" as "light" | "dark" },
}));
vi.mock("../../rpc/nativeApi", () => {
  const api = () => ({
    projects: {
      readFilePreview: mocks.read,
      writeFile: mocks.write,
      onDirectoryChange: () => () => {},
    },
  });
  return { readNativeApi: api, ensureNativeApi: api };
});
vi.mock("../../rpc/serverState", () => ({ useServerConfig: () => ({}) }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => mocks.theme }));

import { FilePreview } from "./FilePreview";
import { IpynbPreview } from "./IpynbPreview";
import { TooltipProvider } from "../ui/tooltip";

const html = document.documentElement;
const hash = "a".repeat(64);
const NOTEBOOK = JSON.stringify({
  cells: [
    {
      cell_type: "code",
      source: ["import numpy as np\n", "print(np.pi)"],
      execution_count: 1,
      outputs: [{ output_type: "stream", name: "stdout", text: ["3.14\n"] }],
    },
  ],
  metadata: { language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 5,
});
const MATERIALS = ["solid", "translucent"] as const;
const THEMES = ["light", "dark"] as const;

function setMaterial(material: (typeof MATERIALS)[number], theme: (typeof THEMES)[number]) {
  html.dataset.desktopShell = "macos";
  html.dataset.windowMaterial = material;
  html.classList.toggle("dark", theme === "dark");
  mocks.theme.resolvedTheme = theme;
}

/** Alpha of the given layers painted over nothing, in order, as the browser composites them. */
function coverage(layers: readonly string[]): number {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  for (const fill of layers) {
    context.fillStyle = fill;
    context.fillRect(0, 0, 1, 1);
  }
  return context.getImageData(0, 0, 1, 1).data[3]! / 255;
}

/** Every background painted from the viewer root down to `element`, outermost first. */
function viewerLayers(element: Element): string[] {
  const layers: string[] = [];
  const root = document.querySelector("[data-testid=viewer]")!;
  for (let node: Element | null = element; node && node !== root; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  return layers;
}

/** Computed background of a throwaway element built from `markup`, read at `selector`. */
function backgroundOf(markup: string, selector: string): string {
  const host = document.createElement("div");
  host.setAttribute("data-app-shell-side-panel", "");
  host.innerHTML = markup;
  document.body.append(host);
  const color = getComputedStyle(host.querySelector(selector)!).backgroundColor;
  host.remove();
  return color;
}

const paneFill = () => backgroundOf('<div class="bg-[var(--app-shell-pane-fill)]"></div>', "div");
// Highlighted chat code blocks (`index.markdown.css`) set the code cell surface to match.
const chatCodeBlock = () =>
  backgroundOf(
    '<div class="chat-markdown"><div class="chat-markdown-shiki"><pre class="shiki"></pre></div></div>',
    "pre",
  );

function viewer(children: React.ReactNode) {
  return (
    <TooltipProvider>
      <div data-testid="viewer" data-app-shell-side-panel style={{ width: 600, height: 400 }}>
        {children}
      </div>
    </TooltipProvider>
  );
}

const navigation = {
  canNavigateBack: false,
  canNavigateForward: false,
  onNavigateBack: () => {},
  onNavigateForward: () => {},
};

async function waitForElement(selector: string): Promise<HTMLElement> {
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull(), {
    timeout: 10_000,
  });
  return document.querySelector<HTMLElement>(selector)!;
}

describe("file viewers follow the window material", () => {
  beforeEach(() => {
    mocks.read.mockReset();
    mocks.write.mockReset();
  });

  afterEach(() => {
    delete html.dataset.desktopShell;
    delete html.dataset.windowMaterial;
    html.classList.remove("dark");
    document.body.innerHTML = "";
  });

  for (const material of MATERIALS) {
    for (const theme of THEMES) {
      it(`paints notebook code cells like chat code blocks (${material}, ${theme})`, async () => {
        setMaterial(material, theme);
        mocks.read.mockResolvedValue({
          contents: NOTEBOOK,
          truncated: false,
          sizeBytes: NOTEBOOK.length,
          sha256: hash,
        });
        const mounted = await render(
          viewer(<IpynbPreview cwd="/workspace" relativePath="analysis.ipynb" {...navigation} />),
        );
        try {
          const code = await waitForElement(".notebook-cell-code .shiki");
          const cell = code.closest(".notebook-cell-code")!.firstElementChild!;
          const notebook = document.querySelector("[data-testid=viewer]")!.firstElementChild!;

          // The page repaints the pane fill, so it is not tinted twice inside the right panel.
          expect(getComputedStyle(notebook).backgroundColor).toBe(paneFill());
          expect(getComputedStyle(cell).backgroundColor).toBe(chatCodeBlock());
          // The highlighter theme paints no background of its own over the cell surface.
          expect(coverage([getComputedStyle(code).backgroundColor])).toBe(0);
          const cellCoverage = coverage(viewerLayers(cell));
          if (material === "solid") expect(cellCoverage).toBe(1);
          else expect(cellCoverage).toBeLessThan(1);
        } finally {
          await mounted.unmount();
        }
      });

      it(`keeps the code viewer and editor on the pane fill (${material}, ${theme})`, async () => {
        setMaterial(material, theme);
        mocks.read.mockResolvedValue({
          contents: "import os\nprint(os.getcwd())\n",
          truncated: false,
          sizeBytes: 30,
          sha256: hash,
        });
        const mounted = await render(
          viewer(<FilePreview cwd="/workspace" relativePath="main.py" {...navigation} />),
        );
        try {
          const code = await waitForElement(".file-preview-code .shiki");
          const preview = document.querySelector("[data-testid=viewer]")!.firstElementChild!;
          expect(getComputedStyle(preview).backgroundColor).toBe(paneFill());
          expect(coverage([getComputedStyle(code).backgroundColor])).toBe(0);
          expect(coverage(viewerLayers(code))).toBe(material === "solid" ? 1 : 0);

          await page.getByRole("button", { name: "Edit file" }).click();
          const editor = await waitForElement("[data-file-preview-editor] diffs-container");
          await vi.waitFor(() =>
            expect(editor.shadowRoot?.querySelector("[data-file]")).not.toBeNull(),
          );
          // The syntax theme's opaque background gives way to the pane fill, shadow DOM included.
          expect(getComputedStyle(editor).backgroundColor).toBe(paneFill());
          for (const node of editor.shadowRoot!.querySelectorAll("[data-file], [data-gutter]")) {
            expect(coverage([getComputedStyle(node).backgroundColor])).toBe(
              material === "solid" ? 1 : 0,
            );
          }
          expect(coverage(viewerLayers(editor))).toBe(material === "solid" ? 1 : 0);
        } finally {
          await mounted.unmount();
        }
      });
    }
  }
});
