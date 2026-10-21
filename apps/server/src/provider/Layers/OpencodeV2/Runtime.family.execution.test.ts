import { expect, it, vi } from "vitest";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";
import { V2OwnedFamily } from "./Subagents.ownership.ts";
import { stopV2OwnedDescendants } from "./Runtime.family.stop.ts";
import { resolveRuntimeTaskIdentity } from "../../../orchestration/Layers/ProviderRuntimeIngestion.tasks.identity.ts";
import { RuntimeTaskId } from "@bigbud/contracts/core/baseSchemas";

it("enrolls and restricts children before native prompt, persists nested lineage and restores stable IDs across epochs", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch }) => {
    await launch("ses_owned_a");
    await launch("ses_owned_b", "ses_owned_a");
    expect(owner.family!.children.map((child) => [child.id, child.depth])).toEqual([
      ["ses_owned_a", 1],
      ["ses_owned_b", 2],
    ]);
    for (const id of ["ses_owned_a", "ses_owned_b"]) {
      const writes = http.calls.filter((call) => call.pathname.includes(id));
      expect(writes.findIndex((call) => call.method === "PATCH")).toBeLessThan(
        writes.findIndex((call) => call.pathname.endsWith("/prompt")),
      );
      expect(http.sessions.get(id)!.permissions!.some((rule) => rule.effect === "allow")).toBe(
        false,
      );
    }
    const recovered = await V2OwnedFamily.open(runtime.options.config.profileRoot, {
      threadId: owner.threadId,
      rootId: owner.native.id,
      storageIdentity: owner.storageIdentity,
    });
    expect(recovered.children).toEqual(owner.family!.children);
    const taskId = RuntimeTaskId.makeUnsafe(recovered.children[0]!.taskId);
    for (const sessionEpoch of [0, 9])
      expect(
        resolveRuntimeTaskIdentity({
          threadId: owner.threadId,
          sessionEpoch,
          provider: "opencodeV2",
          incomingTaskId: taskId,
          incomingKind: "providerSubagent",
          incomingNativeId: "ses_owned_a",
          currentTasks: [],
        }).id,
      ).toBe(taskId);
    expect(
      resolveRuntimeTaskIdentity({
        threadId: owner.threadId,
        sessionEpoch: 9,
        provider: "codex",
        incomingTaskId: taskId,
        incomingKind: "providerSubagent",
        currentTasks: [],
      }).id,
    ).not.toBe(taskId);
  });
});

it("Stop cancels every enrolled nested descendant, never a merely discovered/unrelated session, and fences future spawns", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, finish }) => {
    await launch("ses_owned_a");
    await launch("ses_owned_b", "ses_owned_a");
    http.sessions.set("ses_unrelated", { ...owner.native, id: "ses_unrelated" });
    const original = http.fetch.bind(http);
    vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (new URL(url).pathname.endsWith("/interrupt")) {
        const id = new URL(url).pathname.split("/")[3]!;
        if (id !== owner.native.id) finish(id);
      }
      return result;
    });
    await runtime.interrupt(owner.threadId);
    expect(owner.family!.isFenced).toBe(true);
    expect(owner.family!.children.every((child) => child.state === "terminal")).toBe(true);
    expect(
      http.calls
        .filter((call) => call.pathname.endsWith("/interrupt"))
        .map((call) => call.pathname),
    ).toEqual(
      expect.arrayContaining([
        `/api/session/${owner.native.id}/interrupt`,
        "/api/session/ses_owned_a/interrupt",
        "/api/session/ses_owned_b/interrupt",
      ]),
    );
    expect(http.calls.some((call) => call.pathname.includes("ses_unrelated"))).toBe(false);
    await expect(launch("ses_racing")).rejects.toThrow("Stop fence");
    expect(http.calls.some((call) => call.pathname === "/api/session/ses_racing/prompt")).toBe(
      false,
    );
  });
});

it("an HTTP interrupt acknowledgement alone never settles ownership; uncertainty and Stop survive reopening", async () => {
  await withV2OwnedFamily(async ({ runtime, owner, launch }) => {
    await launch("ses_owned_a");
    await expect(stopV2OwnedDescendants(owner, 30)).rejects.toThrow("unconfirmed");
    expect(owner.family!.child("ses_owned_a")!.state).toBe("uncertain");
    const recovered = await V2OwnedFamily.open(runtime.options.config.profileRoot, {
      storageIdentity: owner.storageIdentity,
      rootId: owner.native.id,
      threadId: owner.threadId,
    });
    expect(recovered.isFenced).toBe(true);
    expect(recovered.live).toBe(true);
    await expect(
      recovered.enroll({
        id: "ses_race",
        parentId: owner.native.id,
        agent: "explore",
        description: "Race",
        prompt: "offline",
        messageId: "msg_race",
        callId: "call_race",
        background: true,
      }),
    ).rejects.toThrow("Stop fence");
  });
});
