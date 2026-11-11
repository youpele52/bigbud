import { expect, it } from "vitest";
import {
  normalizeTerminalSplitLayout,
  splitTerminalLayout,
  terminalSplitBounds,
} from "./terminalSplitLayout";

it("retains equal-width rows for older saved groups", () => {
  const bounds = terminalSplitBounds(normalizeTerminalSplitLayout(undefined, ["a", "b"]));
  expect(bounds.get("a")).toEqual({ left: 0, top: 0, width: 50, height: 100 });
  expect(bounds.get("b")).toEqual({ left: 50, top: 0, width: 50, height: 100 });
  const three = terminalSplitBounds(normalizeTerminalSplitLayout(undefined, ["a", "b", "c"]));
  for (const rect of three.values()) expect(rect.width).toBeCloseTo(100 / 3);
});
it("splits only the active pane downward without moving its neighbor", () => {
  const row = normalizeTerminalSplitLayout(undefined, ["a", "b"]);
  const layout = splitTerminalLayout(row, "b", "c", "down");
  const bounds = terminalSplitBounds(layout);
  expect(bounds.get("a")).toEqual({ left: 0, top: 0, width: 50, height: 100 });
  expect(bounds.get("b")).toEqual({ left: 50, top: 0, width: 50, height: 50 });
  expect(bounds.get("c")).toEqual({ left: 50, top: 50, width: 50, height: 50 });
  expect(normalizeTerminalSplitLayout(JSON.parse(JSON.stringify(layout)), ["a", "b", "c"])).toEqual(
    layout,
  );
  const closed = normalizeTerminalSplitLayout(layout, ["a", "c"]);
  expect(terminalSplitBounds(closed).get("c")).toEqual({
    left: 50,
    top: 0,
    width: 50,
    height: 100,
  });
});
it("bounds malformed, duplicate and cyclic persisted layouts", () => {
  const cyclic: Record<string, unknown> = { direction: "down", first: { terminalId: "a" } };
  cyclic.second = cyclic;
  expect([...terminalSplitBounds(normalizeTerminalSplitLayout(cyclic, ["a", "b"])).keys()]).toEqual(
    ["a", "b"],
  );
  expect([
    ...terminalSplitBounds(normalizeTerminalSplitLayout({ terminalId: "gone" }, ["a"])).keys(),
  ]).toEqual(["a"]);
});
