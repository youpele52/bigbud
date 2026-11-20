import { describe, expect, it, vi } from "vitest";
import { makeQualificationInputBarrier } from "./ZshSuggestions.barrier";

function fixture() {
  const write = vi.fn<(data: string) => void>();
  const barrier = makeQualificationInputBarrier({
    session: "session",
    lease: "lease",
    sequence: 7,
    write,
  });
  return { barrier, write };
}
const ack = "v1 session lease 7 suspended 12\n";

describe("qualification-only matched-ACK input barrier (NOT G1/G2 or D_safe)", () => {
  it("holds all ordered bytes past timeout; stale identities cannot release any accepting key", () => {
    const { barrier, write } = fixture();
    for (const bytes of ["typed", "\t", "\u001b[C", "\r"]) barrier.enqueue(bytes);
    barrier.timeout();
    expect(barrier.state).toBe("blocked");
    for (const stale of [
      ack.replace("session", "old-session"),
      ack.replace("lease", "old-lease"),
      ack.replace(" 7 ", " 6 "),
      ack.replace("suspended", "ready"),
    ])
      barrier.status(stale);
    expect(write).not.toHaveBeenCalled();
    barrier.status(ack.slice(0, 13));
    expect(write).not.toHaveBeenCalled();
    barrier.status(ack.slice(13));
    expect(write.mock.calls.map(([data]) => data)).toEqual(["typed", "\t", "\u001b[C", "\r"]);
    barrier.status(ack);
    expect(write).toHaveBeenCalledTimes(4);
    barrier.enqueue("later");
    expect(write).toHaveBeenLastCalledWith("later");
  });

  it("does not let empty input events evade the bounded queue or produce writes", () => {
    const { barrier, write } = fixture();
    for (let index = 0; index < 10000; index++) barrier.enqueue("");
    barrier.enqueue("\t");
    barrier.status(ack);
    expect(write).toHaveBeenCalledExactlyOnceWith("\t");
    barrier.enqueue("");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves FIFO when a write synchronously queues more input during matched-ACK drain", () => {
    const { barrier, write } = fixture();
    barrier.enqueue("first");
    barrier.enqueue("second");
    write.mockImplementationOnce(() => {
      barrier.enqueue("third");
      barrier.status(ack);
    });
    barrier.status(ack);
    expect(write.mock.calls.map(([data]) => data)).toEqual(["first", "second", "third"]);
    expect(barrier.state).toBe("released");
  });

  it("never retries a partially drained input queue after an unknown write outcome", () => {
    const { barrier, write } = fixture();
    barrier.enqueue("first");
    barrier.enqueue("second");
    barrier.enqueue("third");
    write
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("unknown delivery");
      });
    expect(() => barrier.status(ack)).toThrow("unknown delivery");
    expect(barrier.state).toBe("failed");
    barrier.status(ack);
    expect(write.mock.calls.map(([data]) => data)).toEqual(["first", "second"]);
    expect(() => barrier.enqueue("retry")).toThrow("retry is forbidden");
  });

  it.each(["status", "input"])(
    "fails visibly closed when bounded %s capacity is exhausted",
    (lane) => {
      const { barrier, write } = fixture();
      barrier.enqueue("\t");
      if (lane === "status") barrier.status("x".repeat(513));
      else expect(() => barrier.enqueue("λ".repeat(2048))).toThrow("capacity exceeded");
      barrier.status(ack);
      expect(barrier.state).toBe("failed");
      expect(write).not.toHaveBeenCalled();
    },
  );
});
