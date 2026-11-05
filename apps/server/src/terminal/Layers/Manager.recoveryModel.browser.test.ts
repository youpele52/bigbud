import { createRequire } from "node:module";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { makeTerminalManagerWithOptions } from "./Manager";
import * as NodePTY from "./NodePTY";
import { PtyAdapter } from "../Services/PTY";
import { TerminalRecoveryModel } from "./TerminalRecoveryModel";
import { waitFor } from "./Manager.test.helpers";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

type BrowserTerminal = HeadlessTerminal & { open(element: unknown): void };
type BrowserRealm = {
  document: { getElementById(id: string): unknown };
  Terminal: new (options: object) => BrowserTerminal;
  terminal: BrowserTerminal;
};
const require = createRequire(import.meta.url);

it.skipIf(process.platform === "win32")(
  "real manager PTY survives history exhaustion and feeds a fresh browser from its shadow frame",
  async () => {
    vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "1");
    const writes = vi.spyOn(TerminalRecoveryModel.prototype, "write");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent("<!doctype html><div id='terminal'></div>");
      await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-shadow-pty-" });
            const shell = path.join(dir, "fixture");
            yield* fs.writeFileString(
              shell,
              `#!${process.execPath}\nprocess.stdin.setRawMode(true);\nlet n=0;const timer=setInterval(()=>{process.stdout.write('x'.repeat(4096)+'\\r\\n');if(++n===300){clearInterval(timer);process.stdout.write('\\x1b[2J\\x1b[HRECOVERY-FINAL');}},3);process.stdin.on('data',d=>process.stdout.write('\\r\\nINPUT:'+d));\n`,
            );
            yield* fs.chmod(shell, 0o755);
            const adapter = yield* PtyAdapter;
            const spawn = vi.fn(adapter.spawn);
            const manager = yield* makeTerminalManagerWithOptions({
              logsDir: dir,
              ptyAdapter: { spawn },
              shellResolver: () => shell,
              agentDetector: () => Effect.succeed(new Map()),
              subprocessChecker: () => Effect.succeed(false),
            });
            const input = {
              threadId: "shadow",
              terminalId: "default",
              cwd: dir,
              cols: 80,
              rows: 24,
            };
            const opened = yield* manager.open(input);
            yield* Effect.promise(() =>
              expect
                .poll(() => writes.mock.calls.some(([data]) => data.includes("RECOVERY-FINAL")), {
                  timeout: 10_000,
                })
                .toBe(true),
            );
            const model = writes.mock.contexts[0]!;
            if (!(model instanceof TerminalRecoveryModel)) throw new Error("Missing live model");
            const captured = yield* Effect.promise(() => model.capture());
            expect(captured.type).toBe("candidate");
            if (captured.type !== "candidate") throw new Error(captured.reason);
            yield* waitFor(
              manager.snapshot(input).pipe(Effect.map((state) => state.historyTruncated === true)),
            );
            yield* Effect.promise(() =>
              page.evaluate(async (frame) => {
                const realm = globalThis as unknown as BrowserRealm;
                realm.terminal = new realm.Terminal({
                  cols: frame.cols,
                  rows: frame.rows,
                  scrollback: 5000,
                  allowProposedApi: true,
                });
                realm.terminal.open(realm.document.getElementById("terminal"));
                await new Promise<void>((done) =>
                  realm.terminal.write(frame.ansi + frame.pendingEscapeTail, done),
                );
              }, captured.frame),
            );
            const visible = () =>
              page.evaluate(() => {
                const buffer = (globalThis as unknown as BrowserRealm).terminal.buffer.active;
                return Array.from({ length: 24 }, (_, row) =>
                  buffer.getLine(buffer.baseY + row)?.translateToString(true),
                ).join("\n");
              });
            expect(yield* Effect.promise(visible)).toContain("RECOVERY-FINAL");
            yield* manager.write({ ...input, data: "still-alive" });
            yield* Effect.promise(() =>
              expect
                .poll(() => writes.mock.calls.some(([data]) => data.includes("INPUT:still-alive")))
                .toBe(true),
            );
            yield* Effect.promise(() => model.capture()); // Fixed parse fence before reading applied suffix.
            const suffix = model.records.after(captured.frame);
            expect(suffix.type).toBe("suffix");
            if (suffix.type === "suffix")
              yield* Effect.promise(() =>
                page.evaluate(
                  async (records) => {
                    const terminal = (globalThis as unknown as BrowserRealm).terminal;
                    for (const record of records) {
                      if (record.type === "resize") terminal.resize(record.cols, record.rows);
                      else await new Promise<void>((done) => terminal.write(record.data, done));
                    }
                  },
                  [...suffix.records],
                ),
              );
            expect(yield* Effect.promise(visible)).toContain("INPUT:still-alive");
            expect((yield* manager.snapshot(input)).pid).toBe(opened.pid);
            expect(spawn).toHaveBeenCalledOnce();
            yield* manager.close(input);
            expect(model.unavailableReason).not.toBeNull();
          }).pipe(Effect.provide(NodePTY.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
        ),
      );
    } finally {
      await browser.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
  20_000,
);
