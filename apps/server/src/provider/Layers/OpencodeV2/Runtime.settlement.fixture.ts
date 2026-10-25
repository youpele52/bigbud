import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { vi } from "vitest";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";

/** Real runtime, admission journal and gate; only the native transport/setup ticket are synthetic. */
export async function withV2SettlementFixture(
  run: (fixture: {
    runtime: OpencodeV2Runtime;
    owner: ReturnType<OpencodeV2Runtime["get"]>;
    gate: V2ActivationGate;
    http: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["http"];
    events: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["events"];
    setActive: (active: boolean) => void;
    send: (id: string) => ReturnType<OpencodeV2Runtime["send"]>;
  }) => Promise<void>,
) {
  await withV2RuntimeFixture(async ({ runtime: baseline, http, directory, events }) => {
    const gate = new V2ActivationGate("fixture", "digest", () => {});
    const stamp = gate.verify(directory, "digest", "setup");
    const runtime = new OpencodeV2Runtime({
      ...sharedV2FixtureOptions(baseline, http),
      activation: {
        coordinator: {} as V2ThreadToolsActivation,
        awaitReady: async () => ({ gate, stamp }),
      },
    });
    const threadId = ThreadId.makeUnsafe("settlement-thread");
    let active = false;
    const activeSpy = vi
      .spyOn(http.client.session, "active")
      .mockImplementation(async () =>
        active ? ({ [runtime.get(threadId).native.id]: {} } as never) : {},
      );
    try {
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
      const prompt = http.client.session.prompt.bind(http.client.session);
      const promptSpy = vi
        .spyOn(http.client.session, "prompt")
        .mockImplementation(async (...args) => {
          const result = await prompt(...args);
          active = true;
          return result;
        });
      try {
        await run({
          runtime,
          owner: runtime.get(threadId),
          gate,
          http,
          events,
          setActive: (value) => {
            active = value;
          },
          send: (id) =>
            runtime.send({
              threadId,
              requestMessageId: MessageId.makeUnsafe(id),
              input: "Synthetic fixture only",
            }),
        });
      } finally {
        promptSpy.mockRestore();
      }
    } finally {
      active = false;
      activeSpy.mockRestore();
      await runtime.close();
    }
  });
}
