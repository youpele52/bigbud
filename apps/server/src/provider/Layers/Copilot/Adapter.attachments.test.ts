import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import type { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { writeProviderAttachmentFixtures } from "../../../attachments/providerAttachments.test.helpers.ts";
import { CopilotAdapter } from "../../Services/Copilot/Adapter.ts";
import { makeCopilotAdapterLive } from "./Adapter.ts";
import {
  getThreadOrchestrationToolDispatcher,
  setThreadOrchestrationToolDispatcher,
} from "../../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";

it.effect(
  "delivers documents once with native image/PDF blobs and rejects invalid snapshots before model mutation or send",
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "copilot-shared-attachments-"));
    const send = vi.fn<CopilotSession["send"]>().mockResolvedValue("message");
    const setModel = vi.fn().mockResolvedValue(undefined);
    const session = {
      sessionId: "fixture",
      on: () => () => {},
      send,
      setModel,
      disconnect: async () => {},
    };
    const layer = makeCopilotAdapterLive({
      clientFactory: () =>
        ({ createSession: async () => session, stop: async () => {} }) as unknown as CopilotClient,
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "copilot-attachments-" })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const previous = getThreadOrchestrationToolDispatcher();
      const unused = () =>
        Effect.die(new Error("Orchestration tools must not execute in attachment fixture"));
      setThreadOrchestrationToolDispatcher({
        rename: unused,
        archive: unused,
        getStatus: unused,
        listPinned: unused,
        setPinned: unused,
        computerUse: unused,
        browser: unused,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => setThreadOrchestrationToolDispatcher(previous)),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => rmSync(root, { recursive: true, force: true })),
      );
      const adapter = yield* CopilotAdapter;
      const config = yield* ServerConfig;
      const fixture = writeProviderAttachmentFixtures(config.attachmentsDir);
      const threadId = ThreadId.makeUnsafe("attachment-turn");
      yield* adapter.startSession({
        threadId,
        provider: "copilot",
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "read",
        attachments: [fixture.document, fixture.image, fixture.pdf],
      });
      const payload = send.mock.calls[0]![0];
      expect(payload.prompt).toContain(fixture.text);
      expect(payload.prompt.match(/<attached_file_contents>/g)).toHaveLength(1);
      expect(payload.prompt).not.toContain(fixture.document.sourcePath);
      expect(payload.attachments).toEqual([
        {
          type: "blob",
          data: fixture.imageBytes.toString("base64"),
          mimeType: "image/png",
          displayName: fixture.image.name,
        },
        {
          type: "blob",
          data: fixture.pdfBytes.toString("base64"),
          mimeType: "application/pdf",
          displayName: fixture.pdf.name,
        },
      ]);
      const result = yield* adapter
        .sendTurn({
          threadId,
          modelSelection: { provider: "copilot", model: "changed" },
          attachments: [{ ...fixture.document, sizeBytes: 1 }],
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(setModel).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer));
  },
);
