import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { mapThread } from "./mappers.store";
import {
  getThreadInterruptTurnId,
  hasOwnedV2DescendantWork,
} from "../../components/chat/view/ChatView.subagents.logic";
import { ComposerPrimaryActions } from "../../components/chat/composer/ComposerPrimaryActions";

it("hydrates main composer Stop from actual SQLite projection snapshots without published child cards", async () => {
  // Dynamic loading avoids making server implementation files part of the browser's
  // composite TS project. This Node-only test executes the real production SQL fixture.
  const fixtureUrl = new URL(
    "../../../../server/src/orchestration/Layers/ProjectionSnapshotQuery.family.fixture.ts",
    import.meta.url,
  );
  const fixture = (await import(/* @vite-ignore */ fixtureUrl.href)) as {
    readRetainedFamilySqlSnapshots: () => Promise<
      ReadonlyArray<{
        expected: boolean;
        snapshot: OrchestrationReadModel;
        mobile: OrchestrationReadModel;
      }>
    >;
  };
  const results = await fixture.readRetainedFamilySqlSnapshots();
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
      const primary = renderToStaticMarkup(
        createElement(ComposerPrimaryActions, {
          compact: false,
          pendingAction: null,
          isRunning: false,
          hasBackgroundWork: hasOwnedV2DescendantWork(hydrated),
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
      expect(primary.includes('aria-label="Stop generation and subagents"')).toBe(row.expected);
    }
  }
});
