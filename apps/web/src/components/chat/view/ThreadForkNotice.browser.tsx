import "../../../index.css";

import type { OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { Thread } from "../../../models/types/app.types";
import { ThreadForkNotice } from "./ThreadForkNotice";
import { useThreadNoticeDismissalStore } from "../../../stores/ui/threadNoticeDismissal.store";
import { deriveSourceForkNotice } from "./ThreadForkNotice.logic";

type NoticeThread = Pick<Thread, "forkOrigin" | "parentThread" | "messages" | "activities">;

async function renderAt(
  thread: NoticeThread,
  onCarry?: ComponentProps<typeof ThreadForkNotice>["onCarryToContinuedThread"],
  isForkPresent: (forkThreadId: string) => boolean = () => true,
  threadId = "fork-notice-test",
) {
  const root = createRootRoute({
    component: () => (
      <ThreadForkNotice
        thread={{ ...thread, id: threadId as ThreadId }}
        isForkPresent={isForkPresent}
        onCarryToContinuedThread={onCarry}
      />
    ),
  });
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

const activity = (id: string, kind: string, createdAt: string, payload: unknown) =>
  ({ id, tone: "info", kind, summary: kind, payload, turnId: null, createdAt }) as never;

describe("ThreadForkNotice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useThreadNoticeDismissalStore.setState({ dismissed: new Set() });
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
    await page.getByRole("link", { name: "Open the continued thread" }).click();
    expect(router.state.location.pathname).toBe("/fork-1");
  });

  it("warns in amber when the message was sent again after a deleted fork received it", async () => {
    await renderAt({
      forkOrigin: {
        forkPointMessageId: null,
        reason: "manual",
        failureEventId: null,
        pendingDelivery: "sent",
      },
      parentThread: { threadId: "source-1" as ThreadId, title: "Long running work" },
      messages: [],
      activities: [
        activity("origin-1", "thread.fork-origin", "2026-10-15T10:00:00.000Z", {
          pendingDelivery: "sent",
          redelivered: true,
        }),
      ],
    });
    const status = page.getByRole("status");
    await expect.element(status).toHaveAttribute("data-fork-notice", "origin");
    await expect.element(status).toHaveAttribute("data-tone", "warning");
    await expect.element(page.getByText(/workspace changes it made may be repeated/)).toBeVisible();
  });

  it("links nothing once the fork was deleted", async () => {
    await renderAt(
      {
        messages: [],
        activities: [
          activity("forked-1", "thread.forked", "2026-10-15T10:00:00.000Z", {
            forkThreadId: "fork-1",
            reason: "recovery-failed",
          }),
        ],
      },
      undefined,
      () => false,
    );
    await expect
      .element(page.getByRole("link", { name: "Open the continued thread" }))
      .not.toBeInTheDocument();
  });

  it("offers sending a later never-admitted message to the existing automatic fork", async () => {
    const onCarry = vi.fn();
    const at = "2026-10-15T10:00:00.000Z";
    const later = "2026-10-15T11:00:00.000Z";
    await renderAt(
      {
        messages: [
          { id: "m-1", role: "user", text: "a", turnId: null, createdAt: at, streaming: false },
          { id: "m-2", role: "user", text: "b", turnId: null, createdAt: later, streaming: false },
        ] as never,
        activities: [
          activity("forked-1", "thread.forked", at, {
            forkThreadId: "fork-1",
            reason: "recovery-failed",
            pendingMessageId: "m-1",
          }),
          activity("failure-2", "provider.turn.start.failed", later, {
            failureClass: "session-dead",
          }),
        ],
      },
      onCarry,
    );
    await expect
      .element(page.getByRole("link", { name: "Open the continued thread" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Send this message to the continued thread" }).click();
    expect(onCarry).toHaveBeenCalledWith("fork-1", {
      pendingMessageId: "m-2",
      failureEventId: "failure-2",
    });
  });

  it("remembers closing continuation without changing lineage and re-arms for a different target", async () => {
    const thread: NoticeThread = {
      messages: [],
      activities: [
        activity("closed-fork", "thread.forked", "2026-10-15T10:00:00.000Z", {
          forkThreadId: "continued-one",
          reason: "manual",
        }),
      ],
    };
    const before = structuredClone(thread);
    await renderAt(thread);
    await page.getByRole("button", { name: "Dismiss continuation notice" }).click();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    expect(thread).toEqual(before);
    expect(deriveSourceForkNotice(thread, () => true)?.forkThreadId).toBe("continued-one");
    document.body.innerHTML = "";
    await renderAt(thread);
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    document.body.innerHTML = "";
    await renderAt(thread, undefined, () => true, "another-source");
    await expect
      .element(page.getByRole("link", { name: "Open the continued thread" }))
      .toBeVisible();
    document.body.innerHTML = "";
    await renderAt({
      ...thread,
      activities: [
        activity("new-fork", "thread.forked", "2026-10-15T10:00:00.000Z", {
          forkThreadId: "continued-two",
          reason: "manual",
        }),
      ],
    });
    await expect
      .element(page.getByRole("link", { name: "Open the continued thread" }))
      .toHaveAttribute("href", "/continued-two");
  });
});
