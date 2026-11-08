import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { expect, it } from "vitest";
import {
  ORGANIZATION_OBSERVATION_INTERVAL_MS as INTERVAL,
  OrganizationObservation,
  organizationObservationIds,
  organizationObservationUrgent,
} from "./organizationObservation.ts";

const event = (value: object) => value as unknown as OrchestrationEvent;
const delta = (threadId: string) =>
  event({
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: threadId,
    payload: { threadId, role: "assistant", streaming: true },
  });
const activity = (threadId: string, kind = "tool.completed") =>
  event({
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: threadId,
    payload: { threadId, activity: { kind } },
  });

it("assistant streaming never schedules observation and thread activity coalesces per thread", () => {
  const observation = new OrganizationObservation();
  for (let index = 0; index < 2500; index++) {
    for (const id of organizationObservationIds(delta(`thread-${index % 3}`))) observation.mark(id);
    for (const id of organizationObservationIds(activity(`thread-${index % 3}`)))
      observation.mark(id);
  }
  expect(observation.rescan).toBe(false);
  expect(observation.size).toBe(3);
  expect([observation.take(), observation.take(), observation.take(), observation.take()]).toEqual([
    "thread-0",
    "thread-1",
    "thread-2",
    undefined,
  ]);
  const user = event({
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: "typed",
    payload: { threadId: "typed", role: "user" },
  });
  expect(organizationObservationIds(user)).toEqual(["typed"]);
  expect(
    organizationObservationIds(
      event({ type: "project.created", aggregateKind: "project", aggregateId: "p", payload: {} }),
    ),
  ).toEqual([]);
});

it("deletion marks the whole subtree once", () => {
  expect(
    organizationObservationIds(
      event({
        type: "thread.deleted",
        aggregateKind: "thread",
        aggregateId: "root",
        payload: { threadId: "root", threadIds: ["root", "child", "grandchild"] },
      }),
    ),
  ).toEqual(["root", "child", "grandchild"]);
});

it("overflow is a full rescan request, never a dropped thread or a failure", () => {
  const observation = new OrganizationObservation(4);
  for (const id of ["a", "b", "c", "d", "e", "a"]) observation.mark(id);
  expect(observation.size).toBe(4);
  expect(observation.rescan).toBe(true);
});

it("tool chatter refreshes a thread at most once per interval; attention stays immediate", () => {
  let clock = 0;
  const observation = new OrganizationObservation(2000, () => clock);
  const mark = (value: OrchestrationEvent) => {
    for (const id of organizationObservationIds(value))
      observation.mark(id, organizationObservationUrgent(value));
  };
  mark(activity("busy"));
  expect(observation.take()).toBe("busy");
  // Further tool activity within the interval waits instead of re-reading heavy facts.
  for (let index = 0; index < 50; index++) mark(activity("busy"));
  expect(observation.size).toBe(1);
  clock = INTERVAL - 1;
  expect(observation.take()).toBeUndefined();
  clock = INTERVAL;
  expect(observation.take()).toBe("busy");
  // Attention requests/resolutions, user messages and deletions are never throttled.
  for (const urgent of [
    activity("busy", "approval.requested"),
    activity("busy", "user-input.resolved"),
    activity("busy", "delegation.model-choice-requested"),
    event({
      type: "thread.message-sent",
      aggregateKind: "thread",
      aggregateId: "busy",
      payload: { threadId: "busy", role: "user" },
    }),
    event({
      type: "thread.deleted",
      aggregateKind: "thread",
      aggregateId: "busy",
      payload: { threadId: "busy" },
    }),
  ]) {
    expect(organizationObservationUrgent(urgent)).toBe(true);
    mark(urgent);
    expect(observation.take()).toBe("busy");
  }
  // An urgent mark promotes a cooling thread at once.
  mark(activity("busy"));
  expect(observation.take()).toBeUndefined();
  mark(activity("busy", "approval.resolved"));
  expect(observation.take()).toBe("busy");
  expect(observation.size).toBe(0);
});

it("cooling threads count toward capacity and overflow still requests a rescan", () => {
  let clock = 0;
  const observation = new OrganizationObservation(2, () => clock);
  for (const id of ["a", "b"]) observation.mark(id);
  observation.take();
  observation.take();
  observation.mark("a", false);
  observation.mark("b", false);
  expect(observation.size).toBe(2);
  observation.mark("c");
  expect(observation.rescan).toBe(true);
  clock = INTERVAL;
  expect([observation.take(), observation.take(), observation.take()]).toEqual([
    "a",
    "b",
    undefined,
  ]);
});
