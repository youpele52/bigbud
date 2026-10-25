import { describe, expect, it, vi } from "vitest";
import { TerminalRendererController, type TerminalWebglAddon } from "./TerminalRendererController";
import {
  RETAINED_HIDDEN_WEBGL_CONTEXTS,
  TerminalRendererBudget,
  VISIBLE_WEBGL_CONTEXTS,
} from "./TerminalRendererController.policy";

const allowed = { allowed: true, reason: null, webglFeatureStatus: "enabled" };
function fixture(budget = new TerminalRendererBudget()) {
  let lost: (() => void) | undefined;
  let clock = 0;
  const addon = {
    activate: vi.fn(),
    dispose: vi.fn(),
    onContextLoss: vi.fn((listener: () => void) => {
      lost = listener;
      return { dispose: vi.fn() };
    }),
  };
  const terminal = { loadAddon: vi.fn(), refresh: vi.fn(), rows: 20 };
  const load = vi.fn(async () => () => addon);
  const state = vi.fn();
  const controller = new TerminalRendererController(terminal, state, load, budget, () => clock);
  return {
    controller,
    terminal,
    load,
    addon,
    state,
    budget,
    lose: () => lost?.(),
    advance: () => {
      clock += 6000;
    },
  };
}
it("Off never imports or constructs an addon, including deliberate retry", async () => {
  const f = fixture();
  f.controller.update("off", true, allowed);
  f.controller.retry();
  await Promise.resolve();
  expect(f.load).not.toHaveBeenCalled();
  f.controller.dispose();
});

