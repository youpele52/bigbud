import { expect, it } from "vitest";
import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

import {
  buildPendingAttachmentFollowUpText,
  resolvePendingSubmissionAnswers,
} from "./ChatView.sendTurn.pendingAnswer.logic";

const deploy: UserInputQuestion = {
  id: "deploy",
  header: "Deploy target",
  question: "Where should this deploy?",
  options: [
    { label: "Staging", description: "Staging" },
    { label: "Production", description: "Production" },
  ],
  multiSelect: false,
};
const areas: UserInputQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas?",
  options: [
    { label: "Server", description: "Server" },
    { label: "Web", description: "Web" },
  ],
  multiSelect: true,
};
const optional: UserInputQuestion = {
  id: "notes",
  header: "Notes",
  question: "Anything else?",
  options: [],
  field: { type: "string", required: false, allowCustom: true },
};

it("submits per-question answers and gives composer text only to the active question", () => {
  expect(
    resolvePendingSubmissionAnswers({
      requestId: "request",
      questions: [deploy, areas],
      draftAnswers: {
        deploy: { selectedOptionLabels: ["Staging"], customAnswer: "behind the flag" },
        areas: { selectedOptionLabels: ["Server", "Web"] },
      },
      activeQuestionId: "areas",
      promptText: "  mobile too ",
    }),
  ).toEqual({
    deploy: "Staging\nbehind the flag",
    areas: "Server, Web\nmobile too",
  });
});

it("refuses a required question with nothing chosen and skips a blank optional one", () => {
  const base = { requestId: "request", activeQuestionId: "deploy", promptText: "" };
  expect(
    resolvePendingSubmissionAnswers({ ...base, questions: [deploy], draftAnswers: {} }),
  ).toBeNull();
  expect(
    resolvePendingSubmissionAnswers({
      ...base,
      questions: [deploy, optional],
      draftAnswers: { deploy: { selectedOptionLabels: ["Production"] } },
    }),
  ).toEqual({ deploy: "Production" });
});

it("keeps the request-keyed text answer for requests without questions", () => {
  const base = { requestId: "request", questions: [], draftAnswers: undefined };
  expect(
    resolvePendingSubmissionAnswers({ ...base, activeQuestionId: null, promptText: " Yes " }),
  ).toEqual({ request: "Yes" });
  expect(
    resolvePendingSubmissionAnswers({ ...base, activeQuestionId: null, promptText: "  " }),
  ).toBeNull();
});

it("labels attachment follow-ups with one line per answered question", () => {
  expect(
    buildPendingAttachmentFollowUpText([deploy, areas, optional], { deploy: "Staging", areas: [] }),
  ).toBe(
    [
      "The attached files are part of my answer to: Deploy target",
      "The attached files are part of my answer to: Areas",
    ].join("\n"),
  );
  expect(buildPendingAttachmentFollowUpText([], { request: "Yes" })).toBe(
    "The attached files are part of my answer.",
  );
});
