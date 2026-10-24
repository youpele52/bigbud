import type { BrowserWindow, WebContents } from "electron";
import { createHistorySwipeRecognizer } from "./browserHistoryGestures.logic";
import { installBrowserHistoryGestures } from "./browserHistoryGestures.page";
import { createBrowserGestureDiagnostics } from "./browserHistoryGestures.diagnostics";

const GESTURE_WORLD_ID = 1004;
const QUIET_PERIOD_MS = 250;
const HISTORY_COOLDOWN_MS = 1200;

/** Arms private DOM recognition only for native macOS browser touch-scroll phases. */
export function bindBrowserHistoryGestures(
  owner: BrowserWindow,
  contents: WebContents,
  platform: NodeJS.Platform = process.platform,
  clock: () => number = () => performance.now(),
): void {
  if (platform !== "darwin") return;
  const diagnostic = createBrowserGestureDiagnostics(
    owner,
    contents,
    bindBrowserHistoryGestures.toString() +
      installBrowserHistoryGestures.toString() +
      createHistorySwipeRecognizer.toString(),
  );
  let ready = false;
  let touching = false;
  let pinching = false;
  let lastWheel = -Infinity;
  let eligible = false;
  let cooldownUntil = 0;
  let generation = 0;
  // Wheel input is already routed to this guest; toolbar keyboard focus is irrelevant.
  const isOwnerActive = () => !owner.isDestroyed() && owner.isFocused();
  const execute = (code: string): Promise<unknown> =>
    contents.executeJavaScriptInIsolatedWorld(GESTURE_WORLD_ID, [{ code }]);
  const command = (method: "begin" | "end" | "cancel"): void => {
    diagnostic?.("command", { method, ready, generation });
    if (!ready || contents.isDestroyed()) return;
    const previousCooldown = cooldownUntil;
    const deadline = clock() + HISTORY_COOLDOWN_MS;
    if (method === "end") cooldownUntil = Math.max(cooldownUntil, deadline);
    void execute(
      `globalThis.__bigbudHistoryGestures?.generation === ${generation} ? (globalThis.__bigbudHistoryGestures?.${method}() ?? null) : null`,
    )
      .then((direction) => {
        diagnostic?.("command-result", { method, direction });
        if (method === "end" && direction === null && cooldownUntil === deadline) {
          cooldownUntil = Math.max(
            previousCooldown,
            deadline - HISTORY_COOLDOWN_MS + QUIET_PERIOD_MS,
          );
        }
      })
      .catch((error: unknown) => {
        diagnostic?.("command-failed", {
          method,
          error: error instanceof Error ? error.name : "unknown",
        });
        // Keep the conservative lock when navigation invalidates the result.
      });
  };
  contents.on("dom-ready", () => {
    const current = ++generation;
    ready = false;
    touching = false;
    eligible = false;
    diagnostic?.("install-start", { generation: current });
    void execute(
      `(${installBrowserHistoryGestures.toString()})(${createHistorySwipeRecognizer.toString()}, ${current}, ${Boolean(diagnostic)});void 0`,
    )
      .then(() => {
        if (generation === current && !contents.isDestroyed()) ready = true;
        diagnostic?.("install-result", { generation: current, ready });
      })
      .catch((error: unknown) => {
        diagnostic?.("install-failed", {
          generation: current,
          error: error instanceof Error ? error.name : "unknown",
        });
        /* Fail closed when a document cannot install the isolated listener. */
      });
  });
  contents.on("input-event", (_event, input) => {
    if (input.type === "mouseWheel" || input.type.startsWith("gesture")) {
      diagnostic?.("guest-input", {
        type: input.type,
        ready,
        touching,
        pinching,
        eligible,
        ownerActive: isOwnerActive(),
        cooldownRemaining: Math.max(0, cooldownUntil - clock()),
        wheelGap: Number.isFinite(lastWheel) ? clock() - lastWheel : null,
      });
    }
    if (input.type === "mouseWheel") {
      const now = clock();
      if (now - lastWheel >= QUIET_PERIOD_MS) eligible = now >= cooldownUntil;
      lastWheel = now;
    } else if (input.type === "gestureScrollBegin") {
      // Electron omits Chromium's inertial_phase. A new scroll phase alone is
      // not proof of new finger contact: momentum can generate one as well.
      if (!touching && eligible && clock() >= cooldownUntil && !pinching && isOwnerActive()) {
        touching = true;
        command("begin");
      }
      eligible = false;
    } else if (input.type === "gestureScrollEnd" || input.type === "gestureFlingStart") {
      if (touching) command(isOwnerActive() ? "end" : "cancel");
      touching = false;
      eligible = false;
    } else if (input.type === "gestureFlingCancel") {
      touching = false;
      eligible = false;
      command("cancel");
    } else if (input.type === "gesturePinchBegin") {
      pinching = true;
      command("cancel");
    } else if (input.type === "gesturePinchEnd") {
      pinching = false;
    } else if (
      input.type === "mouseDown" ||
      input.type === "rawKeyDown" ||
      input.type === "keyDown"
    ) {
      command("cancel");
    }
  });
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (!mainFrame || inPlace) return;
    // The page commits mid-phase; its momentum continues into the next document.
    if (touching) cooldownUntil = Math.max(cooldownUntil, clock() + HISTORY_COOLDOWN_MS);
    generation += 1;
    ready = false;
    touching = false;
    eligible = false;
  });
  contents.on("render-process-gone", () => {
    generation += 1;
    ready = touching = eligible = pinching = false;
  });
}
