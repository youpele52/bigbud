import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/headless";
import { createTerminalRecoveryModel } from "./TerminalRecoveryModel";

const require = createRequire(import.meta.url);
function killProbeGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
type Realm = {
  Terminal: new (options: object) => Terminal & { open(element: unknown): void };
  Unicode11Addon: { Unicode11Addon: new () => { activate(t: Terminal): void; dispose(): void } };
  BigbudUnicode: { activateTerminalUnicodeProvider(t: Terminal): void };
  source: Terminal;
  restored: Terminal;
  reply(data: string): void;
  document: { createElement(tag: string): unknown };
};

// Explicit native qualification: never launch installed agent CLIs in an ordinary test run.
for (const name of ["pi", "opencode"] as const) {
  it.skipIf(process.env.BIGBUD_TERMINAL_TUI_PROBE !== "1" || process.platform === "win32")(
    `installed ${name}: isolated startup and unsubmitted input through browser/headless snapshot`,
    async () => {
      const executable = execFileSync("/bin/sh", ["-c", `command -v ${name}`], {
        encoding: "utf8",
      }).trim();
      const directory = await mkdtemp(join(tmpdir(), "bigbud-tui-recovery-"));
      const browser = await chromium.launch({ headless: true });
      let process: IPty | undefined;
      let exited = false;
      vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "1");
      const model = createTerminalRecoveryModel(name, 100, 30)!;
      try {
        const home = join(directory, "home");
        await mkdir(home);
        const unicode = join(directory, "unicode.js");
        const entry = join(directory, "unicode.entry.js");
        await writeFile(
          entry,
          `import { activateTerminalUnicodeProvider } from ${JSON.stringify(resolve("../../packages/shared/src/terminalUnicodeProvider.ts"))}; globalThis.BigbudUnicode = { activateTerminalUnicodeProvider };`,
        );
        execFileSync("bun", [
          "build",
          entry,
          "--target=browser",
          "--format=iife",
          "--outfile",
          unicode,
        ]);
        const page = await browser.newPage();
        await page.setContent("<!doctype html>");
        await page.exposeFunction("reply", (data: string) => {
          if (!exited) {
            process?.write(data);
            model.observeInput(data);
          }
        });
        await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
        await page.addScriptTag({ path: require.resolve("@xterm/addon-unicode11") });
        await page.addScriptTag({ path: unicode });
        await page.evaluate(() => {
          const realm = globalThis as unknown as Realm;
          const terminal = new realm.Terminal({
            cols: 100,
            rows: 30,
            scrollback: 5000,
            allowProposedApi: true,
            cursorBlink: true,
          });
          terminal.open(realm.document.createElement("div"));
          terminal.loadAddon(new realm.Unicode11Addon.Unicode11Addon());
          realm.BigbudUnicode.activateTerminalUnicodeProvider(terminal);
          terminal.onData((data) => realm.reply(data));
          realm.source = terminal;
        });
        process = spawn(
          executable,
          name === "pi"
            ? [
                "--no-session",
                "--no-extensions",
                "--no-mcp",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--offline",
              ]
            : ["--standalone"],
          {
            cwd: directory,
            cols: 100,
            rows: 30,
            name: "xterm-256color",
            env: {
              PATH: globalThis.process.env.PATH!,
              HOME: home,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
              LANG: "en_US.UTF-8",
              XDG_CONFIG_HOME: join(home, "config"),
              XDG_DATA_HOME: join(home, "data"),
              XDG_STATE_HOME: join(home, "state"),
              XDG_CACHE_HOME: join(home, "cache"),
              PI_CODING_AGENT_DIR: join(home, "pi"),
              PI_OFFLINE: "1",
            },
          },
        );
        process.onExit(() => {
          exited = true;
        });
        let bytes = 0;
        const graphicsControls: string[] = [];
        let frozen = false;
        let pending = Promise.resolve();
        const listener = process.onData((data) => {
          if (frozen) return;
          bytes += data.length;
          // oxlint-disable-next-line no-control-regex -- Content-bounded diagnostics of this isolated probe's graphics queries.
          for (const match of data.matchAll(/\x1b(?:_G|P|\]1337;)[\s\S]*?\x1b\\/g))
            if (graphicsControls.length < 8) graphicsControls.push(match[0].slice(0, 256));
          model.write(data);
          pending = pending.then(() =>
            page.evaluate(async (chunk) => {
              const terminal = (globalThis as unknown as Realm).source;
              await new Promise<void>((done) => terminal.write(chunk, done));
            }, data),
          );
          // Surface evaluation failures at the awaited fence without unhandled rejections.
          void pending.catch(() => undefined);
        });
        const text = () =>
          page.evaluate(() => {
            const terminal = (globalThis as unknown as Realm).source;
            const buffer = terminal.buffer.active;
            return Array.from(
              { length: terminal.rows },
              (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
            ).join("\n");
          });
        await expect.poll(() => bytes, { timeout: 15_000 }).toBeGreaterThan(100);
        // Wait for an interactive screen, then type without Enter: no model call or user credentials.
        await expect
          .poll(text, { timeout: 15_000 })
          .toMatch(name === "pi" ? /pi|model|provider/i : /OpenCode|provider|connect|welcome/i);
        process.write("recovery-probe-123");
        await expect.poll(text, { timeout: 10_000 }).toContain("recovery-probe-123");
        frozen = true;
        await pending;
        const snapshot = await model.capture();
        if (snapshot.type !== "candidate")
          throw new Error(`${snapshot.reason}: ${JSON.stringify(graphicsControls)}`);
        const comparison = await page.evaluate(async (frame) => {
          const realm = globalThis as unknown as Realm;
          const terminal = new realm.Terminal({
            cols: frame.cols,
            rows: frame.rows,
            scrollback: 5000,
            allowProposedApi: true,
            cursorBlink: true,
          });
          terminal.open(realm.document.createElement("div"));
          terminal.loadAddon(new realm.Unicode11Addon.Unicode11Addon());
          realm.BigbudUnicode.activateTerminalUnicodeProvider(terminal);
          realm.restored = terminal;
          await new Promise<void>((done) =>
            terminal.write(frame.ansi + frame.pendingEscapeTail, done),
          );
          const project = (value: Terminal) => {
            const buffer = value.buffer.active;
            return {
              type: buffer.type,
              mouseEncoding: (
                value as unknown as { _core: { mouseStateService: { activeEncoding: string } } }
              )._core.mouseStateService.activeEncoding,
              cursor: [buffer.cursorX, buffer.cursorY],
              modes: value.modes,
              lines: Array.from(
                { length: frame.rows },
                (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
              ),
            };
          };
          return { source: project(realm.source), restored: project(terminal) };
        }, snapshot.frame);
        expect(comparison.restored).toEqual(comparison.source);
        expect(exited).toBe(false);
        listener.dispose();
      } finally {
        // node-pty creates a private POSIX session; kill only this probe's owned process group.
        if (process && !exited) {
          killProbeGroup(process.pid);
          await expect.poll(() => exited, { timeout: 5000 }).toBe(true);
        }
        model.dispose();
        await browser.close();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
    45_000,
  );
}
