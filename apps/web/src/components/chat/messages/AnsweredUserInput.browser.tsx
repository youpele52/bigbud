import "../../../index.css";
import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AnsweredUserInput } from "./AnsweredUserInput";
import { formatShortTimestamp } from "~/utils/timestamp";

const mocks = vi.hoisted(() => ({ copy: vi.fn(() => Promise.resolve()) }));
vi.mock("~/lib/clipboard/copyText", () => ({ copyTextToClipboard: mocks.copy }));

it("starts collapsed and expands with every question, option description and answer", async () => {
  const screen = await render(
    <AnsweredUserInput
      answeredAt="2026-10-24T10:05:00.000Z"
      timestampFormat="24-hour"
      input={{
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        createdAt: "2026-10-24T10:00:00.000Z",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Which mode?",
            multiSelect: true,
            options: [
              { id: "safe", label: "Safe mode", description: "Read only" },
              { id: "write", label: "Write mode", description: "Allow changes" },
            ],
          },
          { id: "note", header: "Notes", question: "Any additional context?", options: [] },
        ],
      }}
      answers={{ mode: ["safe", "Custom choice"], note: "Keep the current setup" }}
    />,
  );
  await expect.element(screen.getByText("Question", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText(formatShortTimestamp("2026-10-24T10:05:00.000Z", "24-hour")))
    .toBeVisible();
  await expect.element(screen.getByText("Which mode?")).not.toBeVisible();
  await screen.getByText("Question", { exact: true }).click();
  await expect.element(screen.getByText("Which mode?")).toBeVisible();
  await expect.element(screen.getByText("Read only", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("Write mode", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Allow changes", { exact: false })).toBeVisible();
  await expect.element(screen.getByText("Safe mode, Custom choice")).toBeVisible();
  await expect.element(screen.getByText("Any additional context?")).toBeVisible();
  await expect.element(screen.getByText("Keep the current setup")).toBeVisible();
  await screen.getByText("Keep the current setup").hover();
  const questionLabel = screen.getByText("1. Mode", { exact: true }).element();
  const summary = screen.getByText("Question", { exact: true }).element().closest("summary")!;
  const answerLabels = Array.from(questionLabel.closest("details")!.querySelectorAll("p")).filter(
    (element) => element.textContent === "Your answer",
  );
  expect(answerLabels).toHaveLength(2);
  for (const answerLabel of answerLabels) {
    const answerStyle = getComputedStyle(answerLabel);
    const summaryStyle = getComputedStyle(summary);
    expect(answerStyle.fontSize).toBe(summaryStyle.fontSize);
    expect(answerStyle.fontWeight).toBe(summaryStyle.fontWeight);
    expect(answerStyle.color).toBe(summaryStyle.color);
    expect(answerLabel.parentElement?.classList).toContain("mt-4");
    expect(answerLabel.getBoundingClientRect().left).toBe(
      questionLabel.getBoundingClientRect().left,
    );
  }
  await screen.getByText("Question", { exact: true }).click();
  await expect.element(screen.getByText("Which mode?")).not.toBeVisible();
});

it("omits the duplicate generic heading and copies the complete exchange below the divider", async () => {
  mocks.copy.mockClear();
  const screen = await render(
    <>
      <button type="button">Outside question</button>
      <AnsweredUserInput
        answeredAt="2026-10-24T10:05:00.000Z"
        timestampFormat="24-hour"
        input={{
          requestId: ApprovalRequestId.makeUnsafe("request-copy"),
          createdAt: "2026-10-24T10:00:00.000Z",
          questions: [
            {
              id: "skill",
              header: "Question",
              question: "Which skill?",
              options: [
                { label: "Cooking", description: "Prepare food" },
                { label: "Music", description: "Play an instrument" },
              ],
            },
          ],
        }}
        answers={{ skill: "Cooking" }}
      />
    </>,
  );
  const heading = screen.getByText("Question", { exact: true });
  const copy = screen.getByRole("button", { name: "Copy message" });
  const copyActions = copy.element().parentElement!;
  await screen.getByRole("button", { name: "Outside question" }).hover();
  await expect.poll(() => getComputedStyle(copyActions).opacity).toBe("0");
  await heading.hover();
  await expect.poll(() => getComputedStyle(copyActions).opacity).toBe("1");
  await screen.getByRole("button", { name: "Outside question" }).hover();
  await expect.poll(() => getComputedStyle(copyActions).opacity).toBe("0");
  (copy.element() as HTMLButtonElement).focus();
  await expect.poll(() => getComputedStyle(copyActions).opacity).toBe("1");
  const details = heading.element().closest("details")!;
  expect(details.contains(copy.element())).toBe(false);
  expect(copy.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
    details.getBoundingClientRect().bottom,
  );
  await copy.click();
  await expect.poll(() => mocks.copy.mock.calls.length).toBe(1);
  expect(mocks.copy).toHaveBeenCalledWith(
    "Question: Which skill?\nOptions:\n- Cooking — Prepare food\n- Music — Play an instrument\nYour answer: Cooking",
  );
  expect(details.open).toBe(false);
  await heading.click();
  await expect.element(screen.getByText("Which skill?", { exact: true })).toBeVisible();
  expect(details.querySelectorAll("p")[0]?.textContent).toBe("Which skill?");
});
