import { expect, it, vi } from "vitest";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { V2ThreadBridge } from "./Orchestration.bridge.ts";

it("pinned handler dispatches through the existing HTTP/SQLite pipeline and persists its final result", async () => {
  const original = V2ThreadBridge.prototype.callback;
  let refused: unknown;
  const observer = vi
    .spyOn(V2ThreadBridge.prototype, "callback")
    .mockImplementation(async function (this: V2ThreadBridge, ...args) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        refused = error instanceof Error ? error.message : "classified fixture failure";
        throw error;
      }
    });
  try {
    await withV2ProductionThreadTools(async ({ invoke }) => {
      const result = await invoke("create_thread", {
        title: "pinned child",
        task: "Owned test input",
      }).catch(() => undefined);
      expect(refused).toBeUndefined();
      expect(result).toMatchObject({ ok: true });
    });
  } finally {
    observer.mockRestore();
  }
});
