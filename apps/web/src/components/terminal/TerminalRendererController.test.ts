import { describe, expect, it, vi } from "vitest";
import { TerminalRendererController, type TerminalWebglAddon } from "./TerminalRendererController";
import { TerminalRendererBudget } from "./TerminalRendererController.policy";

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
  it("retains zero hidden contexts and latches after three losses without automatic timer retry", async () => {
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
});
