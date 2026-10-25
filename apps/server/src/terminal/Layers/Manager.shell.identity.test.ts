import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { version } from "../../../package.json" with { type: "json" };
import { withInteractiveTerminalIdentity } from "./Manager.shell.identity";
import { createManager, openInput } from "./Manager.test.helpers";

describe("withInteractiveTerminalIdentity", () => {
  it("advertises truecolor xterm and replaces an inherited parent terminal identity", () => {
    const env = withInteractiveTerminalIdentity({
      PATH: "/usr/bin",
      TERM: "dumb",
      TERM_PROGRAM: "iTerm.app",
      TERM_PROGRAM_VERSION: "3.5",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "bigbud",
      TERM_PROGRAM_VERSION: version,
    });
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("TerminalManager identity", (it) => {
  it.effect("spawns interactive terminals with the identity and project env", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ env: { PROJECT_ROOT: "/repo" } }));
      const env = ptyAdapter.spawnInputs[0]?.env;
      expect(env?.COLORTERM).toBe("truecolor");
      expect(env?.TERM_PROGRAM).toBe("bigbud");
      expect(env?.PROJECT_ROOT).toBe("/repo");
    }),
  );
});
