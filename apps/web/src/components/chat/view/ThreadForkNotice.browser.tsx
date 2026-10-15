import "../../../index.css";

import type { OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { Thread } from "../../../models/types/app.types";
import { ThreadForkNotice } from "./ThreadForkNotice";

type NoticeThread = Pick<Thread, "forkOrigin" | "parentThread" | "messages" | "activities">;

async function renderAt(thread: NoticeThread) {
  const root = createRootRoute({ component: () => <ThreadForkNotice thread={thread} /> });
  const index = createRoute({ getParentRoute: () => root, path: "/" });
  const threadRoute = createRoute({ getParentRoute: () => root, path: "/$threadId" });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root.addChildren([index, threadRoute]),
  });
  await router.load();
  await render(<RouterProvider router={router} />);
  return router;
}

describe("ThreadForkNotice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the source in a fork and links back to it", async () => {
    const router = await renderAt({
      forkOrigin: {
        forkPointMessageId: null,
        reason: "recovery-failed",
        failureEventId: null,
        pendingDelivery: "held",
      },
      parentThread: { threadId: "source-1" as ThreadId, title: "Long running work" },
      messages: [],
      activities: [],
    });
    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("data-fork-notice", "origin");
    await expect.element(page.getByText(/could not be resumed/)).toBeVisible();
    await page.getByRole("link", { name: "Long running work" }).click();
    expect(router.state.location.pathname).toBe("/source-1");
  });

  it("links a source thread to the fork it continued in", async () => {
    const router = await renderAt({
      messages: [],
      activities: [
        {
          id: "forked-1",
          tone: "info",
          kind: "thread.forked",
          summary: "Continued in a new thread",
          payload: { forkThreadId: "fork-1", reason: "recovery-failed" },
          turnId: null,
          createdAt: "2026-10-15T10:00:00.000Z",
        } as unknown as OrchestrationThreadActivity,
      ],
    });
    await expect
      .element(page.getByText("This thread could not be resumed and continued in a new thread"))
      .toBeVisible();
    await page.getByRole("link", { name: "Open the new thread" }).click();
    expect(router.state.location.pathname).toBe("/fork-1");
  });
});
