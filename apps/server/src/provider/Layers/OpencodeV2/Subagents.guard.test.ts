import { expect, it } from "vitest";
import type { PermissionRuleset } from "@opencode/client";
import { guardedV2SubagentExecutor } from "./Subagents.guard.ts";
import { v2ChildPermissionCeiling } from "./Subagents.ceiling.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";

const allow: PermissionRuleset = [{ action: "*", resource: "*", effect: "allow" }];

it("parent Full access cannot broaden child deny/ask or stricter session overlays; any resource denial wins", () => {
  for (const effect of ["deny", "ask"] as const)
    expect(
      v2ChildPermissionCeiling({
        action: "read",
        resources: ["safe", "private"],
        nativeEffect: "allow",
        parent: allow,
        agent: [...allow, { action: "read", resource: "private", effect }],
        overlay: [],
      }),
    ).toBe(effect);
  expect(
    v2ChildPermissionCeiling({
      action: "read",
      resources: ["private"],
      nativeEffect: "allow",
      parent: allow,
      agent: allow,
      overlay: [{ action: "read", resource: "private", effect: "deny" }],
    }),
  ).toBe("deny");
  expect(
    v2ChildPermissionCeiling({
      action: "unknown",
      resources: ["safe"],
      nativeEffect: "allow",
      parent: [],
      agent: allow,
      overlay: [],
    }),
  ).toBe("deny");
  expect(
    v2ChildPermissionCeiling({
      action: "read",
      resources: [],
      nativeEffect: "allow",
      parent: allow,
      agent: allow,
      overlay: [],
    }),
  ).toBe("deny");
});

it("all three access modes retain mandatory storage/config denies for shared and native/synthetic local paths", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    const parents = [
      v2SharedToolPolicy(mode, "/owned/db/database.sqlite", true),
      ...[true, false].map((nativeWorkspace) =>
        v2LocalToolPolicy(mode, true, false, {
          nativeWorkspace,
          profileRoot: "/owned/profile",
          boundedFiles: false,
        }),
      ),
    ];
    for (const [index, parent] of parents.entries())
      expect(
        v2ChildPermissionCeiling({
          action: "edit",
          resources: [index === 0 ? "/owned/db/database.sqlite" : "/owned/profile/key"],
          nativeEffect: "allow",
          parent,
          agent: allow,
          overlay: [],
        }),
      ).toBe("deny");
  }
});

it("the awaited native pre-prompt progress cannot pass a Stop fence raised during enrollment", async () => {
  let fenced = false,
    release!: () => void,
    entered!: () => void,
    prompted = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enrollment = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executor = guardedV2SubagentExecutor(
    async (_input, context) => {
      await context.progress({ sessionID: "ses_race" });
      prompted = true;
      return "native result";
    },
    {
      assertCurrent: () => {
        if (fenced) throw new Error("Stop fence");
      },
      beforePrompt: async () => {
        entered();
        await pending;
      },
    },
  );
  const operation = executor(
    { agent: "explore", description: "Race fixture", prompt: "offline" },
    {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      id: "call_parent",
      signal: new AbortController().signal,
      progress: async () => {},
    },
  );
  await enrollment;
  fenced = true;
  release();
  await expect(operation).rejects.toThrow("Stop fence");
  expect(prompted).toBe(false);
});
