import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ searchEntries: vi.fn(), openPath: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({ projects: { searchEntries: mocks.searchEntries } }),
}));
vi.mock("../../stores/files/filesPanel.open", () => ({ openPathFromChat: mocks.openPath }));

import { Command, CommandList } from "../ui/command";
import { CommandPaletteWorkspaceFiles } from "./CommandPalette.workspaceFiles";

const clients: QueryClient[] = [];
function createClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return client;
}
function Harness({
  client,
  query = "readme",
  root = "/srv/project",
  open = true,
}: {
  client: QueryClient;
  query?: string;
  root?: string;
  open?: boolean;
}) {
  return (
    <QueryClientProvider client={client}>
      <Command filter={null}>
        <CommandList>
          <CommandPaletteWorkspaceFiles
            open={open}
            normalizedQuery={query}
            workspaceRoot={root}
            workspaceExecutionTargetId="ssh:dev"
            onBeforeOpenFile={() => undefined}
          />
        </CommandList>
      </Command>
    </QueryClientProvider>
  );
}
async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
const result = { entries: [{ path: "docs/README.md", kind: "file" }], truncated: false };
const transient = new Error("session request failed: Session open refused by peer");

describe("remote palette file results", () => {
  beforeEach(() => {
    mocks.searchEntries.mockReset();
    mocks.openPath.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const client of clients.splice(0)) client.clear();
  });

  it("recovers quietly and opens a result on its original remote target", async () => {
    mocks.searchEntries.mockRejectedValueOnce(transient).mockResolvedValue(result);
    await render(<Harness client={createClient()} />);
    await advance();
    await expect.element(page.getByRole("status")).toHaveTextContent("Reconnecting to workspace…");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("No matching files.");
    await advance(1_000);
    await expect.element(page.getByText("README.md", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(mocks.searchEntries).toHaveBeenLastCalledWith({
      cwd: "/srv/project",
      executionTargetId: "ssh:dev",
      query: "readme",
      limit: 80,
    });
    await page.getByText("README.md", { exact: true }).click();
    expect(mocks.openPath).toHaveBeenCalledWith(
      "/srv/project/docs/README.md",
      "/srv/project",
      "file",
      "ssh:dev",
    );
  });

  it("can recover from transient errors under the app’s StrictMode lifecycle", async () => {
    mocks.searchEntries.mockRejectedValueOnce(transient).mockResolvedValue(result);
    await render(
      <StrictMode>
        <Harness client={createClient()} />
      </StrictMode>,
    );
    await advance(1_000);
    await expect.element(page.getByText("README.md", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("distinguishes a successful empty search from a persistent failure and allows Retry", async () => {
    mocks.searchEntries.mockResolvedValueOnce({ entries: [], truncated: false });
    const client = createClient();
    const mounted = await render(<Harness client={client} />);
    await advance();
    await expect.element(page.getByText("No matching files.")).toBeVisible();
    mocks.searchEntries.mockRejectedValue(transient);
    await mounted.rerender(<Harness client={client} query="missing" />);
    await advance(29_999);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("session request failed");
    await advance(1);
    await expect.element(page.getByRole("alert")).toBeVisible();
    mocks.searchEntries.mockResolvedValue(result);
    await page.getByRole("button", { name: "Retry" }).click();
    await advance();
    await expect.element(page.getByText("README.md", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("accepts a hung search’s late success without overlapping requests", async () => {
    let resolve!: (value: typeof result) => void;
    mocks.searchEntries.mockReturnValue(
      new Promise<typeof result>((done) => {
        resolve = done;
      }),
    );
    await render(<Harness client={createClient()} />);
    await advance(30_000);
    await expect
      .element(page.getByRole("button", { name: "Waiting for connection…" }))
      .toBeDisabled();
    expect(mocks.searchEntries).toHaveBeenCalledOnce();
    resolve(result);
    await advance();
    await expect.element(page.getByText("README.md", { exact: true })).toBeVisible();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(mocks.searchEntries).toHaveBeenCalledOnce();
  });

  it("cancels old query retries and never displays old workspace results", async () => {
    mocks.searchEntries.mockRejectedValue(transient);
    const client = createClient();
    const mounted = await render(<Harness client={client} />);
    await advance();
    mocks.searchEntries.mockResolvedValue({
      entries: [{ path: "current.md", kind: "file" }],
      truncated: false,
    });
    await mounted.rerender(<Harness client={client} root="/srv/new" query="current" />);
    await advance();
    await advance(60_000);
    await expect.element(page.getByText("current.md", { exact: true }).first()).toBeVisible();
    expect(mocks.searchEntries).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not search while closed and can search after reopening", async () => {
    mocks.searchEntries.mockRejectedValueOnce(transient).mockResolvedValue(result);
    const client = createClient();
    const mounted = await render(<Harness client={client} />);
    await advance();
    await mounted.rerender(<Harness client={client} open={false} />);
    await advance();
    expect(document.body.textContent).not.toContain("Files");
    expect(mocks.searchEntries.mock.calls).toHaveLength(1);
    await advance(60_000);
    expect(mocks.searchEntries).toHaveBeenCalledOnce();
    await mounted.rerender(<Harness client={client} />);
    await advance();
    await expect.element(page.getByText("README.md", { exact: true })).toBeVisible();
  });
});
