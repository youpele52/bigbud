import { expect, it, vi } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { V2CodingBridge } from "./Coding.bridge.ts";
import { resolveV2FilePython } from "./Coding.files.ts";
import { writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const selection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;

it("missing platform file helper does not block an owned native session or silently auto-approve native edits", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, directory, http }) => {
    http.autoComplete = false;
    const coding = await V2CodingBridge.open(fixture.options.config.profileRoot);
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      codingBridge: coding,
      enableLocalTools: true,
    });
    const threadId = ThreadId.makeUnsafe("platform-no-helper");
    try {
      await runtime.start({
        threadId,
        cwd: directory,
        runtimeMode: "auto-accept-edits",
        modelSelection: selection,
      });
      const owner = runtime.get(threadId);
      expect(v2PermissionEffect(owner.toolPolicy!, "edit", "src/main.ts")).toBe("ask");
      expect(v2PermissionEffect(owner.toolPolicy!, "shell", "echo supervised")).toBe("ask");
      await runtime.send({
        threadId,
        requestMessageId: MessageId.makeUnsafe("no-helper"),
        input: "synthetic",
      });
      await expect(
        coding.invoke({
          sessionID: owner.native.id,
          messageID: "assistant",
          callID: "no-helper",
          action: "write",
          input: { path: "main.txt", content: "no unsafe fallback" },
        }),
      ).rejects.toThrow("helper is unavailable");
    } finally {
      await runtime.close();
      coding.close();
    }
  });
});
it("distinct access decisions match explicit V1 trust without broadening synthetic Locations or native auto edits", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    const policy = v2LocalToolPolicy(mode, true, true, {
      nativeWorkspace: true,
      profileRoot: "/owned/profile",
      boundedFiles: true,
    });
    expect(v2PermissionEffect(policy, "shell", "printf hello | cat")).toBe(
      mode === "full-access" ? "allow" : "ask",
    );
    expect(v2PermissionEffect(policy, "edit", "src/main.ts")).toBe(
      mode === "full-access" ? "allow" : mode === "auto-accept-edits" ? "deny" : "ask",
    );
    expect(v2PermissionEffect(policy, "external_directory", "/other/*")).toBe("ask");
    for (const resource of [
      ".opencode/config.json",
      ".agents/plugin.js",
      "/owned/profile/config/private.json",
    ])
      expect(v2PermissionEffect(policy, "edit", resource)).toBe("deny");
    for (const action of ["subagent", "unknown_mcp_tool", "execute"])
      expect(v2PermissionEffect(policy, action, "*")).toBe("deny");
    const synthetic = v2LocalToolPolicy(mode, true, true, {
      nativeWorkspace: false,
      profileRoot: "/owned/profile",
      boundedFiles: true,
    });
    for (const action of ["shell", "read", "edit", "glob", "grep", "skill", "external_directory"])
      expect(v2PermissionEffect(synthetic, action, "*")).toBe("deny");
    expect(v2LocalToolPolicy(mode, false, true)).toEqual([
      { action: "*", resource: "*", effect: "deny" },
    ]);
  }
  const windows = v2LocalToolPolicy("auto-accept-edits", true, true, {
    nativeWorkspace: true,
    profileRoot: "C:\\private\\profile",
    boundedFiles: false,
  });
  expect(v2PermissionEffect(windows, "edit", "src/main.ts", true)).toBe("ask");
  expect(v2PermissionEffect(windows, "edit", "C:\\PRIVATE\\PROFILE\\config\\token", true)).toBe(
    "deny",
  );
});

it("auto edits mutate only bounded canonical files without approval; commands still ask, unknown/oversize/protected native requests cannot be approved", async () => {
  await withV2RuntimeFixture(async ({ runtime: fixture, directory, http, events }) => {
    http.autoComplete = false;
    const profile = await realpath(fixture.options.config.profileRoot),
      root = await realpath(directory);
    const coding = await V2CodingBridge.open(profile, await resolveV2FilePython(profile));
    const runtime = new OpencodeV2Runtime({
      ...fixture.options,
      enableLocalTools: true,
      codingBridge: coding,
    });
    const threadId = ThreadId.makeUnsafe("auto-edits");
    try {
      await runtime.start({
        threadId,
        cwd: root,
        runtimeMode: "auto-accept-edits",
        modelSelection: selection,
      });
      await runtime.send({
        threadId,
        modelSelection: selection,
        requestMessageId: MessageId.makeUnsafe("auto-edits"),
        input: "synthetic",
      });
      const owner = runtime.get(threadId),
        call = {
          sessionID: owner.native.id,
          messageID: "assistant",
          callID: "bounded-write",
          action: "write",
          input: { path: "main.txt", content: "automatically bounded" },
        };
      await coding.invoke(call);
      expect(await readFile(path.join(root, "main.txt"), "utf8")).toBe("automatically bounded");
      expect(events.some((event) => event.type === "request.opened")).toBe(false);
      expect(await coding.invoke(call)).toMatchObject({ sha256: expect.any(String) });
      await writeFile(path.join(root, ".opencode"), "protected metadata");
      await expect(
        coding.invoke({
          ...call,
          callID: "protected",
          input: { path: ".opencode", content: "unsafe" },
        }),
      ).rejects.toThrow();
      const reply = vi.spyOn(http.client.permission, "reply").mockResolvedValue(undefined);
      const get = vi.spyOn(http.client.permission, "get");
      for (const request of [
        { action: "edit", resources: ["src/main.ts"] },
        { action: "shell", resources: ["x".repeat(66000)] },
        { action: "unknown_mcp_tool", resources: [] },
      ]) {
        get.mockResolvedValue({ id: "per_test", sessionID: owner.native.id, ...request });
        await expect(runtime.respondPermission(threadId, "per_test", "accept")).rejects.toThrow();
      }
      expect(reply).not.toHaveBeenCalled();
      get.mockResolvedValue({
        id: "per_test",
        sessionID: owner.native.id,
        action: "shell",
        resources: ["echo exact command"],
      });
      await runtime.respondPermission(threadId, "per_test", "accept");
      expect(reply.mock.calls[0]?.[0].decision).toBe("once");
    } finally {
      await runtime.close();
      coding.close();
    }
  });
});
