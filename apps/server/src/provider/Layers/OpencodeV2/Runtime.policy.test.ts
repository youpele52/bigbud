import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { runtimePromptFingerprint } from "./Runtime.admission.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { realpath } from "node:fs/promises";
import { v2ExecutionPolicy } from "./Runtime.policy.fingerprint.ts";

it("durable fingerprint separates deny-only, approval-required and full-access execution policy", () => {
  const model = { providerID: "synthetic", id: "model" };
  const isolated = runtimePromptFingerprint("same prompt", model, "same media");
  const approved = runtimePromptFingerprint(
    "same prompt",
    model,
    "same media",
    v2ExecutionPolicy("approval-required", true, v2LocalToolPolicy("approval-required", true)),
  );
  const full = runtimePromptFingerprint(
    "same prompt",
    model,
    "same media",
    v2ExecutionPolicy("full-access", true, v2LocalToolPolicy("full-access", true)),
  );
  expect(new Set([isolated, approved, full]).size).toBe(3); // Explicit Full access must not replay a supervised/deny-only admission.
  expect(runtimePromptFingerprint("same prompt", model, "same media", undefined)).toBe(isolated);
});

it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
  "applies explicit V2 builtin policy for %s without granting unknown MCP/plugins",
  (mode) => {
    const rules = v2LocalToolPolicy(mode, true);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rules.find((rule) => rule.action === "edit")).toBeUndefined();
    expect(rules.find((rule) => rule.action === "shell")).toBeUndefined();
    expect(rules.find((rule) => rule.action === "question")?.effect).toBe("allow");
    expect(rules.some((rule) => rule.action.includes("mcp"))).toBe(false);
    expect(v2LocalToolPolicy(mode, false)).toEqual([rules[0]]);
  },
);

it("local approvals map to once, never persist project-wide grants, and reject unsupported actions", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    Object.assign(runtime.options, { enableLocalTools: true });
    const threadId = ThreadId.makeUnsafe("local-tool-policy");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const session = runtime.get(threadId);
    expect(http.calls.find((call) => call.method === "PATCH")?.body.permissions).toEqual(
      v2LocalToolPolicy("approval-required", true, false, {
        nativeWorkspace: true,
        profileRoot: await realpath(runtime.options.config.profileRoot),
        boundedFiles: false,
      }),
    );
    vi.spyOn(http.client.permission, "get").mockResolvedValue({
      id: "per_fixture",
      sessionID: session.native.id,
      action: "webfetch",
      resources: ["printf synthetic"],
    });
    const reply = vi.spyOn(http.client.permission, "reply").mockResolvedValue(undefined);
    await runtime.respondPermission(threadId, "per_fixture", "accept");
    expect(reply.mock.calls[0]?.[0].decision).toBe("once");
    await expect(
      runtime.respondPermission(threadId, "per_fixture", "acceptForSession"),
    ).rejects.toThrow("persistent approvals");
    vi.mocked(http.client.permission.get).mockResolvedValue({
      id: "per_fixture",
      sessionID: session.native.id,
      action: "foreign_mcp",
      resources: ["*"],
    });
    await expect(runtime.respondPermission(threadId, "per_fixture", "accept")).rejects.toThrow(
      "cannot approve tools",
    );
    expect(reply).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "request.resolved")).toBe(true);
  });
});
