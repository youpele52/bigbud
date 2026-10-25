import type { DelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";
import { describe, expect, it } from "vitest";

import {
  deriveModelChoiceCardRow,
  deriveModelChoiceNotice,
  MODEL_CHOICE_VISIBLE_OPTIONS,
  modelChoiceRemainingMs,
  visibleModelChoiceOptions,
} from "./ThreadModelChoiceNotice.logic";
import { makeRequestedPayload, makeResolvedPayload } from "./ThreadModelChoiceNotice.test.helpers";

const pending = (extra = 0): DelegatedModelChoiceRecord => ({
  status: "pending",
  ...makeRequestedPayload({ extra }),
});
const resolved = (
  overrides: Parameters<typeof makeResolvedPayload>[0] = {},
): DelegatedModelChoiceRecord => ({
  ...makeResolvedPayload(overrides),
  status: "resolved",
  cancelled: overrides.cancelled === true,
});

describe("modelChoiceRemainingMs", () => {
  it("counts down 10 s on this browser's clock and never goes negative", () => {
    expect(modelChoiceRemainingMs(1_000, 1_000)).toBe(10_000);
    expect(modelChoiceRemainingMs(1_000, 4_500)).toBe(6_500);
    expect(modelChoiceRemainingMs(1_000, 60_000)).toBe(0);
  });
});

describe("deriveModelChoiceNotice", () => {
  it("is a blue pending notice with the countdown in whole seconds", () => {
    expect(deriveModelChoiceNotice(pending(), 6_500)).toEqual({
      kind: "pending",
      tone: "info",
      title: "Choose a model for this thread",
      description:
        "Requested composer-1 isn't available (provider is hidden). Choose a model — using gpt-5 in 7s.",
    });
    expect(deriveModelChoiceNotice(pending(), 0).description).toBe(
      "Requested composer-1 isn't available (provider is hidden). Using gpt-5 now…",
    );
  });

  it("is green for the requested model and for a user pick", () => {
    expect(
      deriveModelChoiceNotice(
        resolved({
          reason: null,
          used: { provider: "cursor", model: "composer-1" },
          outcome: "requested",
          resolvedBy: "server",
        }),
        0,
      ),
    ).toMatchObject({
      kind: "requested",
      tone: "success",
      title: "Using requested model composer-1",
    });
    expect(
      deriveModelChoiceNotice(
        resolved({
          used: { provider: "claudeAgent", model: "claude-sonnet" },
          outcome: "user-picked",
          resolvedBy: "user",
        }),
        0,
      ),
    ).toMatchObject({
      kind: "user-picked",
      tone: "success",
      title: "You chose claude-sonnet (requested composer-1 unavailable)",
    });
  });

  it("is amber when the trunk's model was used, with why nobody chose", () => {
    expect(deriveModelChoiceNotice(resolved(), 0)).toEqual({
      kind: "fallback",
      tone: "warning",
      title: "Requested composer-1 unavailable (provider is hidden); used gpt-5",
      description: "No model was chosen within 10 seconds.",
    });
    expect(
      deriveModelChoiceNotice(resolved({ requested: null, reason: "invalid-request" }), 0).title,
    ).toBe("Requested model unavailable (the request was invalid); used gpt-5");
    expect(deriveModelChoiceNotice(resolved({ requested: { provider: "cursor" } }), 0).title).toBe(
      "Requested Cursor unavailable (provider is hidden); used gpt-5",
    );
    expect(deriveModelChoiceNotice(resolved({ cancelled: true }), 0)).toMatchObject({
      kind: "cancelled",
      tone: "warning",
    });
  });
});

describe("visibleModelChoiceOptions", () => {
  it("shows the first 12 options until Show all", () => {
    const options = makeRequestedPayload({ extra: 20 }).options;
    const collapsed = visibleModelChoiceOptions(options, false);
    expect(collapsed.visible).toHaveLength(MODEL_CHOICE_VISIBLE_OPTIONS);
    expect(collapsed.hiddenCount).toBe(options.length - MODEL_CHOICE_VISIBLE_OPTIONS);
    expect(visibleModelChoiceOptions(options, true)).toEqual({ visible: options, hiddenCount: 0 });
  });
});

describe("deriveModelChoiceCardRow", () => {
  it("summarizes a child's choice for the trunk card", () => {
    expect(deriveModelChoiceCardRow(undefined, null)).toBeNull();
    expect(deriveModelChoiceCardRow({ source: "tributary", record: pending() }, 3_200)).toEqual({
      kind: "pending",
      label: "Choose model · 4s",
    });
    // A linked summary may be stale after a reload, so it shows only what was requested.
    expect(
      deriveModelChoiceCardRow(
        {
          source: "linked",
          summary: { requested: { provider: "cursor", model: "composer-1" }, status: "pending" },
        },
        null,
      ),
    ).toEqual({ kind: "requested", label: "Requested composer-1" });
    expect(
      deriveModelChoiceCardRow(
        { source: "linked", summary: { requested: null, status: "pending" } },
        null,
      ),
    ).toBeNull();
    expect(deriveModelChoiceCardRow({ source: "tributary", record: resolved() }, null)).toEqual({
      kind: "resolved",
      tone: "warning",
      label: "gpt-5",
      title: "Requested composer-1 unavailable (provider is hidden); used gpt-5",
    });
  });
});

describe("agent-supplied model text (L10)", () => {
  it("strips control, newline and bidi characters before display", () => {
    const record: DelegatedModelChoiceRecord = {
      status: "pending",
      ...makeRequestedPayload({}),
      requested: { provider: "cursor", model: "evil\u202Emodel\n\u0007\u2066x" },
    };
    expect(deriveModelChoiceNotice(record, 0).description).toBe(
      "Requested evilmodelx isn't available (provider is hidden). Using gpt-5 now…",
    );
    expect(
      deriveModelChoiceCardRow(
        {
          source: "linked",
          summary: { requested: { provider: "cursor", model: "a\r\nb" }, status: "pending" },
        },
        null,
      ),
    ).toEqual({ kind: "requested", label: "Requested ab" });
  });

  it("never reads inherited properties as provider display names", () => {
    const record: DelegatedModelChoiceRecord = {
      status: "pending",
      ...makeRequestedPayload({}),
      requested: { provider: "constructor" },
    };
    expect(deriveModelChoiceNotice(record, 0).description).toBe(
      "Requested constructor isn't available (provider is hidden). Using gpt-5 now…",
    );
  });

  it("falls back to generic text when nothing printable remains", () => {
    const record: DelegatedModelChoiceRecord = {
      status: "pending",
      ...makeRequestedPayload({}),
      requested: { provider: "\u202E", model: "\n\u0000" },
    };
    expect(deriveModelChoiceNotice(record, 0).description).toBe(
      "Requested model isn't available (provider is hidden). Using gpt-5 now…",
    );
  });
});
