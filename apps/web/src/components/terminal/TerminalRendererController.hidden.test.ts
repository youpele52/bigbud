import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HIDDEN_WEBGL_RELEASE_DELAY_MS,
  TerminalRendererController,
} from "./TerminalRendererController";
import { TerminalRendererBudget } from "./TerminalRendererController.policy";

const allowed = { allowed: true, reason: null, webglFeatureStatus: "enabled" };
const controllers: TerminalRendererController[] = [];
function fixture(budget = new TerminalRendererBudget()) {
  const addons: Array<{ activate: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> =
    [];
  const create = vi.fn(() => {
    const addon = {
      activate: vi.fn(),
      dispose: vi.fn(),
      onContextLoss: () => ({ dispose: vi.fn() }),
    };
    addons.push(addon);
    return addon;
  });
  const load = vi.fn(async () => create);
  const terminal = { rows: 20, loadAddon: vi.fn(), refresh: vi.fn() };
  const state = vi.fn();
  const controller = new TerminalRendererController(terminal, state, load, budget);
  controllers.push(controller);
  return { controller, addons, create, load, terminal, state, budget };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it.each(["auto", "on"] as const)(
  "%s releases an idle hidden addon once and restores a fresh addon synchronously on show",
  async (setting) => {
    const f = fixture();
    f.controller.update(setting, true, allowed);
    await Promise.resolve();
    f.controller.update(setting, false, null);
    vi.advanceTimersByTime(HIDDEN_WEBGL_RELEASE_DELAY_MS - 1);
    // Observer churn must not extend the original hidden deadline.
    f.controller.update(setting, false, null);
    expect(f.addons[0]!.dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.addons[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.budget.count).toBe(0);
    expect(f.budget.retainedCount).toBe(0);
    expect(f.state).toHaveBeenLastCalledWith({
      mode: "dom",
      reason: "Hidden GPU resources released after inactivity; terminal uses DOM.",
    });
    expect(f.terminal.refresh).toHaveBeenCalledWith(0, 19);
    vi.advanceTimersByTime(HIDDEN_WEBGL_RELEASE_DELAY_MS);
    expect(f.addons[0]!.dispose).toHaveBeenCalledOnce();
    f.controller.retry();
    expect(f.create).toHaveBeenCalledOnce(); // Hidden retry cannot allocate.
    f.controller.update(setting, true, allowed);
    // No await: constructor reuse attaches before the next paint, without reusing disposed addons.
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.terminal.loadAddon).toHaveBeenLastCalledWith(f.addons[1]);
    expect(f.state).toHaveBeenLastCalledWith({ mode: "webgl", reason: null });
    expect(f.budget.count).toBe(1);
  },
);

it("cancels on reveal and starts a new deadline on the next hide", async () => {
  const f = fixture();
  f.controller.update("on", true, allowed);
  await Promise.resolve();
  f.controller.update("on", false, null);
  vi.advanceTimersByTime(20_000);
  f.controller.update("on", true, allowed);
  expect(vi.getTimerCount()).toBe(0);
  f.controller.update("on", false, null);
  vi.advanceTimersByTime(10_000);
  expect(f.addons[0]!.dispose).not.toHaveBeenCalled();
  vi.advanceTimersByTime(20_000);
  expect(f.addons[0]!.dispose).toHaveBeenCalledOnce();
  expect(f.budget.retainedCount).toBe(0);
});

it.each(["off", "dispose", "evict"] as const)(
  "%s cancels a parked addon's timer without a later state callback or double disposal",
  async (action) => {
    const f = fixture();
    f.controller.update("on", true, allowed);
    await Promise.resolve();
    f.controller.update("on", false, null);
    if (action === "off") f.controller.update("off", false, null);
    if (action === "dispose") f.controller.dispose();
    if (action === "evict") {
      const releases = Array.from({ length: 6 }, () => f.budget.retain(() => undefined));
      releases.forEach((release) => release());
    }
    expect(vi.getTimerCount()).toBe(0);
    const callbacks = f.state.mock.calls.length;
    vi.advanceTimersByTime(HIDDEN_WEBGL_RELEASE_DELAY_MS);
    expect(f.addons[0]!.dispose).toHaveBeenCalledOnce();
    expect(f.state).toHaveBeenCalledTimes(callbacks);
    expect(f.budget.retainedCount).toBe(0);
    if (action === "dispose") {
      f.controller.update("on", false, allowed);
      f.controller.update("on", true, allowed);
      expect(f.create).toHaveBeenCalledOnce();
    }
  },
);

it("leaves DOM available while reveal policy is pending or revoked", async () => {
  const f = fixture();
  f.controller.update("on", true, allowed);
  await Promise.resolve();
  f.controller.update("on", false, null);
  vi.advanceTimersByTime(HIDDEN_WEBGL_RELEASE_DELAY_MS);
  f.controller.update("on", true, null);
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.state).toHaveBeenLastCalledWith({
    mode: "dom",
    reason: "Awaiting application rendering policy.",
  });
  f.controller.update("on", true, { ...allowed, allowed: false, reason: "GPU disabled" });
  f.controller.retry();
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.state).toHaveBeenLastCalledWith({ mode: "dom", reason: "GPU disabled" });
  f.controller.update("on", true, allowed);
  expect(f.create).toHaveBeenCalledTimes(2);
});

it("restoration failure releases its reservation and preserves the DOM fallback", async () => {
  const f = fixture();
  f.controller.update("on", true, allowed);
  await Promise.resolve();
  f.controller.update("on", false, null);
  vi.advanceTimersByTime(HIDDEN_WEBGL_RELEASE_DELAY_MS);
  f.terminal.loadAddon.mockImplementationOnce(() => {
    throw new Error("GPU unavailable");
  });
  f.controller.update("on", true, allowed);
  expect(f.addons[1]!.dispose).toHaveBeenCalledOnce();
  expect(f.budget.count).toBe(0);
  expect(f.state).toHaveBeenLastCalledWith({
    mode: "dom",
    reason: "WebGL attachment failed; terminal preserved in DOM.",
  });
});

it("abandons a pending import on hide without arming an idle timer", async () => {
  const f = fixture();
  let resolve!: (create: typeof f.create) => void;
  const controller = new TerminalRendererController(
    f.terminal,
    f.state,
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    f.budget,
  );
  controllers.push(controller);
  controller.update("on", true, allowed);
  controller.update("on", false, null);
  resolve(f.create);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.budget.count).toBe(0);
});
