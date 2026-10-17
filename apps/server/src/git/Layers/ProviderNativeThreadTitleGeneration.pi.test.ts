import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { generatePiThreadTitleNative } from "./ProviderNativeThreadTitleGeneration.pi.ts";
import { createPiRpcProcess } from "../../provider/Layers/Pi/RpcProcess.ts";
import { runInternalTextGeneration } from "./InternalTextGenerationPolicy.ts";

vi.mock("../../provider/Layers/Pi/RpcProcess.ts", () => ({ createPiRpcProcess: vi.fn() }));

describe("Pi unattended title invocation boundary", () => {
  it("rejects an exact-model candidate before any native process or prompt and allows only the authorized fallback", async () => {
    const preference = {
      provider: "pi" as const,
      model: "exact-model",
      subProviderID: "exact-account",
    };
    const successful = { provider: "codex" as const, model: "verified-model" };
    const invoked: unknown[] = [];
    const result = await Effect.runPromise(
      runInternalTextGeneration({
        operation: "generateThreadTitle",
        preference,
        successful,
        generate: (selection) =>
          selection.provider === "pi"
            ? generatePiThreadTitleNative({} as Parameters<typeof generatePiThreadTitleNative>[0], {
                cwd: "/fixture",
                message: "Title",
                modelSelection: selection,
              })
            : Effect.sync(() => {
                invoked.push(selection);
                return { title: "Verified title" };
              }),
      }),
    );
    expect(result.title).toBe("Verified title");
    expect(createPiRpcProcess).not.toHaveBeenCalled();
    expect(invoked).toEqual([successful]);
  });
});
