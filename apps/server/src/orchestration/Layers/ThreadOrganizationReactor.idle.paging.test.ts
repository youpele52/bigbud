import { ThreadId } from "@bigbud/contracts";
import { expect, it } from "vitest";
import { makeIdleSweepPaging } from "./ThreadOrganizationReactor.idle.paging.ts";
const row = {
  threadId: ThreadId.makeUnsafe("thread"),
  activityAt: "2026-10-01T00:00:00.000Z",
  state: "present",
  revision: 0,
} as const;

it("keeps each rule independent and resets on policy changes", () => {
  const paging = makeIdleSweepPaging();
  paging.advance("idle", [row], 1);
  paging.advance("older", [row], 1);
  expect(paging.after("idle")).toEqual({ threadId: row.threadId, activityAt: row.activityAt });
  paging.reset("older");
  expect(paging.after("older")).toBeUndefined();
  expect(paging.after("idle")).toBeDefined();
  paging.advance("idle", [], 1);
  expect(paging.after("idle")).toBeUndefined();
  paging.advance("idle", [row], 1);
  paging.advance("idle", [row], 2);
  expect(paging.after("idle")).toBeUndefined();
});
