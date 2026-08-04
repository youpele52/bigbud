import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { appendPiAttachmentInstructions, applyModelSelection } from "./Adapter.session.helpers.ts";
import type { ActivePiSession } from "./Adapter.types.ts";

function makeSession(
  request: ActivePiSession["process"]["request"],
  thinkingLevel: ActivePiSession["thinkingLevel"] = "medium",
): ActivePiSession {
  return {
    process: { request },
    threadId: ThreadId.makeUnsafe("pi-thinking-thread"),
    model: "reasoning-model",
    providerID: "openai",
    thinkingLevel,
    updatedAt: "2026-08-04T00:00:00.000Z",
  } as unknown as ActivePiSession;
}

describe("applyModelSelection Pi thinking levels", () => {
  it("refreshes the effective state after Pi clamps a requested level", async () => {
    const calls: string[] = [];
    const request = vi.fn(async (command: { type: string }) => {
      calls.push(command.type);
      return command.type === "get_state"
        ? {
            type: "response" as const,
            command: "get_state",
            success: true,
            data: {
              model: { id: "reasoning-model", name: "Reasoning", provider: "openai" },
              thinkingLevel: "low" as const,
            },
          }
        : {
            type: "response" as const,
            command: "set_thinking_level",
            success: true,
          };
    }) as unknown as ActivePiSession["process"]["request"];
    const session = makeSession(request);

    await Effect.runPromise(
      applyModelSelection({
        session,
        modelSelection: {
          provider: "pi",
          model: "reasoning-model",
          subProviderID: "openai",
          options: { thinkingLevel: "xhigh" },
        },
      }),
    );

    expect(calls).toEqual(["set_thinking_level", "get_state"]);
    expect(session.thinkingLevel).toBe("low");
  });

  it("does not send set_thinking_level when the requested level is unchanged", async () => {
    const request = vi.fn() as unknown as ActivePiSession["process"]["request"];
    const session = makeSession(request, "high");

    await Effect.runPromise(
      applyModelSelection({
        session,
        modelSelection: {
          provider: "pi",
          model: "reasoning-model",
          subProviderID: "openai",
          options: { thinkingLevel: "high" },
        },
      }),
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes after a model change before applying the explicit level", async () => {
    const calls: string[] = [];
    let stateReads = 0;
    const request = vi.fn(async (command: { type: string }) => {
      calls.push(command.type);
      if (command.type === "get_state") {
        stateReads += 1;
        return {
          type: "response" as const,
          command: "get_state",
          success: true,
          data: {
            model: { id: "next-model", name: "Next", provider: "anthropic" },
            thinkingLevel: stateReads === 1 ? ("medium" as const) : ("high" as const),
          },
        };
      }
      return { type: "response" as const, command: command.type, success: true };
    }) as unknown as ActivePiSession["process"]["request"];
    const session = makeSession(request);

    await Effect.runPromise(
      applyModelSelection({
        session,
        modelSelection: {
          provider: "pi",
          model: "next-model",
          subProviderID: "anthropic",
          options: { thinkingLevel: "high" },
        },
      }),
    );

    expect(calls).toEqual(["set_model", "get_state", "set_thinking_level", "get_state"]);
    expect(session.thinkingLevel).toBe("high");
  });
});

describe("PiAdapter.session.helpers attachments", () => {
  it("adds attachment handling instructions when file attachments are present", () => {
    const prompt = appendPiAttachmentInstructions({
      prompt: "summarize this",
      hasFileAttachments: true,
    });

    expect(prompt).toContain("summarize this");
    expect(prompt).toContain("Use attached document content only when it appears");
    expect(prompt).toContain("Use image OCR content only when it appears in <attached_image_ocr>");
    expect(prompt).toContain("Do not call file-reading tools on attachment paths");
  });

  it("does not change prompts without file attachments", () => {
    expect(
      appendPiAttachmentInstructions({
        prompt: "summarize this image",
        hasFileAttachments: false,
      }),
    ).toBe("summarize this image");
  });
});
