import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";
import { writeProviderAttachmentFixtures } from "../../../attachments/providerAttachments.test.helpers.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import {
  OpencodeServerManager,
  type OpencodeServerManagerShape,
} from "../../Services/Opencode/ServerManager.ts";
import { KilocodeAdapter } from "../../Services/Kilocode/Adapter.ts";
import { makeMockOpencodeClient } from "../Opencode/Adapter.session.test.helpers.ts";
import { makeKilocodeAdapterLive } from "./Adapter.ts";

it.effect(
  "delegates document and native visual delivery through shared OpenCode preparation",
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kilo-shared-attachments-"));
    let sent = false;
    let resolvePrompt!: () => void;
    const prompted = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    const promptAsync = vi.fn(
      async (input: { parts: { type: string; text?: string; mime?: string; url?: string }[] }) => {
        void input;
        sent = true;
        resolvePrompt();
        return { data: {}, error: undefined };
      },
    );
    const client = Object.assign(makeMockOpencodeClient() as object, {
      session: {
        create: async () => ({ data: { id: "kilo-session" }, error: undefined }),
        promptAsync,
        messages: async () => ({
          data: sent
            ? [
                {
                  info: { id: "assistant", role: "assistant", time: { completed: Date.now() } },
                  parts: [],
                },
              ]
            : [],
          error: undefined,
        }),
        abort: async () => ({ data: true }),
      },
    });
    const acquire = vi.fn<OpencodeServerManagerShape["acquire"]>(async () => ({
      client: client as never,
      url: "http://fixture",
      release() {},
      invalidate() {},
    }));
    const layer = makeKilocodeAdapterLive().pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "kilo-attachments-" })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(Layer.succeed(OpencodeServerManager, { acquire })),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const adapter = yield* KilocodeAdapter;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
      const config = yield* ServerConfig;
      const fixture = writeProviderAttachmentFixtures(config.attachmentsDir);
      const threadId = ThreadId.makeUnsafe("kilo-attachments");
      yield* adapter.startSession({
        threadId,
        provider: "kilocode",
        runtimeMode: "approval-required",
      });
      expect(acquire.mock.calls[0]?.[0]).toMatchObject({ provider: "kilocode" });
      yield* adapter.sendTurn({
        threadId,
        input: "read",
        attachments: [fixture.document, fixture.image, fixture.pdf],
      });
      yield* Effect.promise(() => prompted);
      const payload = promptAsync.mock.calls[0]![0];
      expect(payload.parts[0]?.text).toContain(fixture.text);
      expect(payload.parts[0]?.text?.match(/<attached_file_contents>/g)).toHaveLength(1);
      expect(payload.parts[0]?.text).not.toContain(fixture.document.sourcePath);
      expect(payload.parts.slice(1)).toEqual([
        expect.objectContaining({
          type: "file",
          mime: "image/png",
          url: expect.stringMatching(/^file:/),
        }),
        expect.objectContaining({
          type: "file",
          mime: "application/pdf",
          url: expect.stringMatching(/^file:/),
        }),
      ]);
      const result = yield* adapter
        .sendTurn({ threadId, attachments: [{ ...fixture.document, sizeBytes: 1 }] })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(promptAsync).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer));
  },
);
