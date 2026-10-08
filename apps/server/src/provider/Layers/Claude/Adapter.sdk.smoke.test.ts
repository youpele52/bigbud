import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  liveSmokeTextDeltas,
  makeLiveSmokeQuery,
  makeLiveSmokeWorkspace,
  readLiveSmokeTurn,
  writeLiveSmokeReport,
} from "./Adapter.sdk.smoke.helpers.ts";

const smokeTest = process.env.BIGBUD_CLAUDE_SDK_SMOKE === "1" ? it : it.skip;

describe("Claude Agent SDK real-turn lifecycle smoke", () => {
  smokeTest(
    "streams, remembers a second turn, resumes a fresh query and interrupts an active turn",
    async () => {
      const workspace = await makeLiveSmokeWorkspace();
      const marker = `MARKER_${randomUUID().replaceAll("-", "")}`;
      let first: Awaited<ReturnType<typeof makeLiveSmokeQuery>> | undefined;
      let resumed: Awaited<ReturnType<typeof makeLiveSmokeQuery>> | undefined;
      const abortController = new AbortController();
      const deadline = setTimeout(() => abortController.abort(), 50_000);
      try {
        first = await makeLiveSmokeQuery(workspace.cwd, { abortController });
        first.prompts.send(
          `Remember this harmless marker for our conversation: ${marker}. Reply only with that marker.`,
        );
        const initial = await readLiveSmokeTurn(first.iterator);
        expect(initial.result.subtype).toBe("success");
        expect(initial.result.is_error).toBe(false);
        expect(initial.result.subtype === "success" && initial.result.result.trim()).toBe(marker);
        expect(liveSmokeTextDeltas(initial.messages).trim()).toBe(marker);
        expect(initial.result.total_cost_usd).toBeLessThanOrEqual(0.15);
        const nativeSessionId = initial.result.session_id;
        expect(nativeSessionId.length).toBeGreaterThan(0);

        first.prompts.send(
          "What was the harmless marker I asked you to remember? Reply only with that marker.",
        );
        const second = await readLiveSmokeTurn(first.iterator);
        expect(second.result.subtype).toBe("success");
        expect(second.result.is_error).toBe(false);
        expect(second.result.subtype === "success" && second.result.result.trim()).toBe(marker);
        expect(second.result.session_id === nativeSessionId).toBe(true);
        expect(second.result.total_cost_usd).toBeLessThanOrEqual(0.15);
        first.close();
        expect((await first.iterator.next()).done).toBe(true);

        resumed = await makeLiveSmokeQuery(workspace.cwd, {
          resume: nativeSessionId,
          abortController,
        });
        resumed.prompts.send(
          "What was the harmless marker in our earlier conversation? Reply only with that marker.",
        );
        const restored = await readLiveSmokeTurn(resumed.iterator);
        expect(restored.result.subtype).toBe("success");
        expect(restored.result.is_error).toBe(false);
        expect(restored.result.subtype === "success" && restored.result.result.trim()).toBe(marker);
        expect(restored.result.session_id === nativeSessionId).toBe(true);

        resumed.prompts.send(
          "Print the integers from 1 through 300, separated by spaces. Start immediately. Do not use tools.",
        );
        let interrupted = false;
        const active = resumed;
        const interruptedTurn = await readLiveSmokeTurn(active.iterator, async (message) => {
          if (!interrupted && liveSmokeTextDeltas([message]).length > 0) {
            interrupted = true;
            await active.runtime.interrupt();
          }
        });
        expect(interrupted).toBe(true);
        expect(["aborted_streaming", "aborted_tools"]).toContain(
          interruptedTurn.result.terminal_reason,
        );
        expect(interruptedTurn.result.session_id === nativeSessionId).toBe(true);
        // Resumed totals include the prior transcript's spend; do not sum turn totals.
        expect(interruptedTurn.result.total_cost_usd).toBeLessThanOrEqual(0.3);
        for (const turn of [initial, second, restored, interruptedTurn]) {
          expect(turn.result.permission_denials).toEqual([]);
        }
        resumed.close();
        expect((await resumed.iterator.next()).done).toBe(true);
        await writeLiveSmokeReport("claude-real-sdk", {
          binary: process.env.BIGBUD_CLAUDE_SDK_SMOKE_BINARY ?? "claude",
          model: first.model,
          turns: 4,
          streaming: true,
          sameQueryMemory: true,
          freshQueryResumeMemory: true,
          nativeSessionIdPreserved: true,
          activeInterrupt: true,
          interruptionReason: interruptedTurn.result.terminal_reason,
          queriesClosed: 2,
          iteratorExhaustedAfterClose: true,
          messageCounts: [
            initial.messages.length,
            second.messages.length,
            restored.messages.length,
            interruptedTurn.messages.length,
          ],
          cumulativeEstimatedUsd: interruptedTurn.result.total_cost_usd,
          firstQueryEstimatedUsd: second.result.total_cost_usd,
          conservativeSumEstimatedUsd:
            Math.max(initial.result.total_cost_usd, second.result.total_cost_usd) +
            Math.max(restored.result.total_cost_usd, interruptedTurn.result.total_cost_usd),
        });
        console.info(
          "Claude real-turn validation: 4 turns; streaming, same-query memory, fresh-query resume and active interrupt verified; cumulative estimated USD",
          interruptedTurn.result.total_cost_usd.toFixed(6),
        );
      } finally {
        clearTimeout(deadline);
        first?.close();
        resumed?.close();
        await workspace.cleanup();
      }
    },
    60_000,
  );
});
