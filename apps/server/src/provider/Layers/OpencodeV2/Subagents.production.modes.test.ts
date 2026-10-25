import { expect, it } from "vitest";
import { withV2NativeGuardProduction } from "./Subagents.production.fixture.ts";
import { makeV2NativeFamilyPreparation } from "./Subagents.application.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { realpath } from "node:fs/promises";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { V2_NATIVE_FAMILY_QUALIFICATIONS } from "./Subagents.qualification.ts";

it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
  "production guard clamps parent %s without weakening child policy",
  async (mode) => {
    await withV2NativeGuardProduction(async ({ send, launch, permission }) => {
      await send(`mode-${mode}`);
      const child = await launch();
      expect(await permission(child, "read", ["private"])).toBe("deny");
      expect(await permission(child, "shell", ["ask-child"])).toBe("ask");
      expect(await permission(child, "read", ["ordinary"])).toBe(
        mode === "full-access" ? "allow" : "ask",
      );
    }, mode);
  },
);

it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
  "default production factory keeps %s subagents denied without release-owned qualification",
  async (mode) => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      const state = await realpath(runtime.options.config.profileRoot);
      const factory = makeV2NativeFamilyPreparation(state);
      Object.assign(runtime.options, {
        enableLocalTools: true,
        nativeSubagents: { stateDirectory: state, prepare: factory.prepare },
      });
      try {
        const id = ThreadId.makeUnsafe(`unqualified-${mode}`);
        await runtime.start({
          threadId: id,
          cwd: directory,
          runtimeMode: mode,
          modelSelection: {
            provider: "opencodeV2",
            subProviderID: "synthetic-provider",
            model: "synthetic-model",
          },
        });
        const owner = runtime.get(id);
        expect(owner.familyControl).toBeUndefined();
        expect(owner.detachSubagentGuard).toBeUndefined();
        expect(v2PermissionEffect(owner.toolPolicy!, "subagent", "explore")).toBe("deny");
        await runtime.stop(id);
        expect(V2_NATIVE_FAMILY_QUALIFICATIONS).toHaveLength(0);
      } finally {
        await factory.close();
      }
    });
  },
);
