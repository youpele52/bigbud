import { expect, it } from "vitest";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";
import { pendingV2FamilyInteractions } from "./Runtime.family.interactions.ts";
import { pendingV2Interactions } from "./Runtime.interactions.ts";

it("same native permission/form IDs in multiple children map to distinct attributed requests and exact child replies while root is idle", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, events }) => {
    await launch("ses_owned_a");
    await launch("ses_owned_b");
    for (const id of ["ses_owned_a", "ses_owned_b"]) {
      http.permissions.set(id, [
        { id: "per_collision", sessionID: id, action: "shell", resources: ["echo offline"] },
      ]);
      http.forms.set(id, [
        {
          id: "frm_collision",
          sessionID: id,
          title: "Choice",
          state: { status: "pending" },
          fields: [{ key: "answer", type: "string", required: true }],
        },
      ]);
    }
    await pendingV2FamilyInteractions(runtime, owner, () => {});
    const opened = events.filter(
      (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-child:"),
    );
    const forms = events.filter(
      (event) =>
        event.type === "user-input.requested" && event.requestId?.startsWith("bbv2-child:"),
    );
    expect(new Set(opened.map((event) => event.requestId)).size).toBe(2);
    expect(new Set(forms.map((event) => event.requestId)).size).toBe(2);
    expect([...opened, ...forms].every((event) => event.turnId === undefined)).toBe(true);
    expect(opened[0]).toMatchObject({
      payload: {
        detail: expect.stringContaining("[explore]"),
        args: { nativeSessionId: "ses_owned_a" },
      },
    });
    expect(forms[0]).toMatchObject({
      payload: { questions: [{ header: expect.stringContaining("[explore]") }] },
    });
    // Root pending repair must not accidentally look up opaque child forms in the root session.
    await pendingV2Interactions(owner);
    await runtime.respondPermission(owner.threadId, opened[0]!.requestId!, "accept");
    await runtime.respondForm(owner.threadId, forms[1]!.requestId!, { answer: "offline choice" });
    expect(
      http.calls
        .filter((call) => call.pathname.endsWith("/reply"))
        .map((call) => [call.pathname, call.body]),
    ).toEqual([
      ["/api/session/ses_owned_a/permission/per_collision/reply", { decision: "once" }],
      [
        "/api/session/ses_owned_b/form/frm_collision/reply",
        { answer: { answer: "offline choice" } },
      ],
    ]);
    await expect(
      runtime.respondPermission(owner.threadId, opened[0]!.requestId!, "accept"),
    ).rejects.toThrow("stale");
  });
});

it("rejects changed displayed child intent, saved approvals and replies after Stop without native approval dispatch", async () => {
  await withV2OwnedFamily(async ({ runtime, http, owner, launch, events }) => {
    await launch("ses_owned_a");
    const request = {
      id: "per_stale",
      sessionID: "ses_owned_a",
      action: "shell",
      resources: ["echo inspected"],
    };
    http.permissions.set("ses_owned_a", [request]);
    await pendingV2FamilyInteractions(runtime, owner, () => {});
    const id = events.find(
      (event) => event.type === "request.opened" && event.requestId?.startsWith("bbv2-child:"),
    )!.requestId!;
    await expect(runtime.respondPermission(owner.threadId, id, "acceptForSession")).rejects.toThrow(
      "persistent",
    );
    request.resources = ["changed native command"];
    await expect(runtime.respondPermission(owner.threadId, id, "accept")).rejects.toThrow(
      "intent changed",
    );
    await owner.family!.fence();
    await expect(runtime.respondPermission(owner.threadId, id, "accept")).rejects.toThrow("stale");
    expect(http.calls.some((call) => call.pathname.endsWith("/reply"))).toBe(false);
  });
});
