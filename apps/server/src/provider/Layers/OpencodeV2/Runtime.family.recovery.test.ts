import { expect, it, vi } from "vitest";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";
import { V2OwnedFamily } from "./Subagents.ownership.ts";
import { stopV2OwnedDescendants } from "./Runtime.family.stop.ts";
import { pendingV2FamilyInteractions } from "./Runtime.family.interactions.ts";
import { shouldPollV2Runtime } from "./Runtime.settlement.ts";

it("idle root polling repairs child cards/requests without inventing root turn liveness or resending prompts", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, events }) => {
    await launch("ses_owned_idle");
    http.permissions.set("ses_owned_idle", [
      { id: "per_idle", sessionID: "ses_owned_idle", action: "read", resources: ["offline.txt"] },
    ]);
    const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
    owner.repairQueued = false;
    expect(shouldPollV2Runtime(owner)).toBe(true);
    await runtime.reconcile(owner);
    expect(
      events.some(
        (event) => event.type === "task.updated" && event.payload.taskId.startsWith("bbv2-owned:"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-child:"),
      ),
    ).toBe(true);
    expect(
      events
        .filter((event) => ["task.updated", "request.opened"].includes(event.type))
        .every((event) => !event.turnId),
    ).toBe(true);
    expect(
      events.some((event) =>
        ["turn.started", "turn.completed", "content.delta"].includes(event.type),
      ),
    ).toBe(false);
    expect(owner.session.status).toBe("ready");
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(prompts);
  });
});

it("reopening a fenced family recovers cancellation only, never native child prompts or unrelated sessions", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, finish }) => {
    await launch("ses_owned_restart");
    await owner.family!.fence();
    owner.family = await V2OwnedFamily.open(runtime.options.config.profileRoot, {
      storageIdentity: owner.storageIdentity,
      rootId: owner.native.id,
      threadId: owner.threadId,
    });
    const prompts = http.calls.filter((call) => call.pathname.endsWith("/prompt")).length;
    const original = http.fetch.bind(http);
    const spy = vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (new URL(url).pathname === "/api/session/ses_owned_restart/interrupt")
        finish("ses_owned_restart");
      return result;
    });
    await runtime.reconcile(owner);
    expect(owner.family.child("ses_owned_restart")!.state).toBe("terminal");
    expect(owner.family.isFenced).toBe(true);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(prompts);
    spy.mockRestore();
  });
});

it("one descendant losing its acknowledgement cannot prevent interruption attempts against its siblings", async () => {
  await withV2OwnedFamily(async ({ http, owner, launch, finish }) => {
    await launch("ses_owned_lost");
    await launch("ses_owned_sibling");
    const original = http.fetch.bind(http);
    const spy = vi.spyOn(http, "fetch").mockImplementation(async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/session/ses_owned_lost/interrupt")
        throw new Error("offline lost acknowledgement");
      const result = await original(url, init);
      if (pathname === "/api/session/ses_owned_sibling/interrupt") finish("ses_owned_sibling");
      return result;
    });
    await expect(stopV2OwnedDescendants(owner, 100)).rejects.toThrow("unconfirmed");
    expect(owner.family!.child("ses_owned_lost")!.state).toBe("uncertain");
    expect(owner.family!.child("ses_owned_sibling")!.state).toBe("terminal");
    spy.mockRestore();
  });
});

it("unsupported child questions are cancelled through the exact native child target, never exposed as a hanging form", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, events }) => {
    await launch("ses_owned_form");
    http.forms.set("ses_owned_form", [
      {
        id: "frm_external",
        sessionID: "ses_owned_form",
        title: "External",
        state: { status: "pending" },
        fields: [{ key: "external", type: "external", url: "https://example.invalid" }],
      },
    ]);
    await pendingV2FamilyInteractions(runtime, owner, () => {});
    expect(http.forms.get("ses_owned_form")![0]!.state.status).toBe("cancelled");
    expect(
      http.calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.pathname === "/api/session/ses_owned_form/form/frm_external",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "user-input.requested")).toBe(false);
    expect(events.some((event) => event.type === "runtime.warning" && !event.turnId)).toBe(true);
  });
});
