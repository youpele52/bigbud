import "../../index.css";

import { type ComponentProps } from "react";
import { expect, vi, type Mock } from "vitest";
import { render } from "vitest-browser-react";

interface PreviewReadInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly executionTargetId?: string;
}

interface PreviewResult {
  readonly contents: string;
  readonly truncated: boolean;
}

interface WatchSubscription {
  readonly input: Omit<PreviewReadInput, "relativePath"> & { readonly relativePath?: string };
  readonly callback: () => void;
  readonly unsubscribe: Mock;
}

interface PreviewMocks {
  readonly read: Mock<(input: PreviewReadInput) => Promise<PreviewResult>>;
  readonly watches: WatchSubscription[];
  readonly loadError: Mock;
  readonly annotation: Mock;
  readonly back: Mock;
  readonly forward: Mock;
  readonly close: Mock;
}

const mocks: PreviewMocks = vi.hoisted(() => ({
  read: vi.fn<(input: PreviewReadInput) => Promise<PreviewResult>>(),
  watches: [] as WatchSubscription[],
  loadError: vi.fn(),
  annotation: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../rpc/nativeApi", () => {
  const api = {
    projects: {
      readFilePreview: mocks.read,
      onDirectoryChange: (input: WatchSubscription["input"], callback: () => void) => {
        const unsubscribe = vi.fn();
        mocks.watches.push({ input, callback, unsubscribe });
        return unsubscribe;
      },
    },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});
vi.mock("../../rpc/serverState", () => ({
  useServerConfig: () => ({
    workspaceCapabilities: { remoteAgent: { supportsDirectoryWatch: true } },
  }),
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { FilePreview } from "./FilePreview";
import { TooltipProvider } from "../ui/tooltip";
import { useSearchStore } from "../../stores/ui/search.store";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";
import { useFilesPanelScrollPersistence } from "./useFilesPanelHistory";

export const previewMocks: PreviewMocks = mocks;

export const INTEGRATION_CONTENTS = [
  "---",
  "title: Scroll integration",
  "---",
  "",
  ...Array.from({ length: 42 }, (_value, index) =>
    [
      `## Section ${index + 1}`,
      "",
      `Reading passage ${index + 1}: a paragraph that wraps across several visual lines in the narrow file panel, while remaining a single original source line.`,
      "",
    ].join("\n"),
  ),
].join("\n");

export const HISTORY_WORKSPACE = "scroll-integration-workspace";
type PreviewProps = Partial<ComponentProps<typeof FilePreview>>;

export function previewView(props: PreviewProps = {}) {
  return (
    <TooltipProvider>
      <div style={{ width: 480, height: 280 }}>
        <FilePreview
          cwd="/workspace"
          relativePath="docs/CHANGELOG.md"
          canNavigateBack={false}
          canNavigateForward={false}
          onNavigateBack={previewMocks.back}
          onNavigateForward={previewMocks.forward}
          onClose={previewMocks.close}
          onPreviewLoadError={previewMocks.loadError}
          onCreateAnnotation={previewMocks.annotation}
          {...props}
        />
      </div>
    </TooltipProvider>
  );
}

export async function mountPreview(props: PreviewProps = {}) {
  const mounted = await render(previewView(props));
  await vi.waitFor(() => expect(document.querySelector(".file-preview-markdown")).not.toBeNull());
  assertScrollable(previewViewport());
  return mounted;
}

export function previewViewport(): HTMLDivElement {
  const content = document.querySelector<HTMLDivElement>(".file-preview-markdown");
  expect(content).not.toBeNull();
  return content!.parentElement!.parentElement! as HTMLDivElement;
}

export function rawViewport(): HTMLDivElement {
  const content = document.querySelector<HTMLDivElement>(".file-preview-code");
  expect(content).not.toBeNull();
  return content!.parentElement!.parentElement! as HTMLDivElement;
}

export function assertScrollable(viewport: HTMLDivElement) {
  expect(viewport.clientHeight).toBeGreaterThan(0);
  expect(viewport.scrollHeight - viewport.clientHeight).toBeGreaterThan(1_000);
}

export async function switchMode(mode: "raw" | "preview") {
  document
    .querySelector<HTMLButtonElement>(
      mode === "raw" ? '[aria-label="View raw markdown"]' : '[aria-label="View markdown preview"]',
    )!
    .click();
  await vi.waitFor(() =>
    expect(
      document.querySelector(mode === "raw" ? ".file-preview-code" : ".file-preview-markdown"),
    ).not.toBeNull(),
  );
  const viewport = mode === "raw" ? rawViewport() : previewViewport();
  assertScrollable(viewport);
  return viewport;
}

export function moveReader(viewport: HTMLDivElement, top: number) {
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
  viewport.scrollTop = top;
  viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
  expect(viewport.scrollTop).toBe(top);
}

export function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

export function sourceLine(text: string, contents = INTEGRATION_CONTENTS): number {
  const index = contents.split("\n").indexOf(text);
  expect(index).toBeGreaterThanOrEqual(0);
  return index + 1;
}

export function headingOffset(text: string): number {
  const heading = [
    ...document.querySelectorAll<HTMLHeadingElement>(".file-preview-markdown h2"),
  ].find((node) => node.textContent === text);
  expect(heading).toBeDefined();
  return heading!.getBoundingClientRect().top - previewViewport().getBoundingClientRect().top;
}

export function deferredPreview() {
  let resolve!: (value: PreviewResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<PreviewResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function resetPreviewMocks() {
  previewMocks.read
    .mockReset()
    .mockResolvedValue({ contents: INTEGRATION_CONTENTS, truncated: false });
  previewMocks.watches.length = 0;
  for (const mock of [
    previewMocks.loadError,
    previewMocks.annotation,
    previewMocks.back,
    previewMocks.forward,
    previewMocks.close,
  ]) {
    mock.mockClear();
  }
  useSearchStore.setState({
    fileSearchContext: null,
    activeFileSearchContext: null,
    searchOpen: false,
  });
  useFilesPanelStore.setState({
    workspaceKey: null,
    histories: {},
    historyKeys: [],
    previewPath: null,
  });
}

export function activateSearchContext() {
  document
    .querySelector("[data-file-preview-search-focus]")!
    .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const context = useSearchStore.getState().fileSearchContext;
  expect(context).not.toBeNull();
  return context!;
}

export function selectSearchMatch(line: number) {
  activateSearchContext().onSelectMatch(line);
}

export function HistoryPreview() {
  const state = useFilesPanelStore();
  const history = state.histories[HISTORY_WORKSPACE]!;
  const entry = history.entries[history.index]!;
  const persist = useFilesPanelScrollPersistence(HISTORY_WORKSPACE, state.previewPath);
  if (!state.previewPath) {
    return <button onClick={state.showCurrentPreview}>Reopen file</button>;
  }
  return previewView({
    relativePath: state.previewPath,
    initialScrollTop: entry.scrollTop,
    onScrollPositionChange: persist,
    canNavigateBack: history.index > 0,
    canNavigateForward: history.index < history.entries.length - 1,
    onNavigateBack: () => state.moveHistory(-1),
    onNavigateForward: () => state.moveHistory(1),
    onClose: state.closePreview,
  });
}
