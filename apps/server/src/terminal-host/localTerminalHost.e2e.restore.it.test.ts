/**
 * Q1 end-to-end with the real binary (`BIGBUD_TERMINAL_HOST_IT=1`): switching threads and coming
 * back restores the terminal from a host screen with identical text, and a backend restart with
 * a live agent-like TUI (alternate screen, steady redraws) reattaches the same PID with a screen.
 */
import { afterEach, describe, expect, it } from "vitest";

import { captureScreen, screenText } from "../terminal/Layers/TerminalScreenFidelity.harness.ts";
import {
  hostE2eEnabled,
  hostProcesses,
  makeHostE2eWorld,
  paneKey,
  runEffect,
  sleep,
  until,
  watchPane,
  type HostE2eWorld,
} from "./localTerminalHost.e2e.testUtils.ts";

const worlds: HostE2eWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});
const world = async () => {
  const created = await makeHostE2eWorld();
  worlds.push(created);
  return created;
};

const GEOMETRY = { cols: 100, rows: 30 };
/** An agent-like TUI: alternate screen, cursor hidden, a full redraw every 100 ms. */
const TUI =
  "printf '\\033[?1049h\\033[?25l'; i=0; while :; do i=$((i+1)); " +
  "printf '\\033[H\\033[2J\\033[1;36m agent \\033[0m frame %d\\n> waiting for input' \"$i\"; " +
  "sleep 0.1; done\r";

describe.skipIf(!hostE2eEnabled)("Q1 restore flows with the real binary", () => {
  it("switching threads and coming back restores identical text from a screen", async () => {
    const w = await world();
    const backend = await w.backend();
    const pane = { threadId: "thread-a", terminalId: "default", cwd: w.cwd, ...GEOMETRY };
    const opened = await runEffect(backend.manager.open(pane));
    expect(opened).toMatchObject({ status: "running", screenSource: "host", restorable: true });
    backend.views.update("renderer", { threadId: "thread-a", terminalIds: ["default"] });
    const first = await watchPane(backend, "thread-a", "default");
    await runEffect(
      backend.manager.write({ ...pane, data: "for i in 1 2 3 4 5; do echo line-$i; done\r" }),
    );
    await until(
      () => (backend.output.get(paneKey("thread-a", "default")) ?? "").includes("line-5"),
      "output",
    );

    // Switch to thread B: thread A's view goes away; thread B opens its own terminal.
    first.stop();
    backend.views.update("renderer", { threadId: "thread-b", terminalIds: ["default"] });
    await runEffect(backend.manager.open({ ...pane, threadId: "thread-b" }));
    // Thread A keeps running while hidden.
    await runEffect(backend.manager.write({ ...pane, data: "echo while-hidden\r" }));
    await until(
      () => (backend.output.get(paneKey("thread-a", "default")) ?? "").includes("while-hidden\r\n"),
      "hidden output",
    );
    await sleep(200);

    // Come back: the view reopens attach-only and gets a screen item first.
    backend.views.update("renderer", { threadId: "thread-a", terminalIds: ["default"] });
    const reopened = await runEffect(backend.manager.open({ ...pane, attachOnly: true }));
    expect(reopened.pid).toBe(opened.pid);
    const back = await watchPane(backend, "thread-a", "default");
    await until(() => back.screens.length > 0, "the screen item");
    const restored = await captureScreen(back.screens[0]!.ansi, GEOMETRY);
    const reference = await captureScreen(
      backend.output.get(paneKey("thread-a", "default")) ?? "",
      GEOMETRY,
    );
    expect(screenText(restored.visible)).toEqual(screenText(reference.visible));
    expect(screenText(restored.visible).join("\n")).toContain("while-hidden");
    back.stop();
    await backend.close();
  }, 60_000);

  it("a backend restart with a live TUI reattaches the same PID with its screen", async () => {
    const w = await world();
    const first = await w.backend();
    const pane = { threadId: "thread-1", terminalId: "agent", cwd: w.cwd, ...GEOMETRY };
    const opened = await runEffect(first.manager.open(pane));
    await runEffect(first.manager.write({ ...pane, data: TUI }));
    await until(
      () => (first.output.get(paneKey("thread-1", "agent")) ?? "").includes("frame 5"),
      "TUI frames",
    );
    // Let the debounced history write land, so the next backend knows to reattach.
    await sleep(600);
    await first.close();
    expect(hostProcesses.isAlive(opened.pid!)).toBe(true);

    const second = await w.backend();
    const view = await watchPane(second, "thread-1", "agent");
    const reopened = await runEffect(second.manager.open({ ...pane, attachOnly: true }));
    expect(reopened.pid).toBe(opened.pid);
    await until(() => view.screens.length > 0, "the screen item");
    const screen = await captureScreen(view.screens[0]!.ansi, GEOMETRY);
    expect(screen.alternateScreen).toBe(true);
    expect(screenText(screen.visible)[0]).toMatch(/agent {2}frame \d+/);
    // Live redraws continue after the screen.
    await until(() => view.output.join("").includes("frame"), "frames after reattach");
    view.stop();
    await runEffect(second.manager.close({ threadId: "thread-1", terminalId: "agent" }));
    await until(() => !hostProcesses.isAlive(opened.pid!), "the TUI shell to exit", 5_000);
    await second.close();
  }, 60_000);
});
