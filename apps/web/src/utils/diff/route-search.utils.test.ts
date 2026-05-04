import { describe, expect, it } from "vitest";

import {
  closeDiffRouteSearch,
  openDiffRouteSearch,
  parseDiffRouteSearch,
} from "./route-search.utils";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });
});

describe("diff route search helpers", () => {
  it("closes diff search params without disturbing unrelated search state", () => {
    expect(
      closeDiffRouteSearch({
        diff: "1",
        diffTurnId: "turn-1",
        diffFilePath: "src/app.ts",
        tab: "activity",
      }),
    ).toEqual({
      tab: "activity",
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
    });
  });

  it("opens diff search params from any prior search state", () => {
    expect(
      openDiffRouteSearch(
        {
          tab: "activity",
          diff: undefined,
        },
        {
          turnId: "turn-1" as never,
          filePath: "src/app.ts",
        },
      ),
    ).toEqual({
      tab: "activity",
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("drops file targeting when no turn is selected", () => {
    expect(
      openDiffRouteSearch(
        {
          tab: "activity",
        },
        {
          filePath: "src/app.ts",
        },
      ),
    ).toEqual({
      tab: "activity",
      diff: "1",
    });
  });
});
