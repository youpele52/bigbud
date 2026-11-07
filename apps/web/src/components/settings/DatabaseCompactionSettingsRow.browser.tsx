import "../../index.css";

import { Toast } from "@base-ui/react/toast";
import type {
  DatabaseCompactionPreview,
  DatabaseCompactionStatus,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ status: vi.fn(), preview: vi.fn(), start: vi.fn() }));
vi.mock("../../rpc/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      getDatabaseCompactionStatus: mocks.status,
      previewDatabaseCompaction: mocks.preview,
      startDatabaseCompaction: mocks.start,
    },
  }),
}));

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState";
import { toastManager } from "../ui/toast.manager";
import {
  resetDatabaseCompactionRunState,
  setDatabaseCompactionIdlePollMsForTests,
} from "./DatabaseCompaction.runState";
import { DatabaseCompactionCoordinator } from "./DatabaseCompactionCoordinator";
import { DatabaseCompactionSettingsRow } from "./DatabaseCompactionSettingsRow";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const preview: DatabaseCompactionPreview = {
  generatedAt: "2026-11-07T10:00:00.000Z",
  fileBytes: Math.round(8.26 * GB),
  walBytes: 0,
  pageSize: 4096,
  pageCount: 2_165_309,
  freelistCount: 1_730_150,
  freeBytes: Math.round(6.6 * GB),
  freeFraction: 0.8,
  expectedBytes: Math.round(1.66 * GB),
  autoVacuum: "none",
  diskFreeBytes: 40 * GB,
  requiredDiskBytes: Math.round(8.26 * GB),
  runningTurns: 0,
  maintenanceBacklog: 0,
  estimatedDurationMs: 65_000,
  offered: true,
  blockers: [],
};

const idle: DatabaseCompactionStatus = {
  state: "idle",
  phase: null,
  startedAt: null,
  estimatedDurationMs: null,
  lastRun: null,
};

const running: DatabaseCompactionStatus = {
  state: "running",
  phase: "vacuuming",
  startedAt: "2026-11-07T10:00:00.000Z",
  estimatedDurationMs: 65_000,
  lastRun: null,
};

function ToastStatus() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <output key={toast.id} data-testid="compaction-toast" data-severity={toast.type}>
      {toast.title}
    </output>
  ));
}

const mount = () =>
  render(
    <AppAtomRegistryProvider>
      <Toast.Provider toastManager={toastManager} timeout={0}>
        <DatabaseCompactionCoordinator />
        <DatabaseCompactionSettingsRow />
        <ToastStatus />
      </Toast.Provider>
    </AppAtomRegistryProvider>,
  );

const completedRun = {
  outcome: "completed" as const,
  startedAt: "2026-11-07T11:00:00.000Z",
  finishedAt: "2026-11-07T11:01:00.000Z",
  bytesBefore: preview.fileBytes,
  bytesAfter: Math.round(1.2 * GB),
  checkpointComplete: true,
  error: null,
};

