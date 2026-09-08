import * as FS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

interface TurboConfig {
  readonly globalEnv?: ReadonlyArray<string>;
}

const config = JSON.parse(
  FS.readFileSync(new URL("../turbo.json", import.meta.url), "utf8"),
) as TurboConfig;

describe("turbo runtime environment", () => {
  it("forwards remote-agent settings through strict-mode tasks", () => {
    const globalEnv = new Set(config.globalEnv ?? []);
    for (const variable of [
      "BIGBUD_REMOTE_AGENT_TRANSPORT",
      "BIGBUD_REMOTE_AGENT_BINARY",
      "BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH",
      "BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL",
      "BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY",
      "BIGBUD_REMOTE_AGENT_RELEASE_VERSION",
    ]) {
      assert.ok(globalEnv.has(variable), `${variable} must be included in turbo.globalEnv`);
    }
  });
});
