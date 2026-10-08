import { readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";
import { runtimeEventToActivities } from "../../../orchestration/Layers/ProviderRuntimeIngestion.helpers.ts";

const selection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;
const python = "/Library/Developer/CommandLineTools/usr/bin/python3";
for (const cancellation of ["interrupt", "stop", "loss", "disable"] as const) {
  it.skipIf(process.platform !== "darwin")(
    `runtime ${cancellation} cancels exact executing owner outside queues and waits physical KILL; independent session is not starved`,
    async () => {
      await withV2RuntimeFixture(async ({ runtime: fixture, http, directory, events }) => {
        http.autoComplete = false;
        const root = await realpath(directory),
          profile = await realpath(fixture.options.config.profileRoot);
        const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
        let enabled = true;
        const runtime = new OpencodeV2Runtime({
          ...fixture.options,
          codingBridge: coding,
          enableLocalTools: true,
          authorizeExecution: async () => {
            if (!enabled) throw new Error("disabled");
          },
        });
        const a = ThreadId.makeUnsafe("execution-a"),
          b = ThreadId.makeUnsafe("execution-b");
        try {
          await runtime.start({
            threadId: a,
            cwd: root,
            modelSelection: selection,
            runtimeMode: "approval-required",
          });
          await runtime.send({
            threadId: a,
            modelSelection: selection,
            input: "hold",
            requestMessageId: MessageId.makeUnsafe("a"),
          });
          const owner = runtime.get(a);
          const rejectedOffset = events.length;
          await expect(
            coding.invoke({
              action: "shell",
              sessionID: owner.native.id,
              messageID: "assistant",
              callID: "oversized",
              input: { path: ".", command: "x".repeat(16385) },
            }),
          ).rejects.toThrow("bounded");
          await expect(
            coding.invoke({
              action: "shell",
              sessionID: owner.native.id,
              messageID: "assistant",
              callID: "oversized-display",
              input: { path: ".", command: "\u0000".repeat(12000) },
            }),
          ).rejects.toThrow();
          expect(events.slice(rejectedOffset).some((e) => e.type === "request.opened")).toBe(false);
          await writeFile(
            path.join(root, "hold.py"),
            "import signal,time,pathlib,os\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\npathlib.Path('ready').write_text(str(os.getpid()))\ntime.sleep(10)\npathlib.Path('late').write_text('unsafe')\n",
          );
          const call = {
            action: "shell",
            sessionID: owner.native.id,
            messageID: "assistant",
            callID: "hold",
            input: { path: ".", command: `exec ${python} -I -S hold.py` },
          };
          const operation = coding.invoke(call);
          await expect
            .poll(() => events.find((e) => e.type === "request.opened" && e.threadId === a))
            .toBeDefined();
          const approval = events.find((e) => e.type === "request.opened" && e.threadId === a)!;
          expect(runtimeEventToActivities(approval)[0]?.payload).toMatchObject({
            executionIntent: {
              format: "json",
              content: expect.stringContaining(`exec ${python} -I -S hold.py`),
            },
            sessionApprovalAvailable: false,
          });
          await runtime.respondPermission(a, approval.requestId!, "accept");
          await expect
            .poll(() => readFile(path.join(root, "ready"), "utf8").catch(() => ""))
            .not.toBe("");
          const pid = Number(await readFile(path.join(root, "ready"), "utf8"));
          // These native mutations and coding actions used to queue behind the entire A command.
          await runtime.start({
            threadId: b,
            cwd: root,
            modelSelection: selection,
            runtimeMode: "approval-required",
          });
          await Promise.all(
            Array.from({ length: 23 }, (_, index) =>
              runtime.start({
                threadId: ThreadId.makeUnsafe(`peer-${index}`),
                cwd: root,
                modelSelection: selection,
                runtimeMode: "approval-required",
              }),
            ),
          );
          expect(runtime.sessions.size).toBe(25);
          await runtime.send({
            threadId: b,
            modelSelection: selection,
            input: "independent",
            requestMessageId: MessageId.makeUnsafe("b"),
          });
          const bCall = {
            ...call,
            sessionID: runtime.get(b).native.id,
            callID: "b",
            input: { path: ".", command: "printf independent > independent" },
          };
          const bOperation = coding.invoke(bCall);
          await expect
            .poll(() => events.find((e) => e.type === "request.opened" && e.threadId === b))
            .toBeDefined();
          await runtime.respondPermission(
            b,
            events.find((e) => e.type === "request.opened" && e.threadId === b)!.requestId!,
            "accept",
          );
          expect(JSON.parse((await bOperation).content!).exitCode).toBe(0);
          expect(await readFile(path.join(root, "independent"), "utf8")).toBe("independent");
          expect(() => process.kill(pid, 0)).not.toThrow();
          if (cancellation === "interrupt") await runtime.interrupt(a);
          else if (cancellation === "loss") {
            http.die();
            await expect.poll(() => owner.lossPending, { timeout: 5000 }).toBe(false);
          } else {
            if (cancellation === "disable") enabled = false;
            await runtime.stop(a, owner);
          }
          expect(JSON.parse((await operation).content!)).toMatchObject({
            cancelled: true,
            signal: "SIGKILL",
          });
          expect(() => process.kill(pid, 0)).toThrow();
          await expect(readFile(path.join(root, "late"))).rejects.toThrow();
          if (cancellation === "interrupt") {
            expect(await coding.invoke(call)).toEqual(await operation); // completed cancellation receipt, never restart.
            await runtime.stop(a, owner);
            await runtime.start({
              threadId: a,
              cwd: root,
              modelSelection: selection,
              runtimeMode: "approval-required",
            });
            const successor = runtime.get(a);
            await runtime.stop(a, owner);
            expect(runtime.get(a)).toBe(successor);
          }
        } finally {
          await runtime.close();
          coding.close();
        }
      });
    },
    15000,
  );
}
