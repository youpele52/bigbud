import { useRef, useState } from "react";
import type { UserInputQuestion } from "@bigbud/contracts";
import type { PendingUserInputDraftAnswer } from "../../../logic/user-input/pending.logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
} from "../../../logic/user-input/pending.logic";
import { useApplyPromptReplacement } from "./ChatView.composerHandlers.logic";

/** Drive the real replacement hook and state setter, not a duplicate of its answer helper. */
export function ReplacementFixture() {
  const question: UserInputQuestion = {
    id: "tags",
    header: "Tags",
    question: "Tags?",
    options: [{ id: "exact", label: "Display", description: "Display" }],
    multiSelect: true,
    field: { type: "multiselect", required: true, allowCustom: true, minItems: 2 },
  };
  const [answers, setAnswers] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({ frm_replace: { tags: { selectedOptionIds: ["exact"] } } });
  const promptRef = useRef("");
  const editor = useRef(null);
  const replacement = useApplyPromptReplacement({
    promptRef,
    setPrompt: () => {},
    setComposerCursor: () => {},
    setComposerTrigger: () => {},
    activePendingProgress: derivePendingUserInputProgress([question], answers.frm_replace!, 0),
    activePendingUserInput: { requestId: "frm_replace" },
    isOpencodePendingUserInputMode: false,
    setPendingUserInputAnswersByRequestId: setAnswers,
    composerEditorRef: editor,
  });
  return (
    <>
      <button
        onClick={() =>
          replacement(0, promptRef.current.length, '["custom"]', { focusComposer: false })
        }
      >
        Replace answer
      </button>
      <output>
        {JSON.stringify(buildPendingUserInputAnswers([question], answers.frm_replace!))}
      </output>
    </>
  );
}
