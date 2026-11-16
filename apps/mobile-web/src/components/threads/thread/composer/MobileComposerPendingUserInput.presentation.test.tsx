import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PendingUserInputPanel } from "~/components/chat/view/chat-view/PendingUserInputPanel";
import { derivePendingUserInputProgress } from "~/logic/user-input/pending.logic";

import { parityQuestion } from "../../../../test-fixtures/MobileParityReference.data";
import { MobileComposerPendingUserInput } from "./MobileComposerPendingUserInput";

function renderQuestion(request = parityQuestion) {
  const progress = derivePendingUserInputProgress(request.questions, {}, 0);
  return {
    desktop: renderToStaticMarkup(
      <PendingUserInputPanel
        pendingUserInput={request}
        progress={progress}
        onToggleOption={() => {}}
        onSelectQuestion={() => {}}
      />,
    ),
    mobile: renderToStaticMarkup(
      <MobileComposerPendingUserInput
        pendingUserInput={request}
        answers={{}}
        questionIndex={0}
        isResponding={false}
        onToggleOption={() => {}}
      />,
    ),
  };
}

describe("current desktop/mobile pending question presentation", () => {
  it("shares the attention label, title and truthful composer guidance", () => {
    const { desktop, mobile } = renderQuestion();
    for (const text of [
      "Needs you",
      "Branch",
      "Which branch should be used?",
      "Add context in the message box, or just send your selection.",
    ]) {
      expect(desktop).toContain(text);
      expect(mobile).toContain(text);
    }
    expect(mobile).not.toContain("uppercase");
    expect(mobile).toContain("min-h-11");
    expect(mobile).toContain('role="radiogroup"');
  });

  it("shares free-text instructions without implying an option is required", () => {
    const request = {
      ...parityQuestion,
      questions: [{ ...parityQuestion.questions[0]!, options: [] }],
    };
    const { desktop, mobile } = renderQuestion(request);
    const hint = "Type your answer in the message box and send.";
    expect(desktop).toContain(hint);
    expect(mobile).toContain(hint);
    expect(mobile).not.toContain('role="radiogroup"');
  });
});
