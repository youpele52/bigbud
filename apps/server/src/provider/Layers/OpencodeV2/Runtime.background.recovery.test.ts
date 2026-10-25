import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { backgroundInterval, backgroundContinuation } from "./Runtime.background.fixture.ts";

it("recovers the same accepted admission after restart, retains all continuation output and interrupted outcome, then permits one new turn", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("background-restart");
    const modelSelection = {
      provider: "opencodeV2" as const,
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    };
    const start = {
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required" as const,
    };
    const started = await runtime.start(start);
    http.autoComplete = false;
    vi.spyOn(http.client.server, "info").mockResolvedValue({
      version: "2.0.32",
      pid: 1,
      urls: [],
      paths: { tmp: directory },
    });
    vi.spyOn(http.client.shell, "list").mockImplementation(async (input) => ({
      location: { directory: input!.location!.directory! },
      data: [],
    }));
    await runtime.send({
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("original-background"),
      input: "original",
    });
    const nativeId = runtime.get(threadId).native.id;
    const messages = http.messages.get(nativeId)!;
    messages.push(...backgroundInterval());
    http.inbox.set(nativeId, []);
    await runtime.reconcile(runtime.get(threadId));
    expect(runtime.get(threadId).row?.state).toBe("accepted");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    const lease = await runtime.options.manager.acquire(runtime.options.config);
    try {
      await runtime.stop(threadId);
      messages.push(...backgroundContinuation());
      await runtime.start({ ...start, resumeCursor: started.resumeCursor });
      const owner = runtime.get(threadId);
      expect(owner.native.id).toBe(nativeId);
      expect(owner.session.lastError).toBeUndefined();
      expect(owner.row).toMatchObject({ state: "terminal", terminalOutcome: "interrupted" });
      expect(
        events
          .filter(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "assistant_message",
          )
          .map((event) => (event.type === "item.completed" ? event.payload.detail : undefined)),
      ).toEqual(
        expect.arrayContaining([
          "output launch",
          "output before-interruption",
          "output after-interruption",
        ]),
      );
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
        payload: { state: "interrupted" },
      });
      await runtime.reconcile(owner);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      http.autoComplete = true;
      await runtime.send({
        threadId,
        modelSelection,
        requestMessageId: MessageId.makeUnsafe("new-after-background"),
        input: "new",
      });
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
      expect(
        http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST"),
      ).toHaveLength(1);
    } finally {
      await lease.release();
    }
  });
});

it.each([
  "active",
  "inbox",
  "shell",
  "changed-transcript",
  "unsupported-version",
  "foreign-shell",
] as const)("settles only owned background work with %s evidence", async (held) => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe(`background-${held}`);
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
    await runtime.send({
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("held-background"),
      input: "original",
    });
    const owner = runtime.get(threadId),
      id = owner.native.id;
    http.messages.get(id)!.push(...backgroundInterval(), ...backgroundContinuation());
    if (held !== "inbox") http.inbox.set(id, []);
    vi.spyOn(http.client.server, "info").mockResolvedValue({
      version: held === "unsupported-version" ? "2.0.33" : "2.0.32",
      pid: 1,
      urls: [],
      paths: { tmp: directory },
    });
    vi.spyOn(http.client.shell, "list").mockImplementation(async (input) => {
      if (held === "changed-transcript")
        http.messages
          .get(id)!
          .push({ id: "late-unowned", type: "synthetic", text: "unknown", time: { created: 9 } });
      return {
        location: { directory: input!.location!.directory! },
        data:
          held === "shell" || held === "foreign-shell"
            ? [
                {
                  id: held === "foreign-shell" ? "sh_foreign" : "sh_late",
                  status: "running",
                  command: "synthetic",
                  cwd: directory,
                  shell: "fixture",
                  file: "fixture",
                  metadata: { sessionID: held === "foreign-shell" ? "foreign-session" : id },
                  time: { started: 1 },
                },
              ]
            : [],
      };
    });
    if (held === "active")
      vi.spyOn(http.client.session, "active").mockResolvedValue({ [id]: { type: "running" } });
    if (held === "foreign-shell")
      vi.spyOn(http.client.session, "active").mockResolvedValue({
        "foreign-session": { type: "running" },
      });
    await runtime.reconcile(owner);
    expect(owner.row?.state).toBe(held === "foreign-shell" ? "terminal" : "accepted");
    if (held === "unsupported-version")
      expect(owner.session.lastError).toContain("verified only for native 2.0.32");
    expect(events.some((event) => event.type === "turn.completed")).toBe(held === "foreign-shell");
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});
