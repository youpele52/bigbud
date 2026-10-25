import { describe, expect, it } from "vitest";

import {
  beginThreadToolDispatch,
  enterThreadToolInvocation,
  isThreadToolInvocationInFlight,
} from "./threadToolInvocationFlights.ts";

let sequence = 0;
const nextId = () => `flight-test:${++sequence}`;

describe("threadToolInvocationFlights", () => {
  it("is in flight from dispatch until both the caller and the route handler have ended", () => {
    const id = nextId();
    const settle = beginThreadToolDispatch(id);
    expect(isThreadToolInvocationInFlight(id)).toBe(true);
    const leave = enterThreadToolInvocation(id);
    expect(leave).toBeDefined();
    // The caller gave up (for example its request timeout) while the handler still runs.
    settle();
    expect(isThreadToolInvocationInFlight(id)).toBe(true);
    leave?.();
    expect(isThreadToolInvocationInFlight(id)).toBe(false);
    // A started invocation is never fenced, so a later identical arrival is not refused.
    const again = enterThreadToolInvocation(id);
    expect(again).toBeDefined();
    again?.();
  });

  it("fences a dispatch abandoned before the route entered it, exactly once", () => {
    const id = nextId();
    beginThreadToolDispatch(id)();
    expect(isThreadToolInvocationInFlight(id)).toBe(false);
    expect(enterThreadToolInvocation(id)).toBeUndefined();
    const later = enterThreadToolInvocation(id);
    expect(later).toBeDefined();
    later?.();
  });

  it("tracks route handlers without a registered caller and counts concurrent ones", () => {
    const id = nextId();
    const first = enterThreadToolInvocation(id);
    const second = enterThreadToolInvocation(id);
    first?.();
    first?.(); // Idempotent: one handler leaves once.
    expect(isThreadToolInvocationInFlight(id)).toBe(true);
    second?.();
    expect(isThreadToolInvocationInFlight(id)).toBe(false);
  });

  it("keeps fences bounded by count", () => {
    const first = nextId();
    beginThreadToolDispatch(first)();
    for (let index = 0; index < 1024; index++) beginThreadToolDispatch(nextId())();
    const evicted = enterThreadToolInvocation(first);
    expect(evicted).toBeDefined();
    evicted?.();
  });
});
