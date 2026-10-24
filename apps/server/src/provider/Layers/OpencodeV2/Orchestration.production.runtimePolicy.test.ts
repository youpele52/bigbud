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

it.each(["plugin-removal", "tool-deny"] as const)(
  "bound eligibility rejects selected scoped %s",
  async (kind) => {
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
                : {
                    permissions: [
                      {
                        action: selected.tool("list_threads"),
                        resource: "*",
                        effect: "deny" as const,
                      },
                    ],
                  },
          },
        ];
        await expect(f.runtimeProof()).rejects.toMatchObject({
          reasonCode: "config-source-unverified",
        });
      },
      "full-access",
      "2.0.29",
    );
  },
);

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
