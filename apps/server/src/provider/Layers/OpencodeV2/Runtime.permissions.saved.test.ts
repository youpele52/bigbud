import { expect, it, vi } from "vitest";
import type { PermissionRuleset } from "@opencode/client";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { v2SavedGrantMayBypassAsk } from "./Runtime.permissions.overlap.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { v2ResumeCursor } from "./Runtime.sessions.ts";
import { v2ExecutionFailureClass, v2ExecutionIssue } from "./Adapter.execution.errors.ts";
import { V2SavedPermissionConflict } from "./Runtime.permissions.saved.ts";

it.each([
  ["full-access", "read", false],
  ["full-access", "shell", false],
  ["full-access", "external_directory", true],
  ["full-access", "subagent", false],
  ["auto-accept-edits", "edit", false],
  ["auto-accept-edits", "shell", true],
  ["approval-required", "read", true],
  ["approval-required", "edit", true],
] as const)("%s saved %s approval conflicts=%s", (mode, action, conflict) => {
  expect(
    v2SavedGrantMayBypassAsk(v2SharedToolPolicy(mode, undefined, true), {
      action,
      resource: "*",
    }),
  ).toBe(conflict);
});

it("ordered deny/allow exceptions preserve unrelated and protected grants without bypassing asks", () => {
  const rules: PermissionRuleset = [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "docs/*", effect: "ask" },
    { action: "read", resource: "docs/public/*", effect: "allow" },
    { action: "read", resource: "docs/private/*", effect: "deny" },
  ];
  for (const resource of ["other/*", "docs/public/*", "docs/private/*", "docs/private/secret"])
    expect(v2SavedGrantMayBypassAsk(rules, { action: "read", resource })).toBe(false);
  for (const resource of ["*", "docs/*", "docs/?.md", "docs/readme.md"])
    expect(v2SavedGrantMayBypassAsk(rules, { action: "read", resource })).toBe(true);
  expect(v2SavedGrantMayBypassAsk(rules, { action: "r*", resource: "docs/*" })).toBe(true);
  expect(v2SavedGrantMayBypassAsk([], { action: "read", resource: "x" })).toBe(true);
  expect(
    v2SavedGrantMayBypassAsk(
      [
        { action: "*", resource: "*", effect: "deny" },
        { action: "shell", resource: "git status", effect: "ask" },
      ],
      { action: "shell", resource: "git status *" },
    ),
  ).toBe(true);
  for (const action of ["read", "*"])
    expect(
      v2SavedGrantMayBypassAsk(
        [
          { action: "*", resource: "*", effect: "ask" },
          { action: "*", resource: "git status *", effect: "deny" },
        ],
        { action, resource: "git status" },
      ),
    ).toBe(true);
});

it("a compatible wildcard grant has no ask witness in an independently enumerated permission domain", () => {
  const patterns = ["*", "a*", "b*", "?", "a?", "*a", "ab"];
  const values = ["a", "b", "aa", "ab", "ba", "bb", "aaa", "aba"];
  for (const ask of patterns)
    for (const grant of patterns) {
      const rules: PermissionRuleset = [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: ask, effect: "ask" },
        { action: "read", resource: "ab", effect: "deny" },
      ];
      const witness = values.some(
        (value) =>
          v2PermissionEffect(
            [{ action: "read", resource: grant, effect: "allow" }],
            "read",
            value,
          ) === "allow" && v2PermissionEffect(rules, "read", value) === "ask",
      );
      if (witness)
        expect(v2SavedGrantMayBypassAsk(rules, { action: "read", resource: grant })).toBe(true);
    }
});

it("shared Full access starts, sends and reconnects with an existing read grant, but switching to approval-required blocks without deleting it", async () => {
  await withV2RuntimeFixture(async ({ runtime: base, http, directory }) => {
    const grant = {
      id: "saved-read",
      projectID: "synthetic",
      action: "read",
      resource: "*",
      time: { created: 1, updated: 1 },
    };
    vi.spyOn(http.client.permission.saved, "list").mockResolvedValue([grant]);
    const remove = vi.spyOn(http.client.permission.saved, "remove");
    const runtime = new OpencodeV2Runtime({
      ...sharedV2FixtureOptions(base, http),
      enableLocalTools: true,
    });
    const start = {
      threadId: ThreadId.makeUnsafe("saved-read-full"),
      cwd: directory,
      runtimeMode: "full-access" as const,
      modelSelection: {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    };
    try {
      await runtime.start(start);
      const owner = runtime.get(start.threadId);
      await runtime.send({
        threadId: start.threadId,
        requestMessageId: MessageId.makeUnsafe("one"),
        input: "offline prompt",
      });
      await expect.poll(() => owner.terminalDelivered).toBe(true);
      const cursor = v2ResumeCursor(owner);
      await runtime.stop(start.threadId);
      await runtime.start({ ...start, resumeCursor: cursor });
      expect(runtime.get(start.threadId).native.id).toBe(owner.native.id);
      await runtime.stop(start.threadId);
      const error = await runtime
        .start({ ...start, runtimeMode: "approval-required", resumeCursor: cursor })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(V2SavedPermissionConflict);
      expect(v2ExecutionFailureClass(error, v2ExecutionIssue(error))).toBe("invalid-request");
      expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
      expect(remove).not.toHaveBeenCalled();
      expect(grant.resource).toBe("*");
    } finally {
      await runtime.close();
    }
  });
});
