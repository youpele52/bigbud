import { expect, it, vi } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { startRunning, addChild, taskEvents } from "./Runtime.subagents.fixture.ts";
import { readV2ObservedChildren } from "./Runtime.subagents.read.ts";
import { deferred } from "./Test.fixtures.ts";

const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });

it("observes paged native envelopes through the pinned HTTP client without writing any child", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "child-http-pages");
    const first = addChild(http, session);
    const second = addChild(http, session, { id: "ses_second" });
    const request = http.fetch.bind(http);
    const pages: string[] = [];
    vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/session" && (!init?.method || init.method === "GET")) {
        expect(parsed.searchParams.get("parentID")).toBe(session.native.id);
        expect(parsed.searchParams.get("limit")).toBe("32");
        const cursor = parsed.searchParams.get("cursor");
        pages.push(cursor ?? "first");
        return response(
          cursor
            ? { data: [second], cursor: {} }
            : {
                data: [first],
                cursor: { next: "next-child-page" },
              },
        );
      }
      if (parsed.pathname === "/api/session/active")
        return response({ data: { ses_second: { type: "running" } } });
      return request(url, init);
    });
    await runtime.reconcile(session);
    expect(pages).toEqual(["first", "next-child-page"]);
    expect(taskEvents(events)).toHaveLength(2);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      kind: "providerSubagent",
      nativeId: "ses_second",
      activityFresh: true,
    });
    expect(
      http.calls.filter(
        (call) => call.pathname.includes("ses_child") || call.pathname.includes("ses_second"),
      ),
    ).toHaveLength(0);
  });
});

it("does not start another page or activity read after the snapshot owner fence expires", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const session = await startRunning(runtime, http, directory, "child-http-fence");
    const child = addChild(http, session);
    const gate = deferred<void>(),
      entered = deferred<void>();
    const request = http.fetch.bind(http);
    let current = true,
      pages = 0;
    vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
      if (new URL(url).pathname === "/api/session") {
        pages++;
        entered.resolve();
        await gate.promise;
        return response({ data: [child], cursor: { next: "late-page" } });
      }
      return request(url, init);
    });
    const read = readV2ObservedChildren(session, () => {
      if (!current) throw new Error("fixture owner changed");
    });
    const rejected = expect(read).rejects.toThrow("owner changed");
    await entered.promise;
    current = false;
    gate.resolve();
    await rejected;
    expect(pages).toBe(1);
  });
});

it("requires a newer provider revision to reopen a terminal child, without parent liveness", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const session = await startRunning(runtime, http, directory, "child-http-reopen");
    addChild(http, session, { outcome: "succeeded" });
    await runtime.reconcile(session);
    const request = http.fetch.bind(http);
    vi.spyOn(http, "fetch").mockImplementation(async (url, init) =>
      new URL(url).pathname === "/api/session/active"
        ? response({ data: { ses_child: { type: "running" } } })
        : request(url, init),
    );
    addChild(http, session);
    await runtime.reconcile(session);
    expect(taskEvents(events)).toHaveLength(1);
    addChild(http, session, { time: { created: 1000, updated: 3000 } });
    await runtime.reconcile(session);
    expect(taskEvents(events).at(-1)?.payload).toMatchObject({
      status: "inProgress",
      activityFresh: true,
    });
    expect(taskEvents(events).at(-1)?.payload.endedAt).toBeUndefined();
    expect(taskEvents(events).every((event) => event.turnId === undefined)).toBe(true);
  });
});
