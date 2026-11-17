import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vitest";
import { makeManagedServiceTeardown } from "./bin.serviceTeardown.ts";

describe("managed service teardown", () => {
  it("returns success for a requested signal after interrupt-only cleanup", () => {
    const cleanup = vi.fn();
    const onExit = vi.fn();
    makeManagedServiceTeardown(() => true, cleanup)(Exit.interrupt(1), onExit);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("keeps unexpected interrupt-only exits nonzero", () => {
    const onExit = vi.fn();
    makeManagedServiceTeardown(
      () => false,
      () => {},
    )(Exit.interrupt(1), onExit);
    expect(onExit).toHaveBeenCalledWith(130);
  });

  it("keeps failures nonzero even when a stop signal was received", () => {
    const onExit = vi.fn();
    makeManagedServiceTeardown(
      () => true,
      () => {},
    )(Exit.fail("cleanup failed"), onExit);
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("keeps mixed interruption and failure nonzero", () => {
    const onExit = vi.fn();
    makeManagedServiceTeardown(
      () => true,
      () => {},
    )(Exit.failCause(Cause.combine(Cause.interrupt(1), Cause.die("cleanup failed"))), onExit);
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
