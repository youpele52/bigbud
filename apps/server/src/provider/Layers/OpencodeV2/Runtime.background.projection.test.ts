import { expect, it } from "vitest";
import { projectV2TurnInterval } from "./Runtime.background.projection.ts";
import {
  backgroundAssistant,
  backgroundNotice,
  backgroundIdle,
  backgroundInterval,
  backgroundContinuation,
} from "./Runtime.background.fixture.ts";

it("does not equate idle with closure while a known shell completion is still outstanding", () => {
  const result = projectV2TurnInterval(backgroundInterval());
  expect(result).toMatchObject({ background: { pending: 1 }, terminalOutcome: "interrupted" });
  expect(result?.idle).toBeUndefined();
});

it("accounts for both sides of interrupted idle and preserves interruption only after the final continuation closes", () => {
  const interval = [...backgroundInterval(), ...backgroundContinuation()];
  const result = projectV2TurnInterval(interval);
  expect(result).toMatchObject({
    background: { pending: 0 },
    terminalOutcome: "interrupted",
    idle: { id: "final" },
  });
  expect(result?.assistants.map((message) => message.id)).toEqual([
    "launch",
    "before-interruption",
    "after-interruption",
  ]);
  expect(projectV2TurnInterval(interval.slice(0, -1))?.idle).toBeUndefined();
});

it.each(["unknown", "duplicate", "wrong-job", "not-terminal", "nested-tool"] as const)(
  "retains ambiguity for %s background provenance",
  (kind) => {
    const interval = backgroundInterval();
    const notice = backgroundNotice(
      kind === "unknown" ? "sh_unowned" : kind === "duplicate" ? "sh_first" : "sh_late",
    );
    if (kind === "wrong-job") notice.metadata!.jobID = "sh_foreign";
    if (kind === "not-terminal") notice.metadata!.state = "running";
    if (kind === "nested-tool") {
      const assistant = backgroundAssistant("nested", ["sh_hidden"]);
      const tool = assistant.content.find((part) => part.type === "tool")!;
      if (tool.type === "tool") tool.name = "execute";
      interval.splice(1, 0, assistant);
    }
    expect(
      projectV2TurnInterval([...interval, notice, backgroundIdle("last", "succeeded")]),
    ).toBeUndefined();
  },
);

it("does not borrow shell launch evidence from an earlier admission", () => {
  expect(
    projectV2TurnInterval([backgroundNotice("sh_old"), backgroundIdle("last", "succeeded")]),
  ).toBeUndefined();
});

it("does not infer all jobs were enumerated when another shell call lost its final handoff metadata", () => {
  const unknown = backgroundAssistant("uncertain-shell", ["sh_unknown"]);
  const tool = unknown.content.find((part) => part.type === "tool")!;
  if (tool.type === "tool" && tool.state.status === "completed") delete tool.state.metadata;
  expect(
    projectV2TurnInterval([unknown, ...backgroundInterval(), ...backgroundContinuation()]),
  ).toBeUndefined();
});
