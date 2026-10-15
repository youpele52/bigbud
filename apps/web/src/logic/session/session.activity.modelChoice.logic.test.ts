import { describe, expect, it } from "vitest";

import {
  makeRequestedPayload,
  makeResolvedPayload,
  modelChoiceActivity,
} from "../../components/chat/view/ThreadModelChoiceNotice.test.helpers";
import {
  deriveThreadModelChoice,
  readLinkedModelChoiceSummary,
} from "./session.activity.modelChoice.logic";
import { deriveWorkLogEntries } from "./session.logic";
import { makeActivity } from "./session.logic.test.helpers";

describe("deriveThreadModelChoice", () => {
  it("is pending until resolved, then reports requested vs used", () => {
    const requested = modelChoiceActivity("requested", makeRequestedPayload());
    expect(deriveThreadModelChoice([requested])).toMatchObject({
      status: "pending",
      choiceId: "choice-1",
    });
    const resolved = modelChoiceActivity(
      "resolved",
      makeResolvedPayload({ outcome: "user-picked", resolvedBy: "user" }),
    );
    expect(deriveThreadModelChoice([requested, resolved])).toMatchObject({
      status: "resolved",
      outcome: "user-picked",
      cancelled: false,
    });
    expect(deriveThreadModelChoice([makeActivity({ kind: "tool.completed" })])).toBeNull();
  });

  it("reuses the derivation for the same activities array", () => {
    const activities = [modelChoiceActivity("requested", makeRequestedPayload())];
    expect(deriveThreadModelChoice(activities)).toBe(deriveThreadModelChoice(activities));
  });
});

describe("readLinkedModelChoiceSummary", () => {
  it("reads the optional summary on the trunk's linked activity", () => {
    expect(
      readLinkedModelChoiceSummary({
        modelChoice: { requested: { provider: "cursor", model: "composer-1" }, status: "pending" },
      }),
    ).toEqual({ requested: { provider: "cursor", model: "composer-1" }, status: "pending" });
    expect(readLinkedModelChoiceSummary({})).toBeNull();
    expect(readLinkedModelChoiceSummary({ modelChoice: { status: "nope" } })).toBeNull();
  });
});

describe("work log", () => {
  it("hides model choice activities; the notice renders them instead (A6)", () => {
    const entries = deriveWorkLogEntries(
      [
        modelChoiceActivity("requested", makeRequestedPayload()),
        modelChoiceActivity("resolved", makeResolvedPayload()),
        makeActivity({ id: "tool", kind: "tool.completed", summary: "Ran" }),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["tool"]);
  });
});