describe("Settings database compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetDatabaseCompactionRunState();
    resetWsConnectionStateForTests();
    mocks.status.mockResolvedValue(idle);
    mocks.preview.mockResolvedValue(preview);
    mocks.start.mockResolvedValue(running);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("previews, confirms, covers the app while it runs and reports the result", async () => {
    const screen = await mount();
    try {
      await expect
        .element(page.getByTestId("database-compaction-summary"))
        .toHaveTextContent("8.3 GB · 6.6 GB free (80%) · about 1.7 GB after compaction");
      await page.getByRole("button", { name: "Compact", exact: true }).click();
      const items = page.getByRole("definition");
      await expect.element(items.nth(2)).toHaveTextContent("1.7 GB");
      await expect.element(items.nth(3)).toHaveTextContent("40 GB (needs 8.3 GB)");
      await expect.element(items.nth(4)).toHaveTextContent("about 1 minute");

      mocks.status.mockResolvedValue(running);
      await page.getByRole("button", { name: "Compact database", exact: true }).click();
      expect(mocks.start).toHaveBeenCalledExactlyOnceWith({});
      await expect.element(page.getByTestId("database-compaction-overlay")).toBeInTheDocument();
      await expect
        .element(page.getByTestId("database-compaction-overlay"))
        .toHaveTextContent("bigbud is paused until it finishes");
      await expect
        .element(page.getByTestId("compaction-toast").last())
        .toHaveAttribute("data-severity", "loading");

      mocks.preview.mockResolvedValue({
        ...preview,
        fileBytes: Math.round(1.2 * GB),
        freeBytes: 0,
        freeFraction: 0,
        freelistCount: 0,
        offered: false,
        blockers: ["below-threshold"],
      });
      mocks.status.mockResolvedValue({
        ...idle,
        lastRun: {
          outcome: "completed",
          startedAt: "2026-11-07T10:00:00.000Z",
          finishedAt: "2026-11-07T10:01:00.000Z",
          bytesBefore: preview.fileBytes,
          bytesAfter: Math.round(1.2 * GB),
          checkpointComplete: true,
          error: null,
        },
      });
      await expect.element(page.getByTestId("database-compaction-overlay")).not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("compaction-toast").last())
        .toHaveAttribute("data-severity", "success");
      await expect
        .element(page.getByTestId("database-compaction-summary"))
        .toHaveTextContent("Nothing worth compacting right now.");
      await expect
        .element(page.getByRole("button", { name: "Compact", exact: true }))
        .toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows why it cannot start and keeps the confirmation disabled", async () => {
    mocks.preview.mockResolvedValue({ ...preview, runningTurns: 1, blockers: ["running-turns"] });
    const screen = await mount();
    try {
      await page.getByRole("button", { name: "Compact", exact: true }).click();
      await expect
        .element(page.getByText("A turn is running. Wait for it to finish before compacting."))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Compact database", exact: true }))
        .toBeDisabled();
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("recovers after a restart mid-run: one amber notice, no loader", async () => {
    mocks.status.mockResolvedValue({
      ...idle,
      lastRun: {
        outcome: "interrupted",
        startedAt: "2026-11-07T09:00:00.000Z",
        finishedAt: "2026-11-07T09:05:00.000Z",
        bytesBefore: preview.fileBytes,
        bytesAfter: null,
        checkpointComplete: false,
        error: "The backend stopped during compaction. The database was not changed.",
      },
    });
    const first = await mount();
    await expect
      .element(page.getByTestId("compaction-toast").last())
      .toHaveAttribute("data-severity", "warning");
    expect(document.querySelector('[data-testid="database-compaction-overlay"]')).toBeNull();
    await first.unmount();
    const second = await mount();
    try {
      await expect
        .element(page.getByRole("button", { name: "Compact", exact: true }))
        .toBeEnabled();
      // The remounted row does not announce the same run again.
      expect(document.querySelectorAll('[data-testid="compaction-toast"]')).toHaveLength(0);
    } finally {
      await second.unmount();
    }
  });

  it("covers the app from the root after a reload mid-run, without Settings open", async () => {
    mocks.status.mockResolvedValue(running);
    const screen = await render(
      <Toast.Provider toastManager={toastManager} timeout={0}>
        <DatabaseCompactionCoordinator />
        <ToastStatus />
      </Toast.Provider>,
    );
    try {
      await expect.element(page.getByTestId("database-compaction-overlay")).toBeInTheDocument();
      mocks.status.mockResolvedValue({
        ...idle,
        lastRun: {
          outcome: "completed",
          startedAt: "2026-11-07T10:00:00.000Z",
          finishedAt: "2026-11-07T10:00:08.000Z",
          bytesBefore: preview.fileBytes,
          bytesAfter: Math.round(0.9 * GB),
          checkpointComplete: true,
          error: null,
        },
      });
      await expect.element(page.getByTestId("database-compaction-overlay")).not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("compaction-toast").last())
        .toHaveAttribute("data-severity", "success");
      expect(mocks.preview).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the loader again when opened while a run is in progress", async () => {
    mocks.status.mockResolvedValue(running);
    const screen = await mount();
    try {
      await expect.element(page.getByTestId("database-compaction-overlay")).toBeInTheDocument();
      expect(mocks.preview).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("discovers a run started in another window while idle, then reports it", async () => {
    setDatabaseCompactionIdlePollMsForTests(50);
    const screen = await mount();
    try {
      await expect
        .element(page.getByTestId("database-compaction-summary"))
        .toHaveTextContent("after compaction");
      expect(document.querySelector('[data-testid="database-compaction-overlay"]')).toBeNull();

      mocks.status.mockResolvedValue(running);
      await expect.element(page.getByTestId("database-compaction-overlay")).toBeInTheDocument();
      await expect
        .element(page.getByTestId("compaction-toast").last())
        .toHaveAttribute("data-severity", "loading");

      mocks.status.mockResolvedValue({ ...idle, lastRun: completedRun });
      await expect.element(page.getByTestId("database-compaction-overlay")).not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("compaction-toast").last())
        .toHaveAttribute("data-severity", "success");
      expect(mocks.start).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("re-reads the status when the WebSocket reconnects, without waiting for the idle poll", async () => {
    recordWsConnectionAttempt("ws://localhost/ws");
    recordWsConnectionOpened();
    const screen = await mount();
    try {
      await expect
        .element(page.getByTestId("database-compaction-summary"))
        .toHaveTextContent("after compaction");
      const reads = mocks.status.mock.calls.length;

      // The backend restarted with a run already in progress (the idle poll is 20 s away).
      mocks.status.mockResolvedValue(running);
      recordWsConnectionAttempt("ws://localhost/ws");
      recordWsConnectionOpened();
      await expect.element(page.getByTestId("database-compaction-overlay")).toBeInTheDocument();
      expect(mocks.status.mock.calls.length).toBeGreaterThan(reads);
    } finally {
      await screen.unmount();
    }
  });

  it("shows an in-process backend as an amber reason that blocks the start", async () => {
    mocks.preview.mockResolvedValue({ ...preview, blockers: ["in-process-sqlite"] });
    const screen = await mount();
    try {
      await page.getByRole("button", { name: "Compact", exact: true }).click();
      const blockers = page.getByTestId("database-compaction-blockers");
      await expect.element(blockers).toHaveTextContent("main thread");
      await expect.element(blockers).toHaveClass(/text-warning/u);
      await expect
        .element(page.getByRole("button", { name: "Compact database", exact: true }))
        .toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });
});
