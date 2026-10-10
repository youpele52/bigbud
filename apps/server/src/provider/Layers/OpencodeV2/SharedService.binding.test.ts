import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";

it("rejects storage-mode changes for a retained admission even when the caller omits its cursor", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory, http }) => {
    const input = {
      threadId: ThreadId.makeUnsafe("legacy-private"),
      cwd: directory,
      runtimeMode: "approval-required" as const,
      modelSelection: {
        provider: "opencodeV2" as const,
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    };
    await runtime.start(input);
    await runtime.send({
      ...input,
      requestMessageId: MessageId.makeUnsafe("original"),
      input: "preserve original history",
    });
    await expect.poll(() => runtime.get(input.threadId).terminalDelivered).toBe(true);
    const calls = http.calls.length;
    const shared = new OpencodeV2Runtime({
      ...runtime.options,
      config: {
        ...runtime.options.config,
        sharedService: {
          registrationFile: "/registered/service.json",
          databasePath: runtime.options.config.profileRoot,
          storageIdentity: "different-shared-db",
          generation: "native-generation",
          binaryPath: "/native/opencode",
        },
      },
    });
    await expect(shared.start(input)).rejects.toThrow("retained admission belongs to another");
    expect(http.calls).toHaveLength(calls);
    await shared.close();
  });
});
