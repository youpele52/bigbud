import "../../index.css";

import type {
  SystemSearchQueryInput,
  SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

interface QueryCall {
  readonly input: SystemSearchQueryInput;
  readonly onUpdate: (update: SystemSearchTierUpdate) => void;
  readonly signal: AbortSignal;
  readonly finish: () => void;
}

const mocks = vi.hoisted(() => ({
  searchEntries: vi.fn(),
  openPath: vi.fn(),
  calls: [] as QueryCall[],
  search: { thisComputer: true, fileAccessLevel: "common-folders", hasSeenThisComputerHint: true },
}));
const query = (
  input: SystemSearchQueryInput,
  onUpdate: QueryCall["onUpdate"],
  signal: AbortSignal,
) => new Promise<void>((finish) => mocks.calls.push({ input, onUpdate, signal, finish }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ projects: { searchEntries: mocks.searchEntries } }),
  readNativeApi: () => ({ search: { query } }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (select: (settings: unknown) => unknown) => select({ search: mocks.search }),
  updateServerSettings: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../stores/files/filesPanel.open", () => ({ openPathFromChat: mocks.openPath }));

import { Command, CommandList } from "../ui/command";
import { CommandPaletteFileSearch } from "./CommandPalette.fileSearch";

const REMOTE = "ssh:host=box&transport=agent";
const clients: QueryClient[] = [];

function Harness(props: { q?: string; open?: boolean; target?: string; client: QueryClient }) {
  return (
    <QueryClientProvider client={props.client}>
      <Command filter={null}>
        <CommandList scrollAreaClassName="max-h-[180px]">
          <CommandPaletteFileSearch
            open={props.open ?? true}
            normalizedQuery={props.q ?? "read"}
            workspaceRoot="/work/current"
            workspaceExecutionTargetId={(props.target ?? "local") as never}
            currentProjectId={"current" as never}
            currentThreadId={null}
            onBeforeOpenFile={() => undefined}
          />
        </CommandList>
      </Command>
    </QueryClientProvider>
  );
}

function client() {
  const created = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(created);
  return created;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
function row(tier: SystemSearchTierUpdate["tier"], name: string) {
  return {
    id: `${tier}:name:local:/p/${name}`,
    kind: "name" as const,
    executionTargetId: "local",
    root: "/p",
    path: name,
    label: "p",
    isDirectory: false,
  };
}
function emit(
  call: QueryCall,
  tier: SystemSearchTierUpdate["tier"],
  names: string[],
  more = false,
) {
  call.onUpdate({
    queryId: call.input.queryId,
    tier,
    sourceId: "local",
    items: names.map((name) => row(tier, name)),
    state: "partial",
    truncated: false,
  });
  call.onUpdate({
    queryId: call.input.queryId,
    tier,
    sourceId: "local",
    items: [],
    state: more ? "partial" : "done",
    truncated: more,
  });
}
const localEntries = (count: number) => ({
  entries: Array.from({ length: count }, (_, index) => ({
    path: `src/read-${index}.ts`,
    kind: "file",
  })),
  truncated: false,
});

describe("Mod+P file search across sources", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.searchEntries.mockReset().mockResolvedValue(localEntries(1));
    mocks.search = {
      thisComputer: true,
      fileAccessLevel: "common-folders",
      hasSeenThisComputerHint: true,
    };
  });
  afterEach(() => {
    for (const created of clients.splice(0)) created.clear();
  });

  it("answers the local project at once and starts slow tiers only after 150 ms", async () => {
    // The palette opens empty; typing then debounces only the slow tiers.
    const created = client();
    const mounted = await render(<Harness client={created} q="" />);
    await mounted.rerender(<Harness client={created} q="read" />);
    await expect.element(page.getByText("read-0.ts", { exact: true })).toBeVisible();
    // The local list rendered while no slow tier had even started (first-tier latency).
    expect(mocks.calls).toHaveLength(0);
    await sleep(80);
    expect(mocks.calls).toHaveLength(0);
    await sleep(120);
    expect(mocks.calls).toHaveLength(1);
    expect(mocks.calls[0]!.input).toMatchObject({
      query: "read",
      mode: "fileNames",
      tiers: ["otherProjectFiles", "thisComputer", "remoteOutsideProjects"],
    });
    // The next keystroke's local rows are never held back behind the still-running slow query.
    mocks.searchEntries.mockResolvedValue({
      entries: [{ path: "src/ready.ts", kind: "file" }],
      truncated: false,
    });
    await mounted.rerender(<Harness client={created} q="ready" />);
    await expect.element(page.getByText("ready.ts", { exact: true })).toBeVisible();
    expect(mocks.calls).toHaveLength(1);
  });

  it("keeps the fixed tier order whatever order the sources answer in", async () => {
    await render(<Harness client={client()} />);
    await sleep(200);
    const call = mocks.calls[0]!;
    emit(call, "remoteOutsideProjects", ["remote.md"]);
    emit(call, "thisComputer", ["computer.md"]);
    emit(call, "otherProjectFiles", ["other.md"]);
    call.finish();
    await expect.element(page.getByText("Files in remote folders")).toBeVisible();
    const text = document.querySelector('[data-testid="mod-p-file-search"]')!.textContent!;
    const order = [
      "read-0.ts",
      "Files in other projects",
      "Files on this computer",
      "Files in remote folders",
    ].map((label) => text.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((left, right) => left - right));
  });

  it("cancels the superseded query and searches nothing once closed", async () => {
    const created = client();
    const mounted = await render(<Harness client={created} />);
    await sleep(200);
    await mounted.rerender(<Harness client={created} q="readm" />);
    await sleep(200);
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[0]!.signal.aborted).toBe(true);
    expect(mocks.calls[1]!.signal.aborted).toBe(false);
    await mounted.rerender(<Harness client={created} q="readm" open={false} />);
    await sleep(200);
    expect(mocks.calls[1]!.signal.aborted).toBe(true);
    expect(mocks.calls).toHaveLength(2);
  });

  it("leaves this computer out when the setting is off or File Access is No access", async () => {
    for (const search of [
      { thisComputer: false, fileAccessLevel: "unrestricted", hasSeenThisComputerHint: true },
      { thisComputer: true, fileAccessLevel: "none", hasSeenThisComputerHint: true },
    ]) {
      mocks.calls.length = 0;
      mocks.search = search;
      const mounted = await render(<Harness client={client()} />);
      await sleep(200);
      expect(mocks.calls[0]!.input.tiers).toEqual(["otherProjectFiles", "remoteOutsideProjects"]);
      await mounted.unmount();
    }
  });

  it("searches a remote current project through search.query, never the dialing RPC", async () => {
    await render(<Harness client={client()} target={REMOTE} />);
    await sleep(200);
    expect(mocks.searchEntries).not.toHaveBeenCalled();
    const call = mocks.calls[0]!;
    expect(call.input.tiers[0]).toBe("currentProject");
    call.onUpdate({
      queryId: call.input.queryId,
      tier: "currentProject",
      sourceId: REMOTE,
      items: [],
      state: "unavailable",
      reason: "not-connected",
      truncated: false,
    });
    await sleep(100);
    // A remote the user has not connected is simply not searched: no notice.
    expect(document.body.textContent).not.toMatch(/not connected|not fully searched/);
    call.onUpdate({
      queryId: call.input.queryId,
      tier: "otherProjectFiles",
      sourceId: "ssh:host=old&transport=agent",
      items: [],
      state: "partial",
      reason: "agent-update-available",
      truncated: false,
    });
    // Other hints fold into one muted line; the host's reason is in its tooltip.
    const summary = page.getByText("1 host not fully searched");
    await expect.element(summary).toBeVisible();
    await summary.hover();
    await expect.element(page.getByText(/Showing file names only on old\./).last()).toBeVisible();
  });

  it("asks for a tier's next page only when its row is scrolled into view", async () => {
    mocks.searchEntries.mockResolvedValue(localEntries(10));
    await render(<Harness client={client()} />);
    await sleep(200);
    const call = mocks.calls[0]!;
    emit(call, "otherProjectFiles", ["other-0.md", "other-1.md"], true);
    call.finish();
    await expect.element(page.getByText("other-1.md")).toBeInTheDocument();
    await sleep(500);
    expect(mocks.calls).toHaveLength(1);
    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    // A programmatic scroll alone never pages; a user's wheel turn that scrolls the list does.
    viewport.scrollTop = viewport.scrollHeight;
    for (let attempt = 0; attempt < 10; attempt += 1) await frame();
    expect(mocks.calls).toHaveLength(1);
    viewport.scrollTop = 0;
    await frame();
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 400 }));
    viewport.scrollTop = viewport.scrollHeight;
    for (let attempt = 0; attempt < 30 && mocks.calls.length < 2; attempt += 1) await frame();
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1]!.input).toMatchObject({ tiers: ["otherProjectFiles"], page: 1 });
    expect(mocks.calls[0]!.signal.aborted).toBe(true);
    const next = mocks.calls[1]!;
    emit(next, "otherProjectFiles", ["other-0.md", "other-1.md", "other-2.md"]);
    next.finish();
    await expect.element(page.getByText("other-2.md")).toBeInTheDocument();
    const text = document.body.textContent!;
    expect(text.indexOf("other-1.md")).toBeLessThan(text.indexOf("other-2.md"));
    expect(text.match(/other-0\.md/g)).toHaveLength(1);
  });

  it("does not page a tier whose row is merely visible; the row still works as a button", async () => {
    mocks.searchEntries.mockResolvedValue(localEntries(0));
    await render(<Harness client={client()} />);
    await sleep(200);
    const call = mocks.calls[0]!;
    emit(call, "otherProjectFiles", ["other-0.md"], true);
    call.finish();
    await expect.element(page.getByText("See more")).toBeVisible();
    await sleep(500);
    expect(mocks.calls).toHaveLength(1);
    // A real <button>: keyboard, pointer and assistive technology can page without scrolling.
    await page.getByRole("button", { name: "See more" }).click();
    expect(mocks.calls).toHaveLength(2);
    expect(mocks.calls[1]!.input).toMatchObject({ tiers: ["otherProjectFiles"], page: 1 });
  });
});
