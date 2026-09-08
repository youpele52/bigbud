import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProviderModel } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const discovery = vi.hoisted(() => ({
  discoverCursorModelsViaAcp: vi.fn(),
}));

vi.mock("./Provider.discovery.ts", () => discovery);

import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { checkCursorProviderStatus } from "./Provider.ts";

const temporaryFiles: string[] = [];

afterEach(() => {
  for (const file of temporaryFiles.splice(0)) {
    fs.rmSync(file, { force: true, recursive: true });
  }
  discovery.discoverCursorModelsViaAcp.mockReset();
});

describe("checkCursorProviderStatus", () => {
  it("continues to ACP discovery after a successful about probe regardless of version text", async () => {
    const binaryPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cursor-status-")),
      "agent",
    );
    temporaryFiles.push(binaryPath);
    fs.writeFileSync(
      binaryPath,
      [
        "#!/bin/sh",
        'printf \'%s\' \'{"cliVersion":"2025.01.01","userEmail":"user@example.test"}\'',
        "",
      ].join("\n"),
    );
    fs.chmodSync(binaryPath, 0o755);
    const discoveredModels: ServerProviderModel[] = [
      {
        slug: "cursor-fast",
        name: "Cursor Fast",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ];
    discovery.discoverCursorModelsViaAcp.mockReturnValue(Effect.succeed(discoveredModels));

    const status = await Effect.runPromise(
      checkCursorProviderStatus().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettingsService.layerTest({
              providers: { cursor: { enabled: true, binaryPath } },
            }),
          ),
        ),
      ),
    );

    expect(status.status).toBe("ready");
    expect(status.models.map((model) => model.slug)).toEqual(["cursor-fast"]);
    expect(discovery.discoverCursorModelsViaAcp).toHaveBeenCalledTimes(1);
  });

  it("skips ACP discovery for an explicitly unauthenticated about probe", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-cursor-status-"));
    const binaryPath = path.join(directory, "agent");
    temporaryFiles.push(directory);
    fs.writeFileSync(
      binaryPath,
      ["#!/bin/sh", 'printf \'%s\' \'{"cliVersion":"2025.01.01","userEmail":null}\'', ""].join(
        "\n",
      ),
    );
    fs.chmodSync(binaryPath, 0o755);

    const status = await Effect.runPromise(
      checkCursorProviderStatus().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettingsService.layerTest({
              providers: { cursor: { enabled: true, binaryPath } },
            }),
          ),
        ),
      ),
    );

    expect(status.auth.status).toBe("unauthenticated");
    expect(discovery.discoverCursorModelsViaAcp).not.toHaveBeenCalled();
  });
});
