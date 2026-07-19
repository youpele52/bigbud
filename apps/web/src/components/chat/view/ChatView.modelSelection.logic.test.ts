import { describe, expect, it } from "vitest";

import {
  getModelSelectionSubProviderID,
  modelPickerValue,
  modelSelectionsEqual,
} from "./ChatView.modelSelection.logic";

describe("CLIProxy model selection", () => {
  it("keeps source-qualified models distinct", () => {
    const codex = { provider: "cliProxy" as const, model: "gpt-5", subProviderID: "codex" };
    const claude = { provider: "cliProxy" as const, model: "gpt-5", subProviderID: "claude" };

    expect(getModelSelectionSubProviderID(codex)).toBe("codex");
    expect(modelPickerValue(codex)).toBe("gpt-5::codex");
    expect(modelSelectionsEqual(codex, claude)).toBe(false);
  });
});
