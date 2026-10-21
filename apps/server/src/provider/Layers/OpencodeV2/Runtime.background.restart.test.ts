import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { backgroundInterval, backgroundContinuation } from "./Runtime.background.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";

it.each(["queued", "delivered"] as const)(
  "reconstructs terminal-but-unsettled ownership after backend loss with %s unknown input",
  async (kind) => {
    await withV2SettlementFixture(async ({ runtime, owner, http, send, setActive }) => {
      const directory = owner.native.location.directory,
        nativeId = owner.native.id;
      const threadId = owner.threadId,
        cursor = owner.session.resumeCursor;
      http.autoComplete = false;
      vi.spyOn(http.client.server, "info").mockResolvedValue({
        version: "2.0.32",
        pid: 1,
        urls: [],
        paths: { tmp: directory },
      });
      vi.spyOn(http.client.shell, "list").mockResolvedValue({
        location: { directory },
        data: [
          {
            id: "sh_other_cli",
            status: "running",
            command: "fixture",
            cwd: directory,
            shell: "fixture",
            file: "fixture",
            metadata: { sessionID: "other-cli" },
            time: { started: 1 },
          },
        ],
      });
      await send("pre-crash-background");
      const messages = http.messages.get(nativeId)!;
      messages.push(...backgroundInterval(), ...backgroundContinuation());
      http.inbox.set(nativeId, []);
      setActive(false);
      let queued = false,
        reads = 0;
      const inbox = vi.spyOn(http.client.session.inbox, "list").mockImplementation(async () =>
        queued
          ? [
              {
                id: "unknown-input",
                sessionID: nativeId,
                type: "synthetic",
                delivery: "queue",
                payload: { text: "unowned" },
                time: { created: 10 },
              },
            ]
          : [],
      );
      const active = vi.spyOn(http.client.session, "active").mockImplementation(async () => {
        if (++reads === 2) {
          queued = true;
          if (kind === "delivered")
            messages.push({
              id: "unknown-input",
              type: "synthetic",
              text: "unowned",
              time: { created: 10 },
            });
          const fence = owner.lease.hub.captureArrivalFence(nativeId)!;
          http.source.push({
            id: "after-journal",
            type: "session.inbox.enqueued",
            created: 10,
            durable: { aggregateID: nativeId, seq: 100, version: 1 },
            location: { directory },
            data: {
              sessionID: nativeId,
              inboxID: "unknown-input",
              item: { type: "synthetic", delivery: "queue", payload: { text: "unowned" } },
            },
          });
          await expect
            .poll(() => {
              try {
                fence();
                return false;
              } catch {
                return true;
              }
            })
            .toBe(true);
        }
        return { "other-cli": { type: "running" as const } };
      });
      await expect(runtime.withSession(threadId, () => runtime.reconcile(owner))).rejects.toThrow(
        "arrival/connection changed",
      );
      expect(await Effect.runPromise(runtime.options.journal.latestBound(threadId))).toMatchObject({
        state: "terminal",
        terminalOutcome: "interrupted",
      });
      expect(owner.activation?.token).toBeDefined();
      const mutationsBeforeLoss = http.calls.filter((call) => call.method !== "GET").length;
      // Lose only application-local owners, without a stop/interrupt, deleting history, or rewriting
      // the journal. A fresh backend must not depend on the old in-memory arrival closure.
      owner.stopped = true;
      owner.unregister();
      owner.unsubscribeDeath();
      owner.consentPermit?.release();
      runtime.sessions.delete(threadId);
      await owner.lease.release();
      await runtime.close();
      expect(http.calls.filter((call) => call.method !== "GET")).toHaveLength(mutationsBeforeLoss);
      active.mockResolvedValue({ "other-cli": { type: "running" } });
      const gate = new V2ActivationGate("restarted-backend", "digest", () => {});
      const stamp = gate.verify(directory, "digest", "instance");
      const restarted = new OpencodeV2Runtime({
        ...sharedV2FixtureOptions(runtime, http),
        activation: { ...runtime.options.activation!, awaitReady: async () => ({ gate, stamp }) },
      });
      const modelSelection = {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      };
      try {
        await restarted.start({
          threadId,
          cwd: directory,
          modelSelection,
          runtimeMode: "approval-required",
          resumeCursor: cursor,
        });
        const restored = restarted.get(threadId);
        expect(restored.native.id).toBe(nativeId);
        expect(restored.row?.state).toBe("terminal");
        expect(restored.terminalDelivered).toBe(false);
        expect(restored.activation?.token).toBeDefined();
        const next = {
          threadId,
          modelSelection,
          requestMessageId: MessageId.makeUnsafe("post-crash-next"),
          input: "next",
        };
        await expect(restarted.send(next)).rejects.toThrow();
        expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
        if (kind === "queued") {
          // Simulate native resolution of the undelivered queue item, not an app-issued cancel.
          // No history is removed. Fresh valid closure may release; the old fence is not sticky.
          queued = false;
          await restarted.withSession(threadId, () => restarted.reconcile(restored));
          expect(restored.terminalDelivered).toBe(true);
          expect(restored.row?.terminalOutcome).toBe("interrupted");
          expect(restored.activation?.token).toBeUndefined();
          http.autoComplete = true;
          await restarted.send(next);
          await restarted.send(next); // Idempotent retry must not admit another native prompt.
          expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
          expect(restored.native.id).toBe(nativeId);
        } else {
          await restarted.withSession(threadId, () => restarted.reconcile(restored));
          expect(restored.terminalDelivered).toBe(false);
          expect(restored.activation?.token).toBeDefined();
          expect(messages.some((message) => message.id === "unknown-input")).toBe(true);
        }
        expect(
          http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
        ).toHaveLength(1);
      } finally {
        inbox.mockRestore();
        await restarted.close();
      }
    });
  },
);
