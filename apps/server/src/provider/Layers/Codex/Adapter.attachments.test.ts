import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { writeProviderAttachmentFixtures } from "../../../attachments/providerAttachments.test.helpers.ts";
import { CodexAdapter } from "../../Services/Codex/Adapter.ts";
import { makeCodexAdapterLive } from "./Adapter.ts";
import {
  FakeCodexManager,
  asThreadId,
  providerSessionDirectoryTestLayer,
} from "./Adapter.test.helpers.ts";

it.effect(
  "delivers managed document context once alongside native images/PDFs, failing before dispatch on changed bytes",
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "codex-shared-attachments-"));
    const manager = new FakeCodexManager();
    const layer = makeCodexAdapterLive({ manager }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "codex-attachments-" })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const adapter = yield* CodexAdapter;
      const config = yield* ServerConfig;
      const fixture = writeProviderAttachmentFixtures(config.attachmentsDir);
      const threadId = asThreadId("attachment-turn");
      yield* adapter.sendTurn({
        threadId,
        input: "read",
        attachments: [fixture.document, fixture.image, fixture.pdf],
      });
      const sent = manager.sendTurnImpl.mock.calls[0]![0];
      expect(sent.input).toContain(fixture.text);
      expect(sent.input?.match(/<attached_file_contents>/g)).toHaveLength(1);
      expect(sent.input).not.toContain(fixture.document.sourcePath);
      expect(sent.attachments).toEqual([
        { type: "image", url: `data:image/png;base64,${fixture.imageBytes.toString("base64")}` },
        { type: "file", url: `data:application/pdf;base64,${fixture.pdfBytes.toString("base64")}` },
      ]);
      const result = yield* adapter
        .sendTurn({ threadId, attachments: [{ ...fixture.document, sizeBytes: 1 }] })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(manager.sendTurnImpl).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer));
  },
);
