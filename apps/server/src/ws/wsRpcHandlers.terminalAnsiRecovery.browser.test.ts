import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { WS_METHODS } from "@bigbud/contracts";
import {
  TerminalRecoveryInput,
  TerminalRecoveryResult,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import { makeTerminalManagerWithOptions } from "../terminal/Layers/Manager";
import * as NodePTY from "../terminal/Layers/NodePTY";
import { PtyAdapter } from "../terminal/Services/PTY";
import { waitFor } from "../terminal/Layers/Manager.test.helpers";
import { buildAppUnderTest } from "../server.test.app";
import { makeWsRpcClient, getWsServerUrl, wsRpcProtocolLayer } from "../server.test.rpc";
import { serverHttpTestLayer } from "../server.test.http";

const require = createRequire(import.meta.url);
// The browser loads the actual production intake and write lane, not a test-only ANSI hydrator.
type Realm = {
  Terminal: new (options: object) => any;
  Recovery: {
    TerminalViewportIntake: new (...args: any[]) => any;
    TerminalWriteBatcher: new (...args: any[]) => any;
  };
  terminal: any;
  intake: any;
  lane: any;
  failures: string[];
  document: { createElement(tag: string): unknown };
  recover(input: TerminalRecoveryInput): Promise<TerminalRecoveryResult>;
  input(data: string): Promise<void>;
};

it.skipIf(process.platform === "win32").each(["sustained", "detached-query", "fast-parallel"])(
  "real PTY RPC production intake preserves PID and query authority (%s)",
  async (mode) => {
    const detachedQuery = mode === "detached-query";
    const overload = mode === "fast-parallel";
    vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", undefined);
    vi.stubEnv("BIGBUD_TERMINAL_RECOVERY", "1");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bigbud-ansi-rpc-" });
            const entry = path.join(dir, "entry.ts");
            const bundle = path.join(dir, "intake.js");
            yield* fs.writeFileString(
              entry,
              `import { TerminalViewportIntake } from ${JSON.stringify(path.resolve("../web/src/components/terminal/TerminalViewport.intake.ts"))}; import { TerminalWriteBatcher } from ${JSON.stringify(path.resolve("../web/src/components/terminal/TerminalWriteBatcher.ts"))}; globalThis.Recovery = { TerminalViewportIntake, TerminalWriteBatcher };`,
            );
            execFileSync("bun", [
              "build",
              entry,
              "--target=browser",
              "--format=iife",
              "--outfile",
              bundle,
            ]);
            const shell = path.join(dir, "fixture");
            yield* fs.writeFileString(
              shell,
              `#!${process.execPath}\nprocess.stdin.setRawMode(true);let n=0;const timer=setInterval(()=>{process.stdout.write('\\x1b[H'+'x'.repeat(${overload ? 4096 : 32768})+'\\r\\n');if(++n===${overload ? 2400 : 300}){clearInterval(timer);process.stdout.write('\\x1b[2J\\x1b[HRECOVERY-FINAL');}},${overload ? 3 : 50});process.stdin.on('data',d=>{if(d.toString()==='query')process.stdout.write('\\x1b[6n');else process.stdout.write('\\r\\nINPUT:'+d.toString('hex'));});\n`,
            );
            yield* fs.chmod(shell, 0o755);
            const adapter = yield* PtyAdapter;
            const pressure = new Map<number, { pauses: number; resumes: number; held: boolean }>();
            const spawn = vi.fn((input: Parameters<typeof adapter.spawn>[0]) =>
              adapter.spawn(input).pipe(
                Effect.map((proc) => {
                  const state = { pauses: 0, resumes: 0, held: false };
                  pressure.set(proc.pid, state);
                  if (proc.pause && proc.resume) {
                    const pause = proc.pause.bind(proc),
                      resume = proc.resume.bind(proc);
                    vi.spyOn(proc, "pause").mockImplementation(() => {
                      state.pauses++;
                      state.held = true;
                      pause();
                    });
                    vi.spyOn(proc, "resume").mockImplementation(() => {
                      state.resumes++;
                      state.held = false;
                      resume();
                    });
                  }
                  return proc;
                }),
              ),
            );
            const manager = yield* makeTerminalManagerWithOptions({
              logsDir: dir,
              ptyAdapter: { spawn },
              shellResolver: () => shell,
              agentDetector: () => Effect.succeed(new Map()),
              subprocessChecker: () => Effect.succeed(false),
            });
            yield* buildAppUnderTest({ layers: { terminalManager: manager } });
            const protocol = yield* Layer.build(wsRpcProtocolLayer(yield* getWsServerUrl("/ws")));
            const client = yield* makeWsRpcClient.pipe(Effect.provideServices(protocol));
            const run = Effect.runPromiseWith(yield* Effect.services());
            const input = {
              threadId: "recovery-rpc",
              terminalId: "default",
              cwd: dir,
              cols: 80,
              rows: 24,
            };
            let finalOutput = false;
            let peerFinal = false;
            let peerTail = "";
            let tail = "";
            const startupSubscription = yield* manager.subscribe((event) =>
              Effect.sync(() => {
                if (event.type === "output") {
                  if (event.threadId === "recovery-peer") {
                    peerTail = (peerTail + event.data).slice(-128);
                    peerFinal ||= peerTail.includes("RECOVERY-FINAL");
                    return;
                  }
                  tail = (tail + event.data).slice(-64);
                  finalOutput ||= tail.includes("RECOVERY-FINAL");
                }
              }),
            );
            yield* Effect.addFinalizer(() => Effect.sync(startupSubscription));
            const opened = yield* client[WS_METHODS.terminalOpen](input).pipe(
              Effect.timeout("5 seconds"),
            );
            const peerInput = { ...input, threadId: "recovery-peer" };
            const peer = overload ? yield* client[WS_METHODS.terminalOpen](peerInput) : undefined;
            yield* waitFor(
              manager
                .snapshot(input)
                .pipe(Effect.map((state) => state.historyTruncated === true && finalOutput)),
              "45 seconds",
            );
            if (peer) {
              yield* waitFor(
                Effect.sync(() => peerFinal),
                "45 seconds",
              );
              const recovered = yield* client[WS_METHODS.terminalRecovery]({
                ...peerInput,
                expectedGeneration: peer.runtimeGeneration!,
              });
              expect(recovered.type).toBe("snapshot");
              if (recovered.type === "snapshot")
                expect(recovered.frame.ansi).toContain("RECOVERY-FINAL");
              yield* client[WS_METHODS.terminalWrite]({
                ...peerInput,
                expectedGeneration: peer.runtimeGeneration!,
                data: "peer-live",
              });
              yield* waitFor(
                Effect.sync(() => peerTail.includes(Buffer.from("peer-live").toString("hex"))),
              );
              expect((yield* manager.snapshot(peerInput)).pid).toBe(peer.pid);
            }
            const snapshot = yield* manager.snapshot(input);
            // Explicit qualification probe: an unanswered detached query is before the capture cut,
            // but is not historical/answered merely because its bytes have already reached the model.
            if (detachedQuery) {
              yield* manager.write({ ...input, data: "query" });
              yield* waitFor(Effect.sync(() => tail.includes("\x1b[6n")));
            }
            const requests: TerminalRecoveryInput[] = [];
            const replies: string[] = [];
            yield* Effect.promise(() =>
              page.exposeFunction("recover", async (request: TerminalRecoveryInput) => {
                requests.push(request);
                const decoded = Schema.decodeUnknownSync(TerminalRecoveryInput)(request);
                return Schema.decodeUnknownSync(TerminalRecoveryResult)(
                  await run(client[WS_METHODS.terminalRecovery](decoded)),
                );
              }),
            );
            yield* Effect.promise(() =>
              page.exposeFunction("input", async (data: string) => {
                replies.push(data);
                await run(
                  client[WS_METHODS.terminalWrite]({
                    ...input,
                    expectedGeneration: opened.runtimeGeneration!,
                    data,
                  }),
                );
              }),
            );
            yield* Effect.promise(() => page.setContent("<!doctype html>"));
            yield* Effect.promise(() =>
              page.addScriptTag({ path: require.resolve("@xterm/xterm") }),
            );
            yield* Effect.promise(() => page.addScriptTag({ path: bundle }));
            yield* Effect.promise(() =>
              page.evaluate(() => {
                const r = globalThis as unknown as Realm;
                r.failures = [];
                r.terminal = new r.Terminal({ cols: 50, rows: 8, allowProposedApi: true });
                r.terminal.open(r.document.createElement("div"));
                r.lane = new r.Recovery.TerminalWriteBatcher((error: Error) =>
                  r.failures.push(error.message),
                );
                r.intake = new r.Recovery.TerminalViewportIntake(
                  r.terminal,
                  r.lane,
                  (event: { type: string; data?: string }) => {
                    if (event.type === "output") r.lane.write(r.terminal, event.data);
                  },
                  () => undefined,
                  () => undefined,
                  () => true,
                  (input: TerminalRecoveryInput) => r.recover(input),
                );
                r.terminal.onData((data: string) => {
                  if (r.intake.acceptsInput) void r.input(data);
                });
              }),
            );
            const unsubscribe = yield* manager.subscribe((event) =>
              Effect.promise(() =>
                page.evaluate((event) => {
                  (globalThis as unknown as Realm).intake.receive(event);
                }, event),
              ),
            );
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
            if (detachedQuery) {
              // The mirror refuses the cut; the view attaches live instead and never invents
              // a reply for the query the process sent while no renderer was attached.
              const attached = yield* Effect.promise(() =>
                page.evaluate(async (snapshot) => {
                  const r = globalThis as unknown as Realm;
                  await r.intake.hydrate(snapshot);
                  return { input: r.intake.acceptsInput, failures: r.failures };
                }, snapshot),
              );
              expect(attached).toEqual({ input: true, failures: [] });
              expect(replies).toEqual([]);
              expect((yield* manager.snapshot(input)).pid).toBe(opened.pid);
              expect(spawn).toHaveBeenCalledOnce();
              yield* Effect.promise(() =>
                page.evaluate(() => {
                  const r = globalThis as unknown as Realm;
                  r.intake.dispose();
                  r.lane.dispose();
                  r.terminal.dispose();
                }),
              );
              yield* manager.close(input);
              return;
            }
            yield* Effect.promise(() =>
              page.evaluate(async (snapshot) => {
                await (globalThis as unknown as Realm).intake.hydrate(snapshot);
              }, snapshot),
            );
            const visible = () =>
              page.evaluate(() => {
                const t = (globalThis as unknown as Realm).terminal;
                return Array.from({ length: t.rows }, (_, row) =>
                  t.buffer.active.getLine(t.buffer.active.baseY + row)?.translateToString(true),
                ).join("\n");
              });
            expect(yield* Effect.promise(visible)).toContain("RECOVERY-FINAL");
            // A second fresh renderer remounts after >9 MiB of redraw output on the same PTY.
            yield* Effect.promise(() =>
              page.evaluate(async (snapshot) => {
                const r = globalThis as unknown as Realm;
                r.intake.dispose();
                r.lane.dispose();
                r.terminal.dispose();
                r.terminal = new r.Terminal({ cols: 50, rows: 8, allowProposedApi: true });
                r.terminal.open(r.document.createElement("div"));
                r.lane = new r.Recovery.TerminalWriteBatcher((error: Error) =>
                  r.failures.push(error.message),
                );
                r.intake = new r.Recovery.TerminalViewportIntake(
                  r.terminal,
                  r.lane,
                  (event: { type: string; data?: string }) => {
                    if (event.type === "output") r.lane.write(r.terminal, event.data);
                  },
                  () => undefined,
                  () => undefined,
                  () => true,
                  (input: TerminalRecoveryInput) => r.recover(input),
                );
                r.terminal.onData((data: string) => {
                  if (r.intake.acceptsInput) void r.input(data);
                });
                await r.intake.hydrate(snapshot);
              }, snapshot),
            );
            expect(yield* Effect.promise(visible)).toContain("RECOVERY-FINAL");
            expect(replies).toEqual([]); // Historical frame must not answer answered queries.
            yield* manager.resize({ ...input, cols: 90, rows: 28 });
            yield* manager.write({ ...input, data: "query" });
            yield* Effect.promise(() =>
              expect.poll(() => replies.length, { timeout: 5000 }).toBe(1),
            );
            yield* Effect.promise(() => expect.poll(visible).toContain("INPUT:"));
            yield* Effect.promise(() =>
              page.evaluate(() => {
                const r = globalThis as unknown as Realm;
                r.terminal.input("still-alive", true);
              }),
            );
            yield* Effect.promise(() =>
              expect.poll(visible).toContain(Buffer.from("still-alive").toString("hex")),
            );
            expect(replies.filter((data) => data.startsWith("\x1b["))).toHaveLength(1);
            expect(requests.some((request) => request.after !== undefined)).toBe(true);
            expect(
              yield* Effect.promise(() =>
                page.evaluate(() => {
                  const r = globalThis as unknown as Realm;
                  return [r.terminal.cols, r.terminal.rows, r.failures];
                }),
              ),
            ).toEqual([90, 28, []]);
            expect((yield* manager.snapshot(input)).pid).toBe(opened.pid);
            expect(spawn).toHaveBeenCalledTimes(peer ? 2 : 1);
            if (peer)
              for (const state of pressure.values()) {
                expect(state.pauses).toBeGreaterThan(0);
                expect(state.resumes).toBeGreaterThan(0);
                expect(state.held).toBe(false);
              }
            yield* Effect.promise(() =>
              page.evaluate(() => {
                const r = globalThis as unknown as Realm;
                r.intake.dispose();
                r.lane.dispose();
                r.terminal.dispose();
              }),
            );
            yield* manager.close(input);
            if (peer) yield* manager.close(peerInput);
          }),
        ).pipe(
          Effect.provide(
            Layer.merge(serverHttpTestLayer, NodePTY.layer).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await browser.close();
      vi.unstubAllEnvs();
    }
  },
  60_000,
);
