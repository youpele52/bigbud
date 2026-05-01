import { describe, expect, it } from "vitest";

describe("useVoiceTranscribe", () => {
  it("exports the useVoiceTranscribe hook function", async () => {
    const mod = await import("./useVoiceTranscribe");
    expect(typeof mod.useVoiceTranscribe).toBe("function");
  });
});
