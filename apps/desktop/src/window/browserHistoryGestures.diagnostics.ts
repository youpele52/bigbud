import { createHash } from "node:crypto";
import { release } from "node:os";
import { join } from "node:path";
import { app, type BrowserWindow, type WebContents } from "electron";
import { RotatingFileSink } from "@bigbud/shared/logging";
import { QueuedLogSink, resolveDesktopLogDir } from "../logging/logging";

const CAPTURE_MS = 120_000;
const MAX_RECORDS = 1200;
let sink: QueuedLogSink | undefined;
let remaining = MAX_RECORDS;
let deadline = 0;

/** Opt-in, process-bounded capture; never records URLs, page content or key values. */
export function createBrowserGestureDiagnostics(
  owner: BrowserWindow,
  contents: WebContents,
  source: string,
): ((event: string, details?: unknown) => void) | undefined {
  if (process.env.BIGBUD_BROWSER_GESTURE_DIAGNOSTICS !== "1") return;
  try {
    if (!sink) {
      sink = new QueuedLogSink(
        new RotatingFileSink({
          filePath: join(resolveDesktopLogDir(app.getPath("userData")), "browser-gestures.jsonl"),
          maxBytes: 512 * 1024,
          maxFiles: 1,
        }),
      );
      deadline = performance.now() + CAPTURE_MS;
      sink.write(
        `${JSON.stringify({
          event: "runtime",
          time: new Date().toISOString(),
          pid: process.pid,
          processStarted: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          version: app.getVersion(),
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          macOS: release(),
          appPath: app.getAppPath(),
          executable: process.execPath,
          sourceHash: createHash("sha256").update(source).digest("hex").slice(0, 16),
          captureMs: CAPTURE_MS,
          maxRecords: MAX_RECORDS,
        })}\n`,
      );
    }
  } catch {
    console.warn("[browser-gestures] diagnostic log could not be opened");
    return;
  }
  if (performance.now() >= deadline || remaining <= 0) return;
  const record = (event: string, details?: unknown): void => {
    if (performance.now() >= deadline || remaining <= 0) return;
    remaining -= 1;
    sink?.write(
      `${JSON.stringify({
        time: performance.now(),
        guest: contents.id,
        event,
        details,
      })}\n`,
    );
  };
  record("bind", { owner: owner.id, ownerFocused: owner.isFocused() });
  const hostInput = (_event: unknown, input: Electron.InputEvent): void => {
    if (input.type === "mouseWheel" || input.type.startsWith("gesture"))
      record("host-input", { type: input.type });
  };
  owner.webContents.on("input-event", hostInput);
  let busy = false;
  const timer = setInterval(() => {
    if (performance.now() >= deadline || remaining <= 0 || contents.isDestroyed()) {
      cleanup();
      return;
    }
    if (busy) return;
    busy = true;
    void contents
      .executeJavaScriptInIsolatedWorld(1004, [
        {
          code: "globalThis.__bigbudHistoryGestures?.drainDiagnostics() ?? []",
        },
      ])
      .then((entries: unknown) => {
        if (Array.isArray(entries)) for (const entry of entries) record("page", entry);
      })
      .catch(() => {
        record("drain-failed");
      })
      .finally(() => {
        busy = false;
      });
  }, 200);
  timer.unref();
  function cleanup(): void {
    clearInterval(timer);
    if (!owner.webContents.isDestroyed())
      owner.webContents.removeListener("input-event", hostInput);
    contents.removeListener("destroyed", cleanup);
  }
  contents.once("destroyed", cleanup);
  return record;
}