describe.each(["auto", "on"] as const)("TerminalRendererController %s", (setting) => {
  it("attempts WebGL when visible and application policy allows", async () => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.terminal.loadAddon).toHaveBeenCalledWith(f.addon);
    expect(f.state).toHaveBeenLastCalledWith({ mode: "webgl", reason: null });
    f.controller.dispose();
    expect(f.budget.count).toBe(0);
  });
  it("respects unknown and disabled application policy even on deliberate retry", () => {
    const f = fixture();
    f.controller.update(setting, true, null);
    f.controller.retry();
    expect(f.state).toHaveBeenLastCalledWith({
      mode: "dom",
      reason: "Awaiting application rendering policy.",
    });
    f.controller.update(setting, true, { ...allowed, allowed: false, reason: "disabled" });
    f.controller.retry();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.state).toHaveBeenLastCalledWith({ mode: "dom", reason: "disabled" });
    f.controller.dispose();
  });
  it("releases an attached context when application policy is revoked", async () => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    f.controller.update(setting, true, { ...allowed, allowed: false, reason: "GPU disabled" });
    f.controller.retry();
    expect(f.addon.dispose).toHaveBeenCalledOnce();
    expect(f.terminal.refresh).toHaveBeenCalledOnce();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.budget.count).toBe(0);
    expect(f.state).toHaveBeenLastCalledWith({ mode: "dom", reason: "GPU disabled" });
    f.controller.dispose();
  });
  it("never allocates while hidden, and explicit Off releases the active context", async () => {
    const f = fixture();
    f.controller.update(setting, false, allowed);
    f.controller.retry();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.budget.count).toBe(0);
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    f.controller.update("off", true, allowed);
    f.controller.retry();
    expect(f.addon.dispose).toHaveBeenCalledOnce();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.budget.count).toBe(0);
    expect(f.state).toHaveBeenLastCalledWith({ mode: "dom", reason: null });
    f.controller.dispose();
  });
  it("loss disposes GPU only, refreshes the same terminal and ignores stale listeners", async () => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    expect(f.terminal.loadAddon).toHaveBeenCalledWith(f.addon);
    f.lose();
    f.lose();
    expect(f.addon.dispose).toHaveBeenCalledOnce();
    expect(f.terminal.refresh).toHaveBeenCalledOnce();
    expect(f.budget.count).toBe(0);
    expect(f.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "dom" }));
    f.controller.update(setting, true, allowed);
    expect(f.load).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it("late async import after dispose cannot attach or leak its reservation", async () => {
    const f = fixture();
    let resolve!: (createAddon: () => TerminalWebglAddon) => void;
    const controller = new TerminalRendererController(
      f.terminal,
      f.state,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      f.budget,
    );
    controller.update(setting, true, allowed);
    expect(f.budget.count).toBe(1);
    controller.dispose();
    const construct = vi.fn(() => f.addon);
    resolve(construct);
    await Promise.resolve();
    expect(f.terminal.loadAddon).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(f.budget.count).toBe(0);
  });
  it("attach failure falls back, and deliberate retry permits one attempt", async () => {
    const f = fixture();
    f.terminal.loadAddon.mockImplementation(() => {
      throw new Error("GPU unavailable");
    });
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    expect(f.budget.count).toBe(0);
    expect(f.addon.dispose).toHaveBeenCalledOnce();
    f.controller.retry();
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });
  it("never retains a lost context and latches after three losses without automatic timer retry", async () => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    for (let i = 0; i < 3; i++) {
      f.lose();
      f.advance();
      f.controller.update(setting, false, allowed);
      f.controller.update(setting, true, allowed);
      await Promise.resolve();
    }
    expect(f.load).toHaveBeenCalledTimes(3);
    expect(f.budget.isLatched).toBe(true);
    expect(f.budget.count).toBe(0);
    f.controller.retry();
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(4);
    f.controller.update(setting, false, allowed);
    expect(f.budget.count).toBe(0);
    f.controller.dispose();
  });
  it("limits visible allocations to eight and coalesces simultaneous loss incidents", async () => {
    const budget = new TerminalRendererBudget();
    const panes = Array.from({ length: 9 }, () => fixture(budget));
    panes.forEach((f) => f.controller.update(setting, true, allowed));
    await Promise.resolve();
    expect(budget.count).toBe(8);
    expect(panes[8]!.load).not.toHaveBeenCalled();
    panes.forEach((f) => f.lose());
    expect(budget.isLatched).toBe(false);
    panes.forEach((f) => f.controller.dispose());
    expect(budget.count).toBe(0);
  });
  it("keeps a hidden context attached and resumes it without reloading", async () => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    f.controller.update(setting, false, null);
    expect(f.addon.dispose).not.toHaveBeenCalled();
    expect(f.budget.count).toBe(0);
    expect(f.budget.retainedCount).toBe(1);
    f.controller.update(setting, true, allowed);
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.budget.count).toBe(1);
    expect(f.budget.retainedCount).toBe(0);
    expect(f.state).toHaveBeenLastCalledWith({ mode: "webgl", reason: null });
    f.controller.dispose();
    expect(f.budget.count).toBe(0);
  });
  it("evicts the least recently hidden context beyond the retention cap", async () => {
    const budget = new TerminalRendererBudget();
    const panes = Array.from({ length: RETAINED_HIDDEN_WEBGL_CONTEXTS + 1 }, () => fixture(budget));
    for (const f of panes) {
      f.controller.update(setting, true, allowed);
      await Promise.resolve();
      f.controller.update(setting, false, null);
    }
    expect(budget.retainedCount).toBe(RETAINED_HIDDEN_WEBGL_CONTEXTS);
    expect(panes[0]!.addon.dispose).toHaveBeenCalledOnce();
    expect(panes[0]!.state).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "dom" }));
    expect(panes[1]!.addon.dispose).not.toHaveBeenCalled();
    // The evicted view reattaches on show; it was not a failure, so no cooldown applies.
    panes[0]!.controller.update(setting, true, allowed);
    await Promise.resolve();
    expect(panes[0]!.load).toHaveBeenCalledTimes(2);
    panes.forEach((f) => f.controller.dispose());
    expect(budget.count).toBe(0);
    expect(budget.retainedCount).toBe(0);
  });
  it("falls back when a retained context returns to a full visible budget", async () => {
    const budget = new TerminalRendererBudget();
    const hidden = fixture(budget);
    hidden.controller.update(setting, true, allowed);
    await Promise.resolve();
    hidden.controller.update(setting, false, null);
    const visible = Array.from({ length: VISIBLE_WEBGL_CONTEXTS }, () => fixture(budget));
    visible.forEach((f) => f.controller.update(setting, true, allowed));
    await Promise.resolve();
    hidden.controller.update(setting, true, allowed);
    expect(hidden.addon.dispose).toHaveBeenCalledOnce();
    expect(hidden.state).toHaveBeenLastCalledWith({
      mode: "dom",
      reason: "Visible GPU context budget exhausted.",
    });
    expect(budget.retainedCount).toBe(0);
    [hidden, ...visible].forEach((f) => f.controller.dispose());
    expect(budget.count).toBe(0);
  });
  it("Off releases a retained hidden context", async () => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    f.controller.update(setting, false, null);
    f.controller.update("off", false, null);
    expect(f.addon.dispose).toHaveBeenCalledOnce();
    expect(f.budget.retainedCount).toBe(0);
    f.controller.dispose();
  });
  it("reattaches a visible context for glyph shaping changes and drops a hidden one", async () => {
    const f = fixture();
    f.controller.reattach();
    expect(f.load).not.toHaveBeenCalled();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    f.controller.reattach();
    await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.addon.dispose).toHaveBeenCalledOnce();
    expect(f.state).toHaveBeenLastCalledWith({ mode: "webgl", reason: null });
    expect(f.budget.count).toBe(1);
    f.controller.update(setting, false, null);
    f.controller.reattach();
    expect(f.addon.dispose).toHaveBeenCalledTimes(2);
    expect(f.budget.retainedCount).toBe(0);
    f.controller.dispose();
  });
});
