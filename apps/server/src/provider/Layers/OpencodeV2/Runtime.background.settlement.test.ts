import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { backgroundInterval, backgroundContinuation } from "./Runtime.background.fixture.ts";

it.each(["quiet", "other-cli-busy", "same-session-input"] as const)(
  "settles exact shared-session background work with %s while retaining ownership fences",
  async (state) => {
    await withV2SettlementFixture(async ({ runtime, owner, http, gate, setActive, send }) => {
      http.autoComplete = false;
      const directory = owner.native.location.directory;
      const nativeId = owner.native.id;
      vi.spyOn(http.client.server, "info").mockResolvedValue({
        version: "2.0.32",
        pid: 1,
        urls: [],
        paths: { tmp: directory },
      });
      vi.spyOn(http.client.shell, "list").mockResolvedValue({
        location: { directory },
        data:
          state === "other-cli-busy"
            ? [
                {
                  id: "sh_other_cli",
                  status: "running",
                  command: "fixture",
                  cwd: directory,
                  shell: "fixture",
                  file: "fixture",
                  metadata: { sessionID: "other-cli-conversation" },
                  time: { started: 1 },
                },
              ]
            : [],
      });
      await send("background-owned");
      const token = owner.activation!.token;
      expect(token).toBeDefined();
      http.inbox.set(owner.native.id, []);
      const messages = http.messages.get(owner.native.id)!;
      messages.push(...backgroundInterval());
      setActive(false);
      await runtime.reconcile(owner);
      expect(owner.activation!.token).toBe(token);
      expect(owner.row?.state).toBe("accepted");
      await expect(send("premature")).rejects.toThrow("prior physical admission remains owned");
      messages.push(...backgroundContinuation());
      setActive(true);
      await runtime.reconcile(owner);
      expect(owner.activation!.token).toBe(token);
      setActive(false);
      if (state === "other-cli-busy")
        vi.spyOn(http.client.session, "active").mockResolvedValue({
          "other-cli-conversation": { type: "running" },
        });
      if (state === "same-session-input")
        vi.spyOn(http.client.session.inbox, "list").mockResolvedValue([
          {
            id: "unknown-input",
            sessionID: owner.native.id,
            type: "synthetic",
            delivery: "queue",
            payload: { text: "unowned" },
            time: { created: 10 },
          },
        ]);
      await runtime.reconcile(owner);
      if (state === "same-session-input") {
        expect(owner.row?.state).toBe("accepted");
        expect(owner.activation!.token).toBe(token);
        await expect(send("still-fenced")).rejects.toThrow();
      } else {
        expect(owner.row).toMatchObject({ state: "terminal", terminalOutcome: "interrupted" });
        expect(owner.activation!.token).toBeUndefined();
        expect(gate.busyCount()).toBe(0);
        http.autoComplete = true;
        await send("one-new-turn");
        expect(owner.row?.binding.nativeSessionId).toBe(nativeId);
      }
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(
        state === "same-session-input" ? 1 : 2,
      );
      expect(
        http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
      ).toHaveLength(1);
    });
  },
);
