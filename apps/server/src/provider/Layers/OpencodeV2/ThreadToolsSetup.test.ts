import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadToolsSetup } from "./ThreadToolsSetup.ts";
import { ThreadToolsActivationLive } from "./ThreadToolsActivation.ts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { v2RetainedHistoryIssue } from "./ThreadToolsSetup.history.ts";

const native = vi.hoisted(() => ({
  borrow: vi.fn(() => {
    throw new Error(
      "Native discovery must not be called when showing setup without acknowledgement.",
    );
  }),
}));
vi.mock("./SharedService.connection.ts", () => ({ borrowV2SharedService: native.borrow }));

it("shows inferred setup context without native activation, installation, credentials or enrollment", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const setup = yield* makeV2ThreadToolsSetup().pipe(
            Effect.provide(ThreadToolsActivationLive),
          );
          const result = yield* setup.get({ refresh: false });
          expect(result).toMatchObject({
            status: "required",
            artifactDirectoryUri: app.artifact.pluginUri,
            configAddition: { plugins: [app.artifact.pluginUri] },
          });
          expect(result.artifactDirectoryUri).not.toContain("index.mjs");
          expect(result.message).toContain("Opening settings does not install anything");
          expect(result.directory).toBe(app.root);
          const oldTrust = yield* setup.get({ refresh: true });
          expect(oldTrust.message).toContain("Previous host-user acknowledgement");
          expect(JSON.stringify(result)).not.toMatch(
            /PRIVATE KEY|callbackToken|callbackUrl|127\.0\.0\.1|Bearer/,
          );
          expect(native.borrow).not.toHaveBeenCalled();
        }),
      ).pipe(
        Effect.provideService(ServerConfig, { stateDir: app.root } as typeof ServerConfig.Service),
        Effect.provide(
          ServerSettingsService.layerTest({ ...DEFAULT_SERVER_SETTINGS, defaultChatCwd: app.root }),
        ),
      ),
    );
  } finally {
    await app.close();
  }
});

it("classifies isolated and unknown retained histories locally without migration, while verified shared history remains compatible", () => {
  const cursor = {
    provider: "opencodeV2",
    nativeSessionId: "original",
    storageIdentity: "original-storage",
    directory: "/workspace",
  };
  expect(
    v2RetainedHistoryIssue({
      cursor: { ...cursor, connectionMode: "isolated" },
      hasAdmission: false,
      directory: "/workspace",
    }),
  ).toContain("read-only");
  expect(v2RetainedHistoryIssue({ cursor, hasAdmission: true, directory: "/workspace" })).toContain(
    "unproved",
  );
  expect(
    v2RetainedHistoryIssue({
      cursor: { invalid: true },
      hasAdmission: false,
      directory: "/workspace",
    }),
  ).toContain("unsupported");
  expect(
    v2RetainedHistoryIssue({
      cursor,
      hasAdmission: true,
      directory: "/workspace",
      binding: { state: "verified", directory: "/workspace" } as never,
    }),
  ).toBeUndefined();
  expect(v2RetainedHistoryIssue({ hasAdmission: false, directory: "/workspace" })).toBeUndefined();
});

it("keeps retained shared Chats history read-only when Default chat folder changes, without rebinding", () => {
  const cursor = {
    provider: "opencodeV2",
    nativeSessionId: "original",
    storageIdentity: "original-storage",
    directory: "/old-default",
    connectionMode: "shared",
  };
  const original = structuredClone(cursor);
  expect(
    v2RetainedHistoryIssue({ cursor, hasAdmission: true, directory: "/new-default" }),
  ).toContain("another native Location");
  expect(
    v2RetainedHistoryIssue({ cursor, hasAdmission: true, directory: "/old-default" }),
  ).toBeUndefined();
  expect(cursor).toEqual(original);
});
