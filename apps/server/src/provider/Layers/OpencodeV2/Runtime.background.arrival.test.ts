import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { backgroundInterval, backgroundContinuation } from "./Runtime.background.fixture.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";

it.each(["after-inbox", "during-active", "during-output", "during-settlement"] as const)(
  "fences native arrival %s before consumer execution without releasing physical ownership",
  async (race) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
      const threadId = ThreadId.makeUnsafe(`background-arrival-${race}`);
      const modelSelection = {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      };
      http.autoComplete = false;
      await runtime.start({
        threadId,
        modelSelection,
        cwd: directory,
        runtimeMode: "approval-required",
      });
      const input = {
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("arrival-original"),
        input: "original",
      };
      await runtime.send(input);
      const owner = runtime.get(threadId),
        nativeId = owner.native.id;
      const messages = http.messages.get(nativeId)!;
      messages.push(...backgroundInterval(), ...backgroundContinuation());
      http.inbox.set(nativeId, []);
      const gate = new V2ActivationGate("private-arrival-fixture", "digest", () => {});
      const stamp = gate.verify(owner.native.location.directory, "digest", "instance");
      const token = gate.tryReserve(stamp, "turn")!;
      await gate.dispatch(token, async () => {});
      owner.activation = { gate, stamp, token, phase: "turn" };
      let injected = false,
        queued = false,
        activeReads = 0;
      const inject = async () => {
        if (injected) return;
        injected = true;
        queued = true;
        if (race !== "after-inbox")
          messages.push({
            id: "unknown-native-input",
            type: "synthetic",
            text: "not owned",
            time: { created: 10 },
          });
        const arrival = owner.lease.hub.captureArrivalFence(nativeId)!;
        expect(arrival).toBeTypeOf("function");
        http.source.push({
          id: "native-arrival",
          type: "session.inbox.enqueued",
          created: 10,
          durable: { aggregateID: nativeId, seq: 100, version: 1 },
          location: { directory: owner.native.location.directory },
          data: {
            sessionID: nativeId,
            inboxID: "unknown-native-input",
            item: { type: "synthetic", payload: { text: "not owned" }, delivery: "queue" },
          },
        });
        // The runtime's exclusive queue is held below. Only source ARRIVAL can invalidate this.
        await expect
          .poll(() => {
            try {
              arrival();
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
        expect(owner.dirtyGeneration).toBe(0);
      };
      vi.spyOn(http.client.server, "info").mockResolvedValue({
        version: "2.0.32",
        pid: 1,
        urls: [],
        paths: { tmp: directory },
      });
      vi.spyOn(http.client.session.inbox, "list").mockImplementation(async () =>
        queued
          ? [
              {
                id: "unknown-native-input",
                sessionID: nativeId,
                time: { created: 10 },
                type: "synthetic",
                payload: { text: "not owned" },
                delivery: "queue",
              },
            ]
          : [],
      );
      vi.spyOn(http.client.shell, "list").mockImplementation(async () => {
        if (race === "after-inbox") await inject();
        return { location: { directory: owner.native.location.directory }, data: [] };
      });
      vi.spyOn(http.client.session, "active").mockImplementation(async () => {
        activeReads++;
        if (
          (race === "during-active" && activeReads === 1) ||
          (race === "during-settlement" && activeReads === 2)
        )
          await inject();
        return {};
      });
      const emit = runtime.options.emit;
      vi.spyOn(runtime.options, "emit").mockImplementation(async (event, validate) => {
        if (race === "during-output" && event.type === "item.completed") await inject();
        await emit(event, validate);
      });
      await runtime
        .withSession(threadId, () => runtime.reconcile(owner))
        .catch((error: unknown) => {
          expect(String(error)).toContain("arrival/connection changed");
        });
      expect(injected).toBe(true);
      const durable = await Effect.runPromise(runtime.options.journal.latestBound(threadId));
      // An arrival AFTER the journal commit cannot undo that commit; its exact physical
      // reservation still remains fenced. Earlier arrivals must not terminalize at all.
      expect(durable?.state).toBe(race === "during-settlement" ? "terminal" : "accepted");
      if (race !== "during-settlement")
        expect(events.some((event) => event.type === "turn.completed")).toBe(false);
      expect(owner.activation!.token).toBe(token);
      expect(gate.busyCount()).toBeGreaterThan(0);
      await expect(
        runtime.send({ ...input, requestMessageId: MessageId.makeUnsafe("no-resend") }),
      ).rejects.toThrow();
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
    });
  },
);
