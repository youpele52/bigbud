import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupervisorPreparation } from "./ownershipHandoff.supervisor";

afterEach(() => vi.useRealTimers());
function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests: Array<{ operation: string; identity: string }> = [];
  output.on("data", (chunk) => requests.push(JSON.parse(String(chunk))));
  const supervisor = createSupervisorPreparation(input, output, 5000);
  const ack = () =>
    input.write(`${JSON.stringify({ operation: requests[0]!.operation, quiesced: true })}\n`);
  return { supervisor, requests, ack };
}
describe("monotonic supervisor preparation", () => {
  it("retains a delayed acknowledgment after the first prepare times out", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const first = f.supervisor.prepare("same-acquisition");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await first).toBe(false);
      f.ack();
      expect(f.supervisor.isQuiesced()).toBe(true);
      expect(await f.supervisor.prepare("same-acquisition")).toBe(true);
      expect(f.requests).toHaveLength(1);
      expect(await f.supervisor.prepare("successor-acquisition")).toBe(false);
    } finally {
      f.supervisor.close();
    }
  });
  it("reuses the supervisor correlation id after a lost acknowledgment and joins retries", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const first = f.supervisor.prepare("same-acquisition");
      expect(f.supervisor.prepare("same-acquisition")).toBe(first);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await first).toBe(false);
      const second = f.supervisor.prepare("same-acquisition");
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]).toEqual(f.requests[0]);
      f.ack();
      expect(await second).toBe(true);
      expect(await f.supervisor.prepare("same-acquisition")).toBe(true);
    } finally {
      f.supervisor.close();
    }
  });
});
