import { expect, it } from "vitest";
import { derivePendingUserInputs } from "./session.logic";
import { makeActivity } from "./session.logic.test.helpers";

it("canonical form metadata survives normal activity projection and resolved cancellation removes the request", () => {
  const field = { type: "boolean", required: true, allowCustom: false } as const;
  const requested = makeActivity({
    id: "typed-form",
    kind: "user-input.requested",
    payload: {
      requestId: "frm_typed",
      questions: [
        {
          id: "enabled",
          header: "Enabled",
          question: "Enable?",
          options: [{ id: "false", label: "No", description: "No" }],
          field,
        },
      ],
    },
  });
  expect(derivePendingUserInputs([requested])[0]?.questions[0]).toMatchObject({
    field,
    options: [{ id: "false" }],
  });
  const resolved = makeActivity({
    id: "typed-form-cancel",
    kind: "user-input.resolved",
    payload: { requestId: "frm_typed", answers: {} },
  });
  expect(derivePendingUserInputs([requested, resolved])).toEqual([]);
});
