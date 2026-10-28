import path from "node:path";
import { writeFile } from "node:fs/promises";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it, vi } from "vitest";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { V2_NATIVE_RELEASE_QUALIFICATIONS } from "./NativeCompatibility.qualification.registry.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

// Runtime-checked policy is proven on a mocked empty registry, independent of promotion.
vi.mock("./NativeCompatibility.qualification.registry.ts", () => ({
  V2_NATIVE_RELEASE_QUALIFICATIONS: [],
  V2_NATIVE_RELEASE_INCOMPATIBILITIES: [],
}));
import { v2NativeProofMetadata, v2NativeReadyNotice } from "./NativeCompatibility.status.ts";

it.each([
  "plugin-removal",
  "tool-deny",
  "policy-deny",
  "policy-unsupported",
  "policy-cross-delimiter",
] as const)("bound eligibility rejects selected scoped %s", async (kind) => {
  await withV2ProductionThreadTools(
    async (f) => {
      const selected = v2ThreadRegistration(f.artifact),
        original = f.http.client.config.get;
      f.http.client.config.get = async (...args) => [
        ...(await original(...args)),
        {
          type: "document" as const,
          info:
            kind === "plugin-removal"
              ? { plugins: [`-${selected.id}`] }
              : kind === "tool-deny"
                ? {
                    permissions: [
                      {
                        action: selected.tool("list_threads"),
                        resource: "*",
                        effect: "deny" as const,
                      },
                    ],
                  }
                : {
                    policies: [
                      {
                        action: "tool.use" as const,
                        resource:
                          kind === "policy-cross-delimiter"
                            ? "*private:*"
                            : `${selected.tool("list_threads")}:${kind === "policy-deny" ? "*" : "private"}`,
                        effect: "deny" as const,
                      },
                    ],
                  },
        },
      ];
      const before = f.http.calls.length;
      await expect(f.runtimeProof()).rejects.toMatchObject({
        reasonCode: "config-source-unverified",
      });
      await expect(
        f.runtime.start({
          threadId: ThreadId.makeUnsafe(`denied-${kind}`),
          cwd: f.source.native.location.directory,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
        }),
      ).rejects.toThrow();
      expect(f.http.calls.slice(before).filter((call) => call.method !== "GET")).toEqual([]);
    },
    "full-access",
    "2.0.29",
  );
});

it.each(["2.0.28", "2.0.29", "2.9.123"])(
  "empty qualification registry permits runtime-verified %s canonical HTTP/SQLite flow with warning",
  async (version) => {
    expect(V2_NATIVE_RELEASE_QUALIFICATIONS).toHaveLength(0);
    await withV2ProductionThreadTools(
      async (f) => {
        const proof = await f.runtimeProof();
        expect(proof.evidenceKind).toBe("runtime-checked");
        expect(proof).not.toHaveProperty("qualificationRecordId");
        expect(v2NativeProofMetadata(proof).qualificationState).toBe("unqualified");
        // Missing release evidence is not a user action: runtime-checked readiness is success.
        expect(v2NativeReadyNotice("Verified")).toEqual({
          severity: "success",
          message: "Verified",
        });
        const created = (await f.invoke(
          "create_thread",
          {
            title: "Runtime checked child",
            task: "Owned synthetic canonical task",
            watchForCompletion: false,
          },
          "runtime-create",
        )) as { ok: boolean; result: { childThreadId: string } };
        expect(created.ok).toBe(true);
        const target = ThreadId.makeUnsafe(created.result.childThreadId);
        expect(
          await f.invoke(
            "send_thread_message",
            { threadId: target, message: "runtime checked send" },
            "runtime-send",
          ),
        ).toMatchObject({ ok: true });
        expect(await f.invoke("get_thread_status", { threadId: target })).toMatchObject({
          ok: true,
        });
        expect(await f.invoke("list_threads", {})).toMatchObject({ ok: true });
        expect(
          await f.invoke("rename_thread", {
            targetThreadId: target,
            title: "Runtime checked renamed",
          }),
        ).toMatchObject({ ok: true, title: "Runtime checked renamed" });
        const before = (await f.canonical.run(f.canonical.engine.getReadModel())).snapshotSequence;
        await f.invoke(
          "send_thread_message",
          { threadId: target, message: "runtime checked send" },
          "runtime-send",
        );
        expect((await f.canonical.run(f.canonical.engine.getReadModel())).snapshotSequence).toBe(
          before,
        );
        await expect(
          f.invoke("send_thread_message", { threadId: target, message: "changed" }, "runtime-send"),
        ).rejects.toThrow();
      },
      "full-access",
      version,
    );
  },
);

it.each(["empty-top", "allow-top", "empty-legacy", "allow-legacy"] as const)(
  "runtime rejects stale %s projection versus raw deny before session mutations",
  async (kind) => {
    await withV2ProductionThreadTools(
      async (f) => {
        const original = await f.http.client.config.get({
          location: { directory: f.source.native.location.directory },
        });
        const global = original.find((entry) => entry.type === "directory")!;
        const filename = path.join(global.path!, "opencode.json");
        const allow = { action: "tool.use" as const, resource: "*", effect: "allow" as const };
        const deny = { ...allow, effect: "deny" as const };
        const policies = kind.startsWith("empty") ? [] : [allow];
        f.http.client.config.get = async () => [
          { type: "document", path: filename, info: { policies } },
          ...original,
        ];
        await writeFile(
          filename,
          JSON.stringify(
            kind.endsWith("legacy") ? { experimental: { policies: [deny] } } : { policies: [deny] },
          ),
          { mode: 0o600 },
        );
        const before = f.http.calls.length;
        await expect(f.runtimeProof()).rejects.toMatchObject({
          reasonCode: "config-source-unverified",
          diagnostic: { code: "policy-unsupported" },
        });
        await expect(
          f.runtime.start({
            threadId: ThreadId.makeUnsafe(`stale-${kind}`),
            cwd: f.source.native.location.directory,
            runtimeMode: "full-access",
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "synthetic-provider",
              model: "synthetic-model",
            },
          }),
        ).rejects.toThrow();
        expect(f.http.calls.slice(before).filter((call) => call.method !== "GET")).toEqual([]);
      },
      "full-access",
      "2.2.0",
    );
  },
);
