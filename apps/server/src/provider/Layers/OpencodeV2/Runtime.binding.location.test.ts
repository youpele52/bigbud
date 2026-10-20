import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import { resolveV2RuntimeBinding } from "./Runtime.binding.ts";

it("rejects relative native Locations before reading profile storage or resolving process cwd", async () => {
  await expect(
    resolveV2RuntimeBinding(
      { config: { runtimeTargetId: "local", profileRoot: "/nonexistent-profile" } } as never,
      {
        provider: "opencodeV2",
        threadId: ThreadId.makeUnsafe("folderless-chat"),
        runtimeMode: "full-access",
        cwd: "relative-default",
      },
    ),
  ).rejects.toThrow("absolute native Location");
});
