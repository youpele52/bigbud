import "../../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPromptEditor } from "./ComposerPromptEditor";

const SUGGESTION = "Add tests for the new parser";

function Harness(props: {
  suggestion: string | null;
  onValue: (value: string) => void;
  onKey: (key: string) => boolean;
}) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      terminalContexts={[]}
      disabled={false}
      placeholder="Ask anything"
      promptSuggestion={props.suggestion}
      onRemoveTerminalContext={() => {}}
      onChange={(next, nextCursor) => {
        setValue(next);
        setCursor(nextCursor);
        props.onValue(next);
      }}
      onCommandKeyDown={(key) => props.onKey(key)}
      onPaste={() => {}}
    />
  );
}

async function setup(suggestion: string | null = SUGGESTION) {
  const values: string[] = [];
  const onKey = vi.fn(() => false);
  await render(<Harness suggestion={suggestion} onValue={(v) => values.push(v)} onKey={onKey} />);
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  return { values, onKey, editor };
}

describe("composer prompt suggestion", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows ghost text with an accessible hint only while the composer is empty", async () => {
    const { editor } = await setup();
    await expect.element(page.getByText(SUGGESTION)).toBeVisible();
    await expect
      .element(editor)
      .toHaveAttribute(
        "aria-placeholder",
        `Suggested follow-up: ${SUGGESTION}. Press Tab to use it.`,
      );
    await userEvent.keyboard("W");
    await expect.element(page.getByText(SUGGESTION)).not.toBeInTheDocument();
  });

  it("accepts the suggestion with Tab", async () => {
    const { values, editor } = await setup();
    await userEvent.keyboard("{Tab}");
    await expect.element(editor).toHaveTextContent(SUGGESTION);
    expect(values.at(-1)).toBe(SUGGESTION);
  });

  it("accepts the suggestion with the right arrow", async () => {
    const { values } = await setup();
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(values.at(-1)).toBe(SUGGESTION));
  });

  it("never sends an unaccepted suggestion on Enter", async () => {
    const { values, onKey, editor } = await setup();
    await userEvent.keyboard("{Enter}");
    expect(onKey).toHaveBeenCalledWith("Enter");
    expect(values).not.toContain(SUGGESTION);
    expect(editor.element().textContent?.trim()).toBe("");
  });

  it("leaves Tab to the composer when there is no suggestion", async () => {
    const { values, onKey } = await setup(null);
    await userEvent.keyboard("{Tab}");
    expect(onKey).toHaveBeenCalledWith("Tab");
    expect(values).not.toContain(SUGGESTION);
  });
});
