import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { PROVIDER_TURN_FAILURE_NOTICE_KIND } from "@bigbud/shared/providerTurnFailure";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { emitWelcome, resetServerStateForTests } from "../../../rpc/serverState";
import { useStore } from "../../../stores/main/main.store";
import { makeThread } from "../../../stores/main/main.store.test.helpers";
import { useProviderFailureNoticeStore } from "../../../stores/ui/providerFailureNotice.store";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

const threadId = ThreadId.makeUnsafe("failure-notice-thread");
const message = "OpenCode Console API key has expired. Create a new API key.";

function activity(serverRunId: string, detail = message): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`${serverRunId}-${detail}`),
    createdAt: "2026-10-17T21:27:53.000Z",
    tone: "error",
    kind: PROVIDER_TURN_FAILURE_NOTICE_KIND,
    summary: "OpenCode v2 turn failed",
    payload: { serverRunId, message: detail },
    turnId: null,
  };
}

function welcome(serverRunId: string) {
  emitWelcome({ serverRunId, cwd: "/test", projectName: "test" });
}

function banner(error: string | null = null) {
  return render(
    <AppAtomRegistryProvider>
      <ThreadErrorBanner threadId={threadId} error={error} />
    </AppAtomRegistryProvider>,
  );
}

beforeEach(() => {
  resetServerStateForTests();
  useProviderFailureNoticeStore.setState({ serverRunId: null, notices: {} });
  useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
  useStore.setState({
    ...useStore.getInitialState(),
    threads: [makeThread({ id: threadId, activities: [activity("boot-1")] })],
  });
  welcome("boot-1");
});

afterEach(async () => {
  await cleanup();
  document.body.innerHTML = "";
  useStore.setState(useStore.getInitialState());
  useProviderFailureNoticeStore.setState({ serverRunId: null, notices: {} });
  resetServerStateForTests();
});

it("shows a ready thread's failure once, retains it on remount, and suppresses repeats after close", async () => {
  const first = await banner();
  await expect.element(page.getByText(message)).toBeVisible();
  await first.unmount();
  const remounted = await banner();
  await expect.element(page.getByText(message)).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect.element(page.getByText(message)).not.toBeInTheDocument();
  await remounted.unmount();
  // Recreated provider session, new message, same backend run and thread.
  useStore.setState({
    threads: [makeThread({ id: threadId, activities: [activity("boot-1", "Repeated failure")] })],
  });
  await banner();
  await expect.element(page.getByText("Repeated failure")).not.toBeInTheDocument();
  welcome("boot-2");
  await expect.element(page.getByText("Repeated failure")).not.toBeInTheDocument();
  useStore.setState({
    threads: [
      makeThread({
        id: threadId,
        activities: [activity("boot-1"), activity("boot-2", "New run failure")],
      }),
    ],
  });
  await expect.element(page.getByText("New run failure")).toBeVisible();
});

it("does not duplicate the generic error and preserves unrelated error behavior", async () => {
  const screen = await banner(message);
  await expect.element(page.getByText(message)).toBeVisible();
  expect(document.querySelectorAll('[title="' + message + '"]').length).toBe(1);
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect.element(page.getByText(message)).not.toBeInTheDocument();
  await screen.unmount();
  await banner("Unrelated command rejection");
  await expect.element(page.getByText("Unrelated command rejection")).toBeVisible();
});
