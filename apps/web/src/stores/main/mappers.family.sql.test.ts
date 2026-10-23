import { beforeAll, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { ThreadSummary } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import type { Thread } from "../../models/types";
import { mapThread } from "./mappers.store";
import { mapSidebarThreadSummary, mapThreadSummary } from "./mappers.lazy.store";
import {
  getThreadInterruptTurnId,
  hasOwnedV2DescendantWork,
} from "../../components/chat/view/ChatView.subagents.logic";
import { ComposerPrimaryActions } from "../../components/chat/composer/ComposerPrimaryActions";

type RetainedFamilySqlRow = {
  expected: boolean;
  snapshot: OrchestrationReadModel;
  mobile: OrchestrationReadModel;
  sidebarSummary: ThreadSummary | undefined;
  projectSummary: ThreadSummary | undefined;
};

/** Executes the real production SQL fixture (Node-only test). Dynamic loading avoids making server
 * implementation files part of the browser's composite TS project. */
async function readRetainedFamilySqlRows(): Promise<ReadonlyArray<RetainedFamilySqlRow>> {
  const fixtureUrl = new URL(
    "../../../../server/src/orchestration/Layers/ProjectionSnapshotQuery.family.fixture.ts",
    import.meta.url,
  );
  const fixture = (await import(/* @vite-ignore */ fixtureUrl.href)) as {
    readRetainedFamilySqlSnapshots: () => Promise<ReadonlyArray<RetainedFamilySqlRow>>;
  };
  return fixture.readRetainedFamilySqlSnapshots();
}

let results: ReadonlyArray<RetainedFamilySqlRow>;

// Loading the fixture transforms the server import graph and migrates a real SQLite database,
// which can exceed the default 5 s test timeout under parallel load. Load it once, up front.
beforeAll(async () => {
  results = await readRetainedFamilySqlRows();
}, 60_000);

function renderPrimaryActions(hasBackgroundWork: boolean): string {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: false,
      pendingAction: null,
      isRunning: false,
      hasBackgroundWork,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      isConnecting: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

it("hydrates main composer Stop from actual SQLite projection snapshots without published child cards", () => {
  expect(results.map((row) => row.expected)).toEqual([false, true, false, true, false]);
  for (const row of results) {
    for (const snapshot of [row.snapshot, row.mobile]) {
      const persisted = snapshot.threads.find((thread) => thread.id === "retained-family-sql")!;
      const hydrated = mapThread(persisted);
      expect(hydrated.providerAgents ?? []).toEqual([]);
      expect(hydrated.session?.status).toBe("ready");
      // This is the main composer's existing hasBackgroundWork predicate, not a card or test flag.
      expect(hasOwnedV2DescendantWork(hydrated)).toBe(row.expected);
      expect(getThreadInterruptTurnId(hydrated)).toBeUndefined();
      const primary = renderPrimaryActions(hasOwnedV2DescendantWork(hydrated));
      expect(primary.includes('aria-label="Stop generation and subagents"')).toBe(row.expected);
    }
  }
});

it("hydrates main composer Stop from the bounded web startup catalogs after a reload", () => {
  // The web starts from getSidebarThreadCatalog / getProjectThreadSummaries, not getSnapshot.
  expect(results.map((row) => row.expected)).toEqual([false, true, false, true, false]);
  for (const row of results) {
    for (const summary of [row.sidebarSummary, row.projectSummary]) {
      expect(summary).toBeDefined();
      const thread: Thread = mapThreadSummary(summary!);
      expect(thread.session?.status).toBe("ready");
      expect(hasOwnedV2DescendantWork(thread)).toBe(row.expected);
      expect(getThreadInterruptTurnId(thread)).toBeUndefined();
      const sidebar = mapSidebarThreadSummary(summary!);
      expect(Boolean(sidebar.session?.retainedFamily)).toBe(row.expected);
      expect(
        renderPrimaryActions(hasOwnedV2DescendantWork(thread)).includes(
          'aria-label="Stop generation and subagents"',
        ),
      ).toBe(row.expected);
    }
  }
});
