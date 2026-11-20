import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { requireCrossProjectConfirmation } from "./ThreadCoordinationConfirmation.ts";
import { threadCoordinationQuestionTool } from "./ThreadCoordinationConfirmation.questionTool.ts";
import { confirmationRequiredResult } from "./ThreadCoordinationConfirmation.result.ts";
import { makeTestCoordination } from "./ThreadCoordinationConfirmation.test.helpers.ts";

const challenge = {
  code: "BB-7Q4KM2XZ",
  projectId: ProjectId.makeUnsafe("project-b"),
  projectTitle: "Billing",
  targetIsRemote: false,
};
const GENERIC_ESCAPE = "If you have no question tool";

const instructionsFor = (provider: string | null | undefined) =>
  confirmationRequiredResult(challenge, {
    questionTool: threadCoordinationQuestionTool(provider),
  }).instructions;

describe("threadCoordinationQuestionTool", () => {
  it("names each verified provider's question tool", () => {
    expect(threadCoordinationQuestionTool("claudeAgent")?.name).toBe("AskUserQuestion");
    expect(threadCoordinationQuestionTool("codex")).toEqual({
      name: "request_user_input",
      mayBeMissing: true,
    });
    expect(threadCoordinationQuestionTool("devin")?.name).toBe("ask_user_question");
    expect(threadCoordinationQuestionTool("opencode")?.name).toBe("question");
    expect(threadCoordinationQuestionTool("opencodeV2")?.name).toBe("question");
    expect(threadCoordinationQuestionTool("pi")?.name).toBe("ask_user");
  });

  it("returns nothing for unknown, unverified, missing or prototype-key providers", () => {
    for (const provider of ["copilot", "cursor", "muse", "cliProxy", "nope", "toString", null]) {
      expect(threadCoordinationQuestionTool(provider)).toBeUndefined();
    }
    expect(threadCoordinationQuestionTool(undefined)).toBeUndefined();
  });
});

describe("confirmation instructions by caller provider", () => {
  it("makes Codex's request_user_input the next step, with a tool-list-only chat fallback", () => {
    const text = instructionsFor("codex");
    expect(text).toContain("Your next step is to call `request_user_input`");
    expect(text).toContain('the options "Allow" and "Deny"');
    expect(text).toContain("Do not ask in chat text or through render_html");
    expect(text).toContain("Only if `request_user_input` is not in your tool list");
    // Live Codex runs typed "- Allow / - Deny" as chat text and believed it had asked.
    expect(text).toContain(
      "Writing the question or an Allow/Deny list in a message does not ask the user; only the `request_user_input` call does.",
    );
    expect(text).not.toContain(GENERIC_ESCAPE);
  });

  it("gives providers whose tool is always present no chat escape before they ask", () => {
    for (const [provider, tool] of [
      ["claudeAgent", "AskUserQuestion"],
      ["pi", "ask_user"],
      ["devin", "ask_user_question"],
      ["opencodeV2", "question"],
    ] as const) {
      const text = instructionsFor(provider);
      expect(text).toContain(`Your next step is to call \`${tool}\``);
      expect(text).not.toContain(GENERIC_ESCAPE);
      expect(text).not.toContain("is not in your tool list");
      // A retry that still fails after a real answer may still fall back to chat.
      expect(text).toContain("If a retry still returns confirmation_required");
      expect(text).toContain("Never answer on the user's behalf.");
    }
  });

  it("keeps the generic wording, with its chat fallback, for unlisted providers", () => {
    expect(instructionsFor("copilot")).toContain(GENERIC_ESCAPE);
    expect(instructionsFor(undefined)).toContain(GENERIC_ESCAPE);
  });

  it("keeps the unavailable wording regardless of the provider", () => {
    const result = confirmationRequiredResult(challenge, {
      unavailable: true,
      questionTool: threadCoordinationQuestionTool("codex"),
    });
    expect(result.instructions).toContain("unavailable");
    expect(result.instructions).not.toContain("request_user_input");
  });
});

describe("requireCrossProjectConfirmation with a caller provider", () => {
  it("names the caller's question tool on the first and the repeated challenge", async () => {
    const { coordination } = makeTestCoordination();
    const gate = () =>
      Effect.runPromise(
        requireCrossProjectConfirmation({
          coordination,
          callerThreadId: ThreadId.makeUnsafe("caller-codex"),
          callerProvider: "codex",
          project: { id: challenge.projectId, title: "Billing", targetIsRemote: false },
        }),
      );
    for (const access of [await gate(), await gate()]) {
      if (access.kind !== "confirmation_required") throw new Error(`got ${access.kind}`);
      expect(access.result.instructions).toContain(
        "Your next step is to call `request_user_input`",
      );
    }
  });
});
