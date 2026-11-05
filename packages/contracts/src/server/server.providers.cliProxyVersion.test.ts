import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProvider } from "./server.providers";

const legacy = {
  provider: "cliProxy",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("optional CLIProxyAPI version metadata", () => {
  it("still decodes snapshots without metadata", () => {
    expect(Schema.decodeUnknownSync(ServerProvider)(legacy)).toEqual(legacy);
  });

  it("round trips a ready provider with an installed-only recommendation", () => {
    const snapshot = {
      ...legacy,
      cliProxyVersion: {
        recommendedVersion: "8.0.51",
        runtimeVersion: null,
        installedVersion: "8.0.30",
        installation: "homebrew",
        updateSource: "installed",
      },
    };
    expect(Schema.decodeUnknownSync(ServerProvider)(snapshot)).toEqual(snapshot);
  });
});
