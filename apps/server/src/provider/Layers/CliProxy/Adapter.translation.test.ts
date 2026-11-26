import { describe, expect, it } from "vitest";

import { refusePendingInteractions } from "../../pendingInteractionAdmission.ts";
import { remapError, toClaudeSendTurnInput, toClaudeSessionStartInput } from "./Adapter.ts";

describe("CLIProxy Claude input translation", () => {
  it("translates both provider identities when starting a session", () => {
    expect(
      toClaudeSessionStartInput({
        threadId: "thread-1",
        provider: "cliProxy",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
        runtimeMode: "full-access",
      } as never),
    ).toMatchObject({
      provider: "claudeAgent",
      modelSelection: { provider: "claudeAgent", model: "gpt-5-codex" },
    });
  });

  it("remaps both the refusal and the durable interaction owner from Claude to CLIProxy", () => {
    const refusal = refusePendingInteractions({
      provider: "claudeAgent",
      sessionEpoch: 3,
      approvals: new Map([["id", {}]]),
    });
    expect(remapError(refusal!)).toMatchObject({
      provider: "cliProxy",
      turnStartRefusal: {
        gate: {
          provider: "cliProxy",
          sessionEpoch: 3,
          approvalRequests: [{ requestId: "id", generation: "id" }],
        },
      },
    });
  });

  it("translates CLIProxy model selections when sending a turn", () => {
    expect(
      toClaudeSendTurnInput({
        threadId: "thread-1",
        input: "Hello",
        modelSelection: { provider: "cliProxy", model: "gpt-5-codex" },
      } as never),
    ).toMatchObject({
      modelSelection: { provider: "claudeAgent", model: "gpt-5-codex" },
    });
  });
});
